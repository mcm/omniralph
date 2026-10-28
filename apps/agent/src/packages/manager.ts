/**
 * Installs, updates and removes installables in the agent's npm prefix, one
 * at a time, for the agent page and Fleet's `install` RPC alike. Installs are
 * remote code execution on the host: the allow-list in force
 * (`settings.json`'s `installables.allow`) is checked for each one before npm
 * runs, whoever asked. A package without a valid `omniralph` manifest is
 * removed again (or the version installed before is restored) and the
 * install fails. Every install and removal is recorded in the `InstallHistory`
 * with npm's output.
 */
import { installableAllowed, type InstallResult } from "@omniralph/shared";
import {
  ensureInstallablesPrefix,
  listInstalledInPrefix,
  readInstalledPackage,
  type InstallableInstaller,
  type InstalledInstallable,
} from "../installables.js";
import type { Logger } from "../logger.js";
import type { InstallHistory, InstallSource, InstallSummary } from "./history.js";

export interface PackageManagerOptions {
  /** The installables allow-list in force, read for each install. */
  allowList: () => readonly string[];
  /** The installables npm prefix (`installablesPrefix(dataDir)`). */
  prefix: string;
  installer: InstallableInstaller;
  history: InstallHistory;
  logger: Logger;
}

function notAllowedMessage(name: string): string {
  return `${name} isn't allowed on this agent (its allow-list in settings.json doesn't match it)`;
}

/** The package isn't allowed by this agent's allow-list (nothing ran). */
export class PackageNotAllowedError extends Error {
  constructor(
    readonly packageName: string,
    /** The failed history entry recording the refusal. */
    readonly record: InstallSummary,
  ) {
    super(notAllowedMessage(packageName));
    this.name = "PackageNotAllowedError";
  }
}

/** A removal of a package that isn't installed (nothing ran). */
export class PackageNotInstalledError extends Error {
  constructor(readonly packageName: string) {
    super(`${packageName} isn't installed`);
    this.name = "PackageNotInstalledError";
  }
}

/** The output npm printed for a failure, when it says. */
function errorOutput(error: unknown): string | undefined {
  const output = (error as { output?: unknown } | null)?.output;
  return typeof output === "string" ? output : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface PackageRequest<T> {
  /** The history entry, recorded before it runs (queued). */
  record: InstallSummary;
  /** Settles when it finished (its history entry is final by then). */
  done: Promise<T>;
}

export class PackageManager {
  /** The last queued install or removal; the next one runs after it. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: PackageManagerOptions) {}

  /** The installed installables, sorted by name. */
  installed(): Promise<InstalledInstallable[]> {
    return listInstalledInPrefix(this.options.prefix, this.options.logger);
  }

  /**
   * Queues installing (or updating) `name` at `version` (default `latest`).
   * Throws `PackageNotAllowedError` (recorded as a failed install) when the
   * allow-list doesn't match it.
   */
  install(request: {
    name: string;
    version?: string;
    from: InstallSource;
    signal?: AbortSignal;
    logger?: Logger;
  }): PackageRequest<InstallResult> {
    const { name, from } = request;
    const version = request.version ?? "latest";
    const log = (request.logger ?? this.options.logger).child({ installable: name, from });
    const { history } = this.options;
    if (!installableAllowed(this.options.allowList(), name)) {
      log.warn("refused to install a package not allowed here");
      const started = history.start({
        action: "install",
        name,
        version,
        previousVersion: null,
        from,
      });
      const record = history.finish(started.id, {
        outcome: "failed",
        error: notAllowedMessage(name),
      });
      throw new PackageNotAllowedError(name, record ?? started);
    }
    const record = history.start({ action: "install", name, version, previousVersion: null, from });
    const done = this.enqueue(async () => {
      const output: string[] = [];
      let previous: string | null = null;
      try {
        request.signal?.throwIfAborted();
        await ensureInstallablesPrefix(this.options.prefix);
        previous = await this.installedVersion(name);
        const result = await this.runInstall(name, version, previous, output, log, request.signal);
        history.finish(record.id, {
          outcome: "installed",
          installedVersion: result.version,
          previousVersion: previous,
          output: output.join("\n"),
        });
        return result;
      } catch (error) {
        const failedOutput = errorOutput(error);
        if (failedOutput) output.push(failedOutput);
        history.finish(record.id, {
          outcome: "failed",
          previousVersion: previous,
          error: errorMessage(error),
          output: output.join("\n"),
        });
        throw error;
      }
    });
    return { record, done };
  }

  /**
   * Queues removing `name` with npm's `uninstall`. Throws
   * `PackageNotInstalledError` when it isn't installed.
   */
  async remove(request: { name: string; from: InstallSource }): Promise<PackageRequest<void>> {
    const { name, from } = request;
    const log = this.options.logger.child({ installable: name, from });
    const previous = await this.installedVersion(name);
    if (previous === null) throw new PackageNotInstalledError(name);
    const { history, installer, prefix } = this.options;
    const record = history.start({
      action: "remove",
      name,
      version: null,
      previousVersion: previous,
      from,
    });
    const done = this.enqueue(async () => {
      try {
        log.info({ previous }, "removing an installable");
        const output = await installer.uninstall(name, prefix);
        log.info("removed an installable");
        history.finish(record.id, { outcome: "removed", output: output || "" });
      } catch (error) {
        log.warn({ err: error }, "removing an installable failed");
        history.finish(record.id, {
          outcome: "failed",
          error: errorMessage(error),
          output: errorOutput(error) ?? "",
        });
        throw error;
      }
    });
    return { record, done };
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The installed (valid) version of `name`, or null. */
  private async installedVersion(name: string): Promise<string | null> {
    const installed = await readInstalledPackage(this.options.prefix, name);
    return installed?.ok ? installed.installable.version : null;
  }

  private async runInstall(
    name: string,
    version: string,
    previous: string | null,
    output: string[],
    log: Logger,
    signal: AbortSignal | undefined,
  ): Promise<InstallResult> {
    const { prefix, installer } = this.options;
    log.info({ version, previous }, "installing an installable");
    // A failure's output is kept by `install`'s catch.
    const printed = await installer.install(name, version, prefix, { signal });
    if (printed) output.push(printed);

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
      const printed = previous
        ? await installer.install(name, previous, prefix, { signal })
        : await installer.uninstall(name, prefix, { signal });
      if (printed) output.push(printed);
    } catch (error) {
      log.error({ err: error }, "removing the invalid package failed");
      const printed = errorOutput(error);
      if (printed) output.push(printed);
    }
    throw new Error(`${name}@${version} isn't a valid installable: ${problem}`.slice(0, 4000));
  }
}
