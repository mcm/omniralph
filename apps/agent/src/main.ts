import { stat } from "node:fs/promises";
import { hostname, homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  ApiError,
  HttpControlPanelApi,
  enroll,
  exchangeRefreshToken,
  type FetchFn,
} from "./api.js";
import { AttemptHistory, attemptsPath } from "./attempts/history.js";
import { ReenrollmentRequiredError, TokenManager } from "./auth.js";
import { CapabilityRegistry, defaultCapabilities, type Capability } from "./capabilities/index.js";
import {
  ConfigError,
  DEFAULT_UI_PORT,
  type AgentConfig,
  dataDir,
  defaultConfigPath,
  defaultWorkspaceRoot,
  readConfig,
  validateServerUrl,
  writeConfig,
} from "./config.js";
import { AgentDaemon } from "./daemon.js";
import { readCredentialRequest, runGitCredential } from "./credential-helper.js";
import { startHealthServer } from "./healthz.js";
import {
  missingConfigHint,
  runImport,
  type ImportFs,
  type Pm2Runner,
  type ProcessLister,
} from "./import.js";
import {
  installablesPrefix,
  npmInstallableInstaller,
  type InstallableInstaller,
} from "./installables.js";
import { createLogger, type Logger } from "./logger.js";
import type { LogRing } from "./logs/ring.js";
import { ClaudeStatusReporter, sdkReadClaude, type ReadClaude } from "./claude-status.js";
import { InstallHistory, installsPath } from "./packages/history.js";
import { PackageManager } from "./packages/manager.js";
import { SystemRpcRegistry, defaultSystemRpcs } from "./rpc/index.js";
import { LocalSettingsStore, localSettingsPath, type SettingsFs } from "./settings.js";
import { AgentStorage } from "./storage.js";
import { UiEventHub } from "./ui/events.js";
import { heartbeatPublisher, publishLocalChanges } from "./ui/publish.js";
import {
  openInBrowser,
  pingUiLink,
  processAlive,
  readUiLink,
  removeUiLink,
  uiLinkPath,
  uiPageUrl,
  writeUiLink,
} from "./ui/link.js";
import { startUiServer, type UiRoute, type UiServer } from "./ui/server.js";
import { packageRoutes } from "./ui/package-routes.js";
import { settingsRoutes } from "./ui/settings-routes.js";
import { updateRoutes } from "./ui/update-routes.js";
import { agentUiState } from "./ui/state.js";
import {
  SelfUpdater,
  npmInstaller,
  runningUnderPm2,
  updateRequestPath,
  updateStatePath,
  writeUpdateRequest,
  type Installer,
} from "./update.js";
import { AGENT_VERSION } from "./version.js";
import { createWakeSubscription } from "./wake.js";
import { defaultCredentialHelper } from "./workspace/git.js";
import { RepoCache } from "./workspace/repoCache.js";

export const USAGE = `Usage: omniralph-agent <command> [options]

Commands:
  enroll          Enroll this host with the control panel
                    --server <url>          Control panel URL (https://; http://localhost for development)
                    --token <token>         One-time enrollment token from the Agents page
                    --name <name>           Agent name (default: the hostname)
                    --workspace-root <dir>  Repo cache directory (default: ~/.omniralph/repos)
  start           Run the agent daemon (and its page on 127.0.0.1, see ui)
                    --healthz-port <port>   Serve GET /healthz on 127.0.0.1:<port>
  ui              Print the link to the running agent's page (only this machine can open it)
                    --open                  Also open it in the default browser
  import          Bring over an @omniralph/harness install's config, as the same agent
                  (offline; the old install is left untouched)
                    --from <file>           Old config (default: $OMNIRALPH_HARNESS_CONFIG,
                                            then ~/.config/omniralph/harness.json)
                    --force                 Replace an existing config (backed up first) and
                                            skip the check for a running old daemon
                    --dry-run               Print the summary and write nothing
  update          Ask the running agent (under pm2) to update with its next heartbeat:
                  to its pinned version, else the organization's, else the latest
                  on npm, even one that failed before
  git-credential  Git credential helper for job git commands (\`get\` only; reads
                  OMNIRALPH_JOB_TOKEN, set by the agent for in-job processes)

Options:
  --config <file> Agent config (default: ~/.config/omniralph/agent.json, or $OMNIRALPH_AGENT_CONFIG)
  -h, --help      Show this help
  -v, --version   Print the agent version

Local config keys (agent.json, set by hand; enroll writes only the first four):
  server, agentId, refreshToken, workspaceRoot
  dataDir             Installables, caches and settings.json (default: ~/.omniralph)
  blockedExecPaths    Absolute path prefixes never executed, symlinks resolved (default: [])
  ui.enabled          Serve the agent page (default: true)
  ui.port             The agent page's port on 127.0.0.1 (default: 7410)
  ui.allowedHosts     Extra host names the agent page answers to, e.g. behind port
                      forwarding (default: [])

Machine settings (slots, pool limits, accepted task types, host tool paths, the installables
allow-list and the version pin) are in settings.json in the data directory. Edit them on the
agent's page; a valid hand edit of the file applies at once too.
`;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface MainDeps {
  io: Io;
  fetch: FetchFn;
  env: NodeJS.ProcessEnv;
  logger?: Logger;
  capabilities?: Capability[];
  /** Reads stdin (the `git-credential` request). */
  readStdin?: () => Promise<string>;
  /** `credential.helper` for job git commands (default: this CLI's `git-credential`). */
  credentialHelper?: string;
  /** Registers the shutdown handler (SIGTERM/SIGINT by default). */
  onShutdownSignal?: (handler: () => void) => void;
  /** Installs agent versions for self-update (default: `npm i -g`). */
  installer?: Installer;
  /** Installs installables for the `install` RPC (default: `npm install --prefix`). */
  installableInstaller?: InstallableInstaller;
  /**
   * Reads Claude's login and the models it can run, for the heartbeat (default: the Agent
   * SDK's `accountInfo()` and `supportedModels()`).
   */
  readClaude?: ReadClaude;
  /** Filesystem for `settings.json` (default: `node:fs`). */
  settingsFs?: SettingsFs;
  /** Clock for self-update confirmation (ms since epoch). */
  now?: () => number;
  /** The running agent version (default: this package's). */
  version?: string;
  /** Home directory for the default config path and `~` (default: `os.homedir()`). */
  homeDir?: string;
  /** Filesystem for `import` (default: `node:fs`). */
  importFs?: ImportFs;
  /** Lists running processes for `import` (default: `/proc/<pid>/cmdline`). */
  listProcesses?: ProcessLister;
  /** Runs `pm2` for `import` (default: the `pm2` CLI, when its daemon runs). */
  runPm2?: Pm2Runner;
  /** The agent page's port, over `ui.port` (tests: 0, an ephemeral port). */
  uiPort?: number;
  /** The agent page's bundle directory (default: `dist/ui` next to the CLI). */
  uiBundleDir?: string;
  /** Opens a URL in the default browser for `ui --open` (default: `xdg-open`, `open` or `start`). */
  openUrl?: (url: string) => Promise<void>;
  /** Whether a process runs, for `ui` (default: signal 0). */
  processAlive?: (pid: number) => boolean;
}

const defaultDeps: MainDeps = {
  io: {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
  fetch: (...args) => fetch(...args),
  env: process.env,
};

const OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  config: { type: "string" },
  server: { type: "string" },
  token: { type: "string" },
  name: { type: "string" },
  "workspace-root": { type: "string" },
  "healthz-port": { type: "string" },
  from: { type: "string" },
  force: { type: "boolean" },
  "dry-run": { type: "boolean" },
  open: { type: "boolean" },
} as const;

/** Parses the CLI arguments, runs the command and returns the process exit code. */
export async function main(argv: string[], overrides: Partial<MainDeps> = {}): Promise<number> {
  const deps: MainDeps = { ...defaultDeps, ...overrides };
  const { io } = deps;
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    io.stderr(`omniralph-agent: ${(error as Error).message}\n\n${USAGE}`);
    return 1;
  }
  const { values, positionals } = parsed;
  const [command] = positionals;
  if (values.version) {
    io.stdout(`${AGENT_VERSION}\n`);
    return 0;
  }
  if (values.help || command === undefined) {
    io.stdout(USAGE);
    return command === undefined && !values.help ? 1 : 0;
  }
  const configPath =
    values.config ?? deps.env.OMNIRALPH_AGENT_CONFIG ?? defaultConfigPath(deps.homeDir);

  try {
    switch (command) {
      case "enroll":
        return await runEnroll(values, configPath, deps);
      case "start":
        return await runStart(values, configPath, deps);
      case "update":
        return await runUpdate(configPath, deps);
      case "ui":
        return await runUi(values.open ?? false, configPath, deps);
      case "import":
        return await runImport(
          {
            from: values.from,
            config: configPath,
            force: values.force ?? false,
            dryRun: values["dry-run"] ?? false,
          },
          {
            io,
            env: deps.env,
            homeDir: deps.homeDir,
            fs: deps.importFs,
            listProcesses: deps.listProcesses,
            runPm2: deps.runPm2,
            now: deps.now,
          },
        );
      case "git-credential":
        return await runGitCredential(
          positionals[1],
          deps.env,
          { readStdin: deps.readStdin ?? (() => readCredentialRequest()), ...io },
          deps.fetch,
        );
      default:
        io.stderr(`omniralph-agent: unknown command '${command}'\n\n${USAGE}`);
        return 1;
    }
  } catch (error) {
    if (error instanceof ConfigError || error instanceof ApiError) {
      io.stderr(`omniralph-agent: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

function expandHome(dir: string, home = homedir()): string {
  return path.resolve(dir === "~" || dir.startsWith("~/") ? path.join(home, dir.slice(1)) : dir);
}

async function runEnroll(
  values: { server?: string; token?: string; name?: string; "workspace-root"?: string },
  configPath: string,
  deps: MainDeps,
): Promise<number> {
  if (!values.server || !values.token) {
    deps.io.stderr(`omniralph-agent: enroll needs --server and --token\n`);
    return 1;
  }
  const server = validateServerUrl(values.server);
  const workspaceRoot = values["workspace-root"]
    ? expandHome(values["workspace-root"], deps.homeDir)
    : defaultWorkspaceRoot(deps.homeDir);
  let enrolled;
  try {
    enrolled = await enroll(
      server,
      {
        enrollmentToken: values.token,
        name: values.name ?? hostname(),
        version: AGENT_VERSION,
      },
      deps.fetch,
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      deps.io.stderr(`omniralph-agent: the enrollment token is invalid, expired or already used\n`);
      return 1;
    }
    throw error;
  }
  await writeConfig(configPath, {
    server,
    agentId: enrolled.agentId,
    refreshToken: enrolled.refreshToken,
    workspaceRoot,
  });
  deps.io.stdout(
    `Enrolled as agent ${enrolled.agentId}.\nConfig written to ${configPath}.\nRun 'omniralph-agent start' to start the agent.\n`,
  );
  return 0;
}

async function configExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function runUpdate(configPath: string, deps: MainDeps): Promise<number> {
  // Only for an enrolled agent: the request goes next to its config.
  await readConfig(configPath);
  const file = updateRequestPath(configPath);
  await writeUpdateRequest(file, deps.now ? new Date(deps.now()) : undefined);
  deps.io.stdout(
    `Update requested (${file}).\n` +
      `The running agent picks it up with its next heartbeat: it stops taking jobs, lets running ones\n` +
      `finish, installs the pinned version (else the organization's, else the latest on npm) and restarts.\n` +
      `Only agents under pm2 update themselves; others log a warning and keep running.\n`,
  );
  return 0;
}

const AGENT_NOT_RUNNING = "The agent isn't running. Start it with 'omniralph-agent start'.\n";

async function runUi(open: boolean, configPath: string, deps: MainDeps): Promise<number> {
  const config = await readConfig(configPath);
  const link = await readUiLink(uiLinkPath(configPath));
  const alive = deps.processAlive ?? processAlive;
  if (!link || !alive(link.pid) || !(await pingUiLink(link, config.agentId, deps.fetch))) {
    deps.io.stderr(AGENT_NOT_RUNNING);
    return 1;
  }
  const url = uiPageUrl(link);
  deps.io.stdout(`Agent page: ${url}\n`);
  if (open) {
    try {
      await (deps.openUrl ?? openInBrowser)(url);
    } catch (error) {
      deps.io.stderr(`omniralph-agent: couldn't open a browser (${(error as Error).message})\n`);
    }
  }
  return 0;
}

async function runStart(
  values: { "healthz-port"?: string },
  configPath: string,
  deps: MainDeps,
): Promise<number> {
  let healthzPort: number | undefined;
  if (values["healthz-port"] !== undefined) {
    healthzPort = Number(values["healthz-port"]);
    if (!Number.isInteger(healthzPort) || healthzPort < 1 || healthzPort > 65535) {
      deps.io.stderr(`omniralph-agent: invalid --healthz-port\n`);
      return 1;
    }
  }
  if (!(await configExists(configPath))) {
    deps.io.stderr(`omniralph-agent: ${await missingConfigHint(configPath, deps.homeDir)}\n`);
    return 1;
  }
  const config = await readConfig(configPath);
  const agentDataDir = dataDir(config, deps.homeDir);
  // stderr, <dataDir>/logs/agent.log and the in-memory ring.
  const log: { logger: Logger; ring?: LogRing; close: () => void } = deps.logger
    ? { logger: deps.logger, close: () => {} }
    : createLogger({ level: deps.env.OMNIRALPH_LOG_LEVEL, dataDir: agentDataDir });
  try {
    return await runAgent(config, configPath, agentDataDir, healthzPort, log, deps);
  } finally {
    log.close();
  }
}

async function runAgent(
  config: AgentConfig,
  configPath: string,
  agentDataDir: string,
  healthzPort: number | undefined,
  log: { logger: Logger; ring?: LogRing },
  deps: MainDeps,
): Promise<number> {
  const { logger } = log;
  const version = deps.version ?? AGENT_VERSION;
  // Before anything starts: an invalid settings.json stops the agent here.
  const settings = await LocalSettingsStore.open({
    file: localSettingsPath(agentDataDir),
    logger,
    fs: deps.settingsFs,
  });

  const updater = new SelfUpdater({
    statePath: updateStatePath(configPath),
    requestPath: updateRequestPath(configPath),
    pin: () => settings.effective().versionPin,
    runningVersion: version,
    underPm2: runningUnderPm2(deps.env),
    installer: deps.installer ?? npmInstaller(deps.env),
    logger,
    now: deps.now,
  });
  if ((await updater.start()) === "exit") {
    // Rolled back: pm2 starts the previous version.
    logger.info("exiting so pm2 restarts the agent on the previous version");
    return 0;
  }
  const registry = new CapabilityRegistry(deps.capabilities ?? defaultCapabilities());

  // Set once the daemon exists; a fatal token error before that is handled below.
  const running: { daemon?: AgentDaemon } = {};
  let fatal: ReenrollmentRequiredError | undefined;
  const tokens = new TokenManager({
    config,
    exchange: (refreshToken) => exchangeRefreshToken(config.server, refreshToken, deps.fetch),
    persist: (next) => writeConfig(configPath, next),
    logger,
    onFatal: (error) => {
      fatal = error;
      running.daemon?.fail(error);
    },
  });
  try {
    await tokens.start();
  } catch (error) {
    if (error instanceof ReenrollmentRequiredError) {
      deps.io.stderr(`omniralph-agent: ${error.message}; run 'omniralph-agent enroll' again\n`);
      return 1;
    }
    // Transient (network, 5xx, 429): the token manager keeps retrying.
  }

  const repos = new RepoCache({
    workspaceRoot: config.workspaceRoot,
    credentialHelper: deps.credentialHelper ?? defaultCredentialHelper(),
    logger,
  });
  // No job runs yet: whatever is left in .worktrees is from a crash.
  await repos.pruneStaleWorktrees();

  await settings.watch();
  const history = new AttemptHistory({ file: attemptsPath(agentDataDir), logger });
  await history.load();
  const installs = new InstallHistory({ file: installsPath(agentDataDir), logger });
  await installs.load();
  const packages = new PackageManager({
    allowList: () => settings.effective().installablesAllow,
    prefix: installablesPrefix(agentDataDir),
    installer: deps.installableInstaller ?? npmInstallableInstaller(deps.env),
    history: installs,
    logger,
  });
  const claude = new ClaudeStatusReporter({ read: deps.readClaude ?? sdkReadClaude(), logger });
  const hub = new UiEventHub();
  // Set right after the daemon exists (it reads the daemon); nothing heartbeats before `run()`.
  let onHeartbeat = () => {};
  const api = new HttpControlPanelApi(config.server, () => tokens.getAccessToken(), deps.fetch);
  const daemon = new AgentDaemon({
    server: config.server,
    workspaceRoot: config.workspaceRoot,
    repos,
    version,
    api,
    tokens,
    registry,
    rpcs: new SystemRpcRegistry(defaultSystemRpcs({ packages })),
    logger,
    dataDir: agentDataDir,
    claude,
    localConfig: config,
    settings,
    history,
    updater,
    wakeSubscription: (organizationId) =>
      createWakeSubscription({ agentId: config.agentId, organizationId, logger }),
    onHeartbeat: () => onHeartbeat(),
  });
  onHeartbeat = heartbeatPublisher(hub, daemon);
  running.daemon = daemon;
  if (fatal) daemon.fail(fatal);
  // What is installed changed: report the installables now, not at the next interval.
  const onInstalled = (install: { outcome: string | null }) => {
    if (install.outcome === "installed" || install.outcome === "removed") daemon.heartbeatSoon();
  };
  installs.on("change", onInstalled);

  const storage = new AgentStorage({
    workspaceRoot: config.workspaceRoot,
    dataDir: agentDataDir,
    history,
    pinned: () => daemon.pinnedRepositories(),
    logger,
  });
  const unpublish = publishLocalChanges(hub, {
    settings,
    history,
    claude,
    storage,
    installs,
    updater,
    ring: log.ring,
  });
  const ui = await startAgentPage({
    config,
    configPath,
    version,
    hub,
    deps,
    logger,
    routes: [
      ...settingsRoutes(settings),
      ...packageRoutes({ packages, history: installs, logger }),
      ...updateRoutes({ updater, daemon }),
    ],
    state: () =>
      agentUiState({
        agent: { agentId: config.agentId, name: hostname(), server: config.server, version },
        daemon,
        settings,
        updater,
        claude,
        storage,
        blockedExecPaths: config.blockedExecPaths ?? [],
        logger,
      }),
  });

  const health =
    healthzPort === undefined
      ? undefined
      : await startHealthServer(healthzPort, () => daemon.status());
  const onSignal =
    deps.onShutdownSignal ??
    ((handler: () => void) => {
      process.once("SIGTERM", handler);
      process.once("SIGINT", handler);
    });
  onSignal(() => void daemon.shutdown());

  logger.info(
    { agentId: config.agentId, server: config.server, version, selfUpdate: updater.support },
    "agent started",
  );
  const code = await daemon.run();
  await ui?.stop();
  unpublish();
  installs.off("change", onInstalled);
  tokens.stop();
  await settings.close();
  await history.close();
  await installs.flush();
  health?.close();
  if (fatal) {
    deps.io.stderr(`omniralph-agent: ${fatal.message}; run 'omniralph-agent enroll' again\n`);
  }
  logger.info({ exitCode: code }, "agent stopped");
  return code;
}

/**
 * Serves the agent page (unless `ui.enabled` is false) and writes `ui.json`
 * for `omniralph-agent ui`. The agent runs on without its page when it can't
 * be served.
 */
async function startAgentPage(options: {
  config: AgentConfig;
  configPath: string;
  version: string;
  hub: UiEventHub;
  deps: MainDeps;
  logger: Logger;
  state: () => Promise<unknown>;
  routes: readonly UiRoute[];
}): Promise<{ stop(): Promise<void> } | undefined> {
  const { config, deps, logger } = options;
  if (config.ui?.enabled === false) return undefined;
  let server: UiServer;
  try {
    server = await startUiServer({
      port: deps.uiPort ?? config.ui?.port ?? DEFAULT_UI_PORT,
      allowedHosts: config.ui?.allowedHosts ?? [],
      agentId: config.agentId,
      version: options.version,
      bundleDir: deps.uiBundleDir,
      state: options.state,
      hub: options.hub,
      routes: options.routes,
      logger,
    });
  } catch (error) {
    logger.error({ err: error }, "cannot serve the agent page; running without it");
    return undefined;
  }
  const file = uiLinkPath(options.configPath);
  try {
    await writeUiLink(file, {
      pid: process.pid,
      port: server.port,
      url: server.url,
      startedAt: new Date().toISOString(),
      token: server.token,
    });
  } catch (error) {
    logger.error(
      { err: error, file },
      "cannot write ui.json; omniralph-agent ui won't find the page",
    );
  }
  logger.info({ url: server.url }, "serving the agent page (omniralph-agent ui prints its link)");
  return {
    stop: async () => {
      await server.close();
      await removeUiLink(file, process.pid).catch((error: unknown) =>
        logger.warn({ err: error, file }, "cannot remove ui.json"),
      );
    },
  };
}
