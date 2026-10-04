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
import { ReenrollmentRequiredError, TokenManager } from "./auth.js";
import { CapabilityRegistry, defaultCapabilities, type Capability } from "./capabilities/index.js";
import {
  ConfigError,
  defaultConfigPath,
  defaultWorkspaceRoot,
  readConfig,
  validateServerUrl,
  writeConfig,
} from "./config.js";
import { AgentDaemon } from "./daemon.js";
import { startHealthServer } from "./healthz.js";
import { createLogger, type Logger } from "./logger.js";
import { createQueueReceiver, type QueueReceiverFactory } from "./queue.js";
import { AGENT_VERSION } from "./version.js";

export const USAGE = `Usage: omniralph-agent <command> [options]

Commands:
  enroll          Enroll this host with the control panel
                    --server <url>          Control panel URL (https://; http://localhost for development)
                    --token <token>         One-time enrollment token from the Agents page
                    --name <name>           Agent name (default: the hostname)
                    --workspace-root <dir>  Repo cache directory (default: ~/.omniralph/repos)
  start           Run the agent daemon
                    --healthz-port <port>   Serve GET /healthz on 127.0.0.1:<port>
  git-credential  Git credential helper (not yet implemented)

Options:
  --config <file> Agent config (default: ~/.config/omniralph/agent.json, or $OMNIRALPH_AGENT_CONFIG)
  -h, --help      Show this help
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
  queue?: QueueReceiverFactory;
  /** Registers the shutdown handler (SIGTERM/SIGINT by default). */
  onShutdownSignal?: (handler: () => void) => void;
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
  config: { type: "string" },
  server: { type: "string" },
  token: { type: "string" },
  name: { type: "string" },
  "workspace-root": { type: "string" },
  "healthz-port": { type: "string" },
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
  if (values.help || command === undefined) {
    io.stdout(USAGE);
    return command === undefined && !values.help ? 1 : 0;
  }
  const configPath = values.config ?? deps.env.OMNIRALPH_AGENT_CONFIG ?? defaultConfigPath();

  try {
    switch (command) {
      case "enroll":
        return await runEnroll(values, configPath, deps);
      case "start":
        return await runStart(values, configPath, deps);
      case "git-credential":
        io.stderr(`omniralph-agent: 'git-credential' is not implemented yet\n`);
        return 1;
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

function expandHome(dir: string): string {
  return path.resolve(
    dir === "~" || dir.startsWith("~/") ? path.join(homedir(), dir.slice(1)) : dir,
  );
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
    ? expandHome(values["workspace-root"])
    : defaultWorkspaceRoot();
  const capabilities = new CapabilityRegistry(deps.capabilities ?? defaultCapabilities()).names();
  let enrolled;
  try {
    enrolled = await enroll(
      server,
      {
        enrollmentToken: values.token,
        name: values.name ?? hostname(),
        version: AGENT_VERSION,
        capabilities,
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
  const config = await readConfig(configPath);
  const logger = deps.logger ?? createLogger(deps.env.OMNIRALPH_LOG_LEVEL);
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

  const api = new HttpControlPanelApi(config.server, () => tokens.getAccessToken(), deps.fetch);
  const daemon = new AgentDaemon({
    server: config.server,
    workspaceRoot: config.workspaceRoot,
    version: AGENT_VERSION,
    api,
    tokens,
    registry,
    queue:
      deps.queue ??
      ((region) => createQueueReceiver(config.server, region, () => tokens.currentAccessToken())),
    logger,
  });
  running.daemon = daemon;
  if (fatal) daemon.fail(fatal);

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
    { agentId: config.agentId, server: config.server, version: AGENT_VERSION },
    "agent started",
  );
  const code = await daemon.run();
  tokens.stop();
  health?.close();
  if (fatal) {
    deps.io.stderr(`omniralph-agent: ${fatal.message}; run 'omniralph-agent enroll' again\n`);
  }
  logger.info({ exitCode: code }, "agent stopped");
  return code;
}
