import { INSTALL_JOB_TYPE, InstallPayload, type InstallResult } from "@omniralph/shared";
import { installableAllowed, type HarnessConfig } from "../config.js";
import {
  ensureInstallablesPrefix,
  readInstalledPackage,
  type InstallableInstaller,
} from "../installables.js";
import type { SystemRpc } from "./index.js";

export interface InstallRpcOptions {
  /** The local config: its `installables.allow` decides which packages may be installed. */
  config: HarnessConfig;
  /** The installables npm prefix (`installablesPrefix(dataDir)`). */
  prefix: string;
  installer: InstallableInstaller;
}

/**
 * `install` (targeted at one harness by an admin) installs or updates an
 * installable in the harness's installables prefix. It is remote code
 * execution on the host, so the local `installables.allow` is checked here,
 * before npm runs, whatever the control panel allowed. A package without a
 * valid `omniralph` manifest is removed again (or the version installed
 * before is restored) and the job fails. Installs run one at a time.
 */
export function installRpc(options: InstallRpcOptions): SystemRpc {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    name: INSTALL_JOB_TYPE,
    run(job, ctx) {
      const payload = InstallPayload.safeParse(job.payload);
      if (!payload.success) return Promise.reject(new Error("invalid install payload"));
      const { name, version = "latest" } = payload.data;
      if (!installableAllowed(options.config, name)) {
        ctx.logger.warn({ installable: name }, "refused to install a package not allowed here");
        return Promise.reject(
          new Error(
            `${name} isn't allowed on this harness (its local config's installables.allow doesn't match it)`,
          ),
        );
      }
      const run = queue.then(() => install(name, version, options, ctx));
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

async function install(
  name: string,
  version: string,
  { prefix, installer }: InstallRpcOptions,
  ctx: Parameters<SystemRpc["run"]>[1],
): Promise<InstallResult> {
  ctx.signal.throwIfAborted();
  const log = ctx.logger.child({ installable: name });
  await ensureInstallablesPrefix(prefix);
  const before = await readInstalledPackage(prefix, name);
  const previous = before?.ok ? before.installable.version : null;

  log.info({ version, previous }, "installing an installable");
  await installer.install(name, version, prefix, { signal: ctx.signal });

  const after = await readInstalledPackage(prefix, name);
  if (after?.ok && after.installable.name === name) {
    const installed = after.installable.version;
    log.info({ version: installed, previous }, "installed an installable");
    const { manifest } = after.installable;
    return {
      name,
      version: installed,
      changed: installed !== previous,
      commands: manifest.commands.map((command) => command.name),
      mcpServers: manifest.mcpServers.map((server) => server.name),
      skills: manifest.skills.length,
    };
  }

  const problem = !after
    ? "npm didn't install it"
    : after.ok
      ? `its package.json names ${after.installable.name}`
      : after.error.message;
  log.warn({ version, problem }, "not an installable; removing it again");
  try {
    if (previous) await installer.install(name, previous, prefix, { signal: ctx.signal });
    else await installer.uninstall(name, prefix, { signal: ctx.signal });
  } catch (error) {
    log.error({ err: error }, "removing the invalid package failed");
  }
  throw new Error(`${name}@${version} isn't a valid installable: ${problem}`.slice(0, 4000));
}
