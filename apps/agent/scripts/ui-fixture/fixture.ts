/**
 * The agent page in fixture mode: the real page server and its real API routes, over seeded
 * local state with stable names instead of a daemon, so `verify:screens` can capture every
 * state the page shows. Only runs with `OMNIRALPH_AGENT_UI_FIXTURE=1`, and lives outside
 * `src/`, so the published package (`dist/`, built from `src/cli.ts`) never has it; the
 * package smoke test checks the tarball for it.
 *
 * Seeded: settings.json (slots, pool limits, accepted kinds, host tool paths with one
 * missing, an allow-list and a version pin), installables installed, updating and failed,
 * free space and disk usage, Claude signed in with its models, log lines, two running
 * attempts (one with a live transcript and log tail), finished ones, and repos whose last
 * sync failed for one.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CHAT_ASK_JOB_TYPE,
  INSTALL_JOB_TYPE,
  RALPH_STORY_JOB_TYPE,
  REPO_SYNC_JOB_TYPE,
  REVIEW_TASK_JOB_TYPE,
  TRIAGE_RUN_JOB_TYPE,
  describeAttempt,
  installableAllowed,
  type AgentLocalSettings,
  type AttemptLabelContext,
  type InstallResult,
} from "@omniralph/shared";
import { pino } from "pino";
import type { AttemptDetail, AttemptOutcome, AttemptRecord } from "../../src/attempts/history.js";
import type { TailEvent } from "../../src/attempts/tail.js";
import type { ClaudeStatus } from "../../src/claude-status.js";
import type { DaemonHostTool, DaemonHostTools, DaemonStatus } from "../../src/daemon.js";
import type { InstalledInstallable } from "../../src/installables.js";
import { LogRing } from "../../src/logs/ring.js";
import { InstallHistory } from "../../src/packages/history.js";
import { PackageNotAllowedError, PackageNotInstalledError } from "../../src/packages/manager.js";
import { LocalSettingsStore, localSettingsPath } from "../../src/settings.js";
import type { StorageFilesystem, StorageReport, StoredRepo } from "../../src/storage.js";
import type { UpdateRequest } from "../../src/update.js";
import { attemptRoutes } from "../../src/ui/attempt-routes.js";
import { UiEventHub } from "../../src/ui/events.js";
import { logRoutes } from "../../src/ui/log-routes.js";
import { claudeRoutes, storageRoutes } from "../../src/ui/machine-routes.js";
import { packageRoutes } from "../../src/ui/package-routes.js";
import { settingsRoutes } from "../../src/ui/settings-routes.js";
import { agentUiState, type AgentUiUpdate } from "../../src/ui/state.js";
import { startUiServer, type UiServer } from "../../src/ui/server.js";
import { updateRoutes } from "../../src/ui/update-routes.js";

/** The env var that turns fixture mode on; anything but `1` refuses. */
export const AGENT_UI_FIXTURE_ENV = "OMNIRALPH_AGENT_UI_FIXTURE";

export const AGENT_UI_FIXTURE_REFUSED = `The agent page's fixture mode only runs with ${AGENT_UI_FIXTURE_ENV}=1.`;

/** The machine the fixture page describes. */
export const FIXTURE_AGENT = {
  agentId: "3c1d0b8e-5a7f-4e21-9b6d-0f2e8a4c7d10",
  name: "build-01",
  server: "https://omniralph.example.com",
  version: "2.3.1",
  user: "omniralph",
} as const;

/** The organization's version (the pin wins over it) and one that failed to install. */
export const FIXTURE_ORGANIZATION_VERSION = "2.4.1";
export const FIXTURE_FAILED_VERSION = "2.4.0";

export const FIXTURE_ROOTS = {
  workspaceRoot: "/srv/omniralph/workspace",
  dataDir: "/home/omniralph/.local/share/omniralph-agent",
} as const;

/** Attempt IDs (job IDs) by state. */
export const FIXTURE_ATTEMPTS = {
  /** Building SOC-1720: the live transcript and log tail. */
  runningStory: "7f1d6a1e-1c9b-4d6e-9f3a-2b0c1d2e3f41",
  runningReview: "7f1d6a1e-1c9b-4d6e-9f3a-2b0c1d2e3f42",
  completedTriage: "7f1d6a1e-1c9b-4d6e-9f3a-2b0c1d2e3f43",
  completedAsk: "7f1d6a1e-1c9b-4d6e-9f3a-2b0c1d2e3f44",
  /** The repo sync that failed (docs-site). */
  failedSync: "7f1d6a1e-1c9b-4d6e-9f3a-2b0c1d2e3f45",
  failedStory: "7f1d6a1e-1c9b-4d6e-9f3a-2b0c1d2e3f46",
  completedInstall: "7f1d6a1e-1c9b-4d6e-9f3a-2b0c1d2e3f47",
  canceledStory: "7f1d6a1e-1c9b-4d6e-9f3a-2b0c1d2e3f48",
  completedSync: "7f1d6a1e-1c9b-4d6e-9f3a-2b0c1d2e3f49",
} as const;

/** Install history IDs by state. */
export const FIXTURE_INSTALLS = {
  /** Updating @omniralph/skills-review from 3.2.0 to 3.3.0 (still running). */
  updating: "b6a0c3f2-8d41-4e7a-a1c9-5e2f7d3b9a01",
  /** @acme/lint-rules@2.0.0, which npm couldn't find. */
  failed: "b6a0c3f2-8d41-4e7a-a1c9-5e2f7d3b9a02",
  /** @omniralph/playbook-terraform@0.9.0, from Fleet. */
  installed: "b6a0c3f2-8d41-4e7a-a1c9-5e2f7d3b9a03",
  removed: "b6a0c3f2-8d41-4e7a-a1c9-5e2f7d3b9a04",
} as const;

/** Host tools: `terraform` is configured at a path that doesn't exist and a playbook needs it. */
export const FIXTURE_MISSING_HOST_TOOL = "terraform";
const EXISTING_PATHS = new Set(["/usr/local/bin/gh", "/opt/terraform/1.9/bin/terraform"]);
const DISCOVERED_TOOLS: Readonly<Record<string, string>> = {
  git: "/usr/bin/git",
  node: "/usr/local/bin/node",
};
const REQUIRED_HOST_TOOLS = ["gh", "git", FIXTURE_MISSING_HOST_TOOL];
const BLOCKED_EXEC_PATHS = ["/home/omniralph/.ssh", "/etc/omniralph"];

export const FIXTURE_SETTINGS: AgentLocalSettings = {
  v: 1,
  maxConcurrency: 6,
  poolLimits: { long: 2, short: 4 },
  acceptedTaskTypes: ["review", "coding"],
  hostTools: {
    gh: "/usr/local/bin/gh",
    [FIXTURE_MISSING_HOST_TOOL]: "/opt/terraform/bin/terraform",
  },
  installables: { allow: ["@omniralph/*", "@acme/*"] },
  update: { pin: FIXTURE_AGENT.version },
};

const GB = 1024 ** 3;
const MB = 1024 ** 2;

export interface AgentUiFixtureOptions {
  /** Must have `OMNIRALPH_AGENT_UI_FIXTURE=1`. */
  env: NodeJS.ProcessEnv;
  /** The built page (`dist/ui`). */
  bundleDir: string;
  /** 0 (the default): an ephemeral port. */
  port?: number;
  /** Extra `Host` names to answer to, e.g. `host.docker.internal`. */
  allowedHosts?: readonly string[];
  token?: string;
  /** The seed's clock (ms since epoch); times are relative to it. */
  now?: number;
}

export interface AgentUiFixture {
  server: UiServer;
  /** `<url>/?token=…`: opening it signs the browser in. */
  link: string;
  close(): Promise<void>;
}

const minutesAgo = (now: number, minutes: number) => new Date(now - minutes * 60_000).toISOString();

export async function startAgentUiFixture(options: AgentUiFixtureOptions): Promise<AgentUiFixture> {
  if (options.env[AGENT_UI_FIXTURE_ENV] !== "1") throw new Error(AGENT_UI_FIXTURE_REFUSED);
  const now = options.now ?? Date.now();
  const logger = pino({ name: "agent-ui-fixture", level: "warn" }, pino.destination(2));
  const dataDir = await mkdtemp(path.join(tmpdir(), "omniralph-agent-ui-fixture-"));
  try {
    const file = localSettingsPath(dataDir);
    await writeFile(file, `${JSON.stringify(FIXTURE_SETTINGS, null, 2)}\n`, { mode: 0o600 });
    const settings = await LocalSettingsStore.open({ file, logger });
    const hub = new UiEventHub();
    const world = seedWorld(now, hub, () => settings.effective().installablesAllow);
    settings.on("change", () => {
      hub.publish("settings");
      // Saved host tool paths and slots are what the next heartbeat would check and report.
      hub.publish("host_tools");
      hub.publish("status");
    });

    const hostTools = (): DaemonHostTools => fixtureHostTools(settings.effective().hostTools);
    const daemon = {
      status: (): DaemonStatus => ({
        stopping: false,
        draining: false,
        connected: true,
        lastHeartbeatAt: new Date(Date.now() - 8_000).toISOString(),
        unreachableSince: null,
        revoked: false,
        runningJobIds: world.attempts.running().map((attempt) => attempt.id),
        maxConcurrency: settings.effective().maxConcurrency,
      }),
      hostToolsState: hostTools,
      missingRequiredHostTools: () =>
        hostTools()
          .tools.filter((tool) => tool.required && tool.path === null)
          .map((tool) => tool.name),
      versionPolicy: () => ({ kind: "latest" as const, version: FIXTURE_ORGANIZATION_VERSION }),
      heartbeatSoon: () => {},
    };

    const server = await startUiServer({
      port: options.port ?? 0,
      allowedHosts: options.allowedHosts,
      agentId: FIXTURE_AGENT.agentId,
      version: FIXTURE_AGENT.version,
      bundleDir: options.bundleDir,
      token: options.token,
      hub,
      logger,
      routes: [
        ...settingsRoutes(settings),
        ...packageRoutes({ packages: world.packages, history: world.installs, logger }),
        ...updateRoutes({ updater: world.updater, daemon }),
        ...claudeRoutes(world.claude),
        ...storageRoutes({ storage: world.storage, logger }),
        ...attemptRoutes({ history: world.attempts, log: { ring: world.ring }, logger }),
        ...logRoutes({ log: { ring: world.ring }, logger }),
      ],
      state: () =>
        agentUiState({
          agent: { ...FIXTURE_AGENT },
          daemon,
          settings,
          updater: world.updater,
          claude: world.claude,
          storage: world.storage,
          blockedExecPaths: BLOCKED_EXEC_PATHS,
          logger,
        }),
    });
    return {
      server,
      link: `${server.url}/?token=${encodeURIComponent(server.token)}`,
      close: async () => {
        await server.close();
        world.close();
        await settings.close();
        await rm(dataDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
}

/** The host tools as a check of `configured` finds them: configured, discovered or missing. */
export function fixtureHostTools(configured: Readonly<Record<string, string>>): DaemonHostTools {
  const names = [
    ...new Set([
      ...Object.keys(configured),
      ...Object.keys(DISCOVERED_TOOLS),
      ...REQUIRED_HOST_TOOLS,
    ]),
  ].sort();
  const tools = names.map((name): DaemonHostTool => {
    const required = REQUIRED_HOST_TOOLS.includes(name);
    const configuredPath = Object.hasOwn(configured, name) ? configured[name]! : null;
    if (configuredPath !== null) {
      return EXISTING_PATHS.has(configuredPath)
        ? {
            name,
            path: configuredPath,
            source: "configured",
            problem: null,
            checkedPath: configuredPath,
            required,
          }
        : {
            name,
            path: null,
            source: null,
            problem: "missing",
            checkedPath: configuredPath,
            required,
          };
    }
    const found = DISCOVERED_TOOLS[name] ?? null;
    return {
      name,
      path: found,
      source: found === null ? null : "discovered",
      problem: null,
      checkedPath: null,
      required,
    };
  });
  return { tools, required: [...REQUIRED_HOST_TOOLS].sort() };
}

const REPO = {
  portal: { provider: "github" as const, fullPath: "acme/customer-portal" },
  billing: { provider: "gitlab" as const, fullPath: "platform/billing-api" },
  docs: { provider: "github" as const, fullPath: "acme/docs-site" },
};

/**
 * Names the page shows as metadata: the agent's and its repos'. `verify:screens` finds any of
 * them shown on its own instead of as a badge (rule 1).
 */
export const FIXTURE_METADATA_NAMES: readonly string[] = [
  FIXTURE_AGENT.name,
  ...Object.values(REPO).map((repo) => repo.fullPath),
];

function attempt(
  now: number,
  fields: {
    id: string;
    type: string;
    taskType: AttemptRecord["taskType"];
    repo?: AttemptRecord["repo"];
    workItem?: string;
    story?: string;
    context?: AttemptLabelContext;
    startedMinutesAgo: number;
    finishedMinutesAgo?: number;
    outcome?: AttemptOutcome;
    error?: string;
  },
): AttemptRecord {
  const outcome = fields.outcome ?? null;
  const repo = fields.repo ?? null;
  const context: AttemptLabelContext = {
    workItem: fields.workItem ?? null,
    story: fields.story ?? null,
    repository: repo?.fullPath ?? null,
    provider: repo?.provider ?? null,
    ...fields.context,
  };
  return {
    id: fields.id,
    type: fields.type,
    taskType: fields.taskType,
    runId: fields.workItem ? `run-${fields.id.slice(-2)}` : null,
    repo,
    workItem: fields.workItem ?? null,
    story: fields.story ?? null,
    startedAt: minutesAgo(now, fields.startedMinutesAgo),
    finishedAt:
      fields.finishedMinutesAgo === undefined ? null : minutesAgo(now, fields.finishedMinutesAgo),
    outcome,
    error: fields.error ?? null,
    label: describeAttempt({ type: fields.type, status: outcome ?? "running", context }),
  };
}

function seedWorld(now: number, hub: UiEventHub, allowList: () => readonly string[]) {
  const ids = FIXTURE_ATTEMPTS;
  const running = [
    attempt(now, {
      id: ids.runningStory,
      type: RALPH_STORY_JOB_TYPE,
      taskType: "coding",
      repo: REPO.portal,
      workItem: "SOC-1719",
      story: "SOC-1720",
      startedMinutesAgo: 12,
    }),
    attempt(now, {
      id: ids.runningReview,
      type: REVIEW_TASK_JOB_TYPE,
      taskType: "review",
      repo: REPO.billing,
      context: { pullRequestNumber: 42 },
      startedMinutesAgo: 3,
    }),
  ];
  const recent = [
    attempt(now, {
      id: ids.completedTriage,
      type: TRIAGE_RUN_JOB_TYPE,
      taskType: "query",
      workItem: "SOC-1731",
      startedMinutesAgo: 26,
      finishedMinutesAgo: 21,
      outcome: "completed",
    }),
    attempt(now, {
      id: ids.completedAsk,
      type: CHAT_ASK_JOB_TYPE,
      taskType: "query",
      repo: REPO.portal,
      startedMinutesAgo: 41,
      finishedMinutesAgo: 39,
      outcome: "completed",
    }),
    attempt(now, {
      id: ids.failedSync,
      type: REPO_SYNC_JOB_TYPE,
      taskType: "system",
      repo: REPO.docs,
      startedMinutesAgo: 55,
      finishedMinutesAgo: 55,
      outcome: "failed",
      error: "git fetch failed: Repository not found (HTTP 404)",
    }),
    attempt(now, {
      id: ids.failedStory,
      type: RALPH_STORY_JOB_TYPE,
      taskType: "coding",
      repo: REPO.portal,
      workItem: "SOC-1719",
      story: "SOC-1718",
      startedMinutesAgo: 95,
      finishedMinutesAgo: 71,
      outcome: "failed",
      error: "The quality gates failed: pnpm test exited with 1",
    }),
    attempt(now, {
      id: ids.completedInstall,
      type: INSTALL_JOB_TYPE,
      taskType: "system",
      context: { packageName: "@omniralph/playbook-terraform" },
      startedMinutesAgo: 180,
      finishedMinutesAgo: 179,
      outcome: "completed",
    }),
    attempt(now, {
      id: ids.canceledStory,
      type: RALPH_STORY_JOB_TYPE,
      taskType: "coding",
      repo: REPO.billing,
      workItem: "BIL-88",
      story: "BIL-90",
      startedMinutesAgo: 300,
      finishedMinutesAgo: 288,
      outcome: "canceled",
    }),
    attempt(now, {
      id: ids.completedSync,
      type: REPO_SYNC_JOB_TYPE,
      taskType: "system",
      repo: REPO.portal,
      startedMinutesAgo: 360,
      finishedMinutesAgo: 359,
      outcome: "completed",
    }),
  ];
  const at = (minutes: number) => minutesAgo(now, minutes);
  const transcript: TailEvent[] = [
    {
      type: "thought",
      body: "Reading the story and the files it names.",
      parameter: null,
      at: at(11.5),
    },
    { type: "action", body: "Read", parameter: "src/billing/invoice-list.tsx", at: at(11) },
    { type: "action", body: "Grep", parameter: "formatCurrency", at: at(10) },
    {
      type: "thought",
      body: "The invoice list formats amounts itself; it should use the shared formatter.",
      parameter: null,
      at: at(9),
    },
    { type: "action", body: "Edit", parameter: "src/billing/invoice-list.tsx", at: at(7) },
    { type: "action", body: "Bash", parameter: "pnpm vitest run src/billing", at: at(4) },
    {
      type: "thought",
      body: "Two tests fail on the rounding of negative amounts.",
      parameter: null,
      at: at(2),
    },
    { type: "action", body: "Edit", parameter: "src/lib/format.ts", at: at(1) },
  ];
  const tails = new Map<string, TailEvent[]>([[ids.runningStory, transcript]]);
  const attempts = {
    running: () => [...running],
    recent: (limit = recent.length) => recent.slice(0, limit),
    get: (id: string): AttemptDetail | undefined => {
      const record = [...running, ...recent].find((entry) => entry.id === id);
      return record ? { ...record, events: [...(tails.get(id) ?? [])] } : undefined;
    },
  };

  const ring = new LogRing();
  const line = (
    minutes: number,
    level: "info" | "warn" | "error",
    msg: string,
    fields: Record<string, unknown> = {},
  ) =>
    ring.write(
      JSON.stringify({
        level: { info: 30, warn: 40, error: 50 }[level],
        time: now - minutes * 60_000,
        pid: 4182,
        hostname: FIXTURE_AGENT.name,
        name: "omniralph-agent",
        ...fields,
        msg,
      }),
    );
  line(400, "info", "agent started", {
    agentId: FIXTURE_AGENT.agentId,
    version: FIXTURE_AGENT.version,
  });
  line(399, "info", "serving the agent page (omniralph-agent ui prints its link)");
  line(360, "info", "repository synced", {
    jobId: ids.completedSync,
    repository: REPO.portal.fullPath,
  });
  line(180, "info", "installed a package", {
    jobId: ids.completedInstall,
    installable: "@omniralph/playbook-terraform",
  });
  line(95, "info", "claimed a job", { jobId: ids.failedStory });
  line(71, "error", "the quality gates failed", {
    jobId: ids.failedStory,
    command: "pnpm test",
    exitCode: 1,
  });
  line(55, "warn", "git fetch failed", {
    jobId: ids.failedSync,
    repository: REPO.docs.fullPath,
    status: 404,
  });
  line(30, "warn", "the configured host tool path doesn't exist", {
    hostTool: FIXTURE_MISSING_HOST_TOOL,
  });
  line(12, "info", "claimed a job", { jobId: ids.runningStory });
  line(11.8, "info", "prepared the worktree", {
    jobId: ids.runningStory,
    branch: "omniralph/soc-1720-invoice-totals",
  });
  line(11.5, "info", "started a Claude session", {
    jobId: ids.runningStory,
    model: "claude-opus-5-5",
  });
  line(4, "info", "running a command", {
    jobId: ids.runningStory,
    command: "pnpm vitest run src/billing",
  });
  line(3.9, "warn", "the command exited with 1", { jobId: ids.runningStory, exitCode: 1 });
  line(3, "info", "claimed a job", { jobId: ids.runningReview });
  line(1, "info", "heartbeat", { runningJobs: 2, freeSlots: 4 });

  // The install history, through its real class with the seed's clock.
  let clock = now;
  const queuedIds: string[] = [
    FIXTURE_INSTALLS.removed,
    FIXTURE_INSTALLS.installed,
    FIXTURE_INSTALLS.failed,
    FIXTURE_INSTALLS.updating,
  ];
  let installCount = 0;
  const installs = new InstallHistory({
    logger: pino({ level: "silent" }),
    now: () => new Date(clock),
    newId: () =>
      queuedIds.shift() ?? `b6a0c3f2-8d41-4e7a-a1c9-${String(++installCount).padStart(12, "0")}`,
  });
  const seedInstall = (
    minutes: number,
    entry: Parameters<InstallHistory["start"]>[0],
    result?: Parameters<InstallHistory["finish"]>[1],
  ) => {
    clock = now - minutes * 60_000;
    const record = installs.start(entry);
    if (!result) return;
    clock += 40_000;
    installs.finish(record.id, result);
  };
  seedInstall(
    2_900,
    {
      action: "remove",
      name: "@acme/legacy-hooks",
      version: null,
      previousVersion: "0.4.2",
      from: "local",
    },
    { outcome: "removed", output: "removed 1 package in 812ms" },
  );
  seedInstall(
    180,
    {
      action: "install",
      name: "@omniralph/playbook-terraform",
      version: "0.9.0",
      previousVersion: null,
      from: "fleet",
    },
    { outcome: "installed", installedVersion: "0.9.0", output: "added 1 package in 2s" },
  );
  seedInstall(
    48,
    {
      action: "install",
      name: "@acme/lint-rules",
      version: "2.0.0",
      previousVersion: null,
      from: "local",
    },
    {
      outcome: "failed",
      error: "npm install exited with 1",
      output: [
        "npm error code E404",
        "npm error 404 Not Found - GET https://registry.npmjs.org/@acme%2flint-rules - Not found",
        "npm error 404  '@acme/lint-rules@2.0.0' is not in this registry.",
      ].join("\n"),
    },
  );
  seedInstall(1, {
    action: "install",
    name: "@omniralph/skills-review",
    version: "3.3.0",
    previousVersion: "3.2.0",
    from: "fleet",
  });
  installs.on("change", (install) => hub.publish("packages", { ids: [install.id] }));
  // Installs from the page: queued now, done a moment later (nothing runs npm).
  const timers = new Set<NodeJS.Timeout>();
  const later = (step: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      clock = Date.now();
      step();
    }, 1_500);
    timers.add(timer);
  };
  const installed: InstalledInstallable[] = [
    { name: "@acme/deploy-tools", version: "1.8.2" },
    { name: "@omniralph/playbook-terraform", version: "0.9.0" },
    { name: "@omniralph/skills-review", version: "3.2.0" },
  ];
  const packages = {
    installed: async () => [...installed].sort((a, b) => a.name.localeCompare(b.name)),
    install: (request: { name: string; version?: string }) => {
      clock = Date.now();
      const version = request.version ?? "latest";
      const previous = installed.find((entry) => entry.name === request.name);
      const entry = {
        action: "install" as const,
        name: request.name,
        version,
        previousVersion: previous?.version ?? null,
        from: "local" as const,
      };
      if (!installableAllowed(allowList(), request.name)) {
        const started = installs.start(entry);
        const record = installs.finish(started.id, {
          outcome: "failed",
          error: `${request.name} isn't allowed on this agent`,
        });
        throw new PackageNotAllowedError(request.name, record ?? started);
      }
      const record = installs.start(entry);
      const done = new Promise<InstallResult>((resolve) =>
        later(() => {
          const installedVersion = /^\d/.test(version) ? version : "1.0.0";
          const index = installed.findIndex((item) => item.name === request.name);
          if (index >= 0) installed.splice(index, 1);
          installed.push({ name: request.name, version: installedVersion });
          installs.finish(record.id, {
            outcome: "installed",
            installedVersion,
            output: "added 1 package",
          });
          resolve({
            name: request.name,
            version: installedVersion,
            changed: true,
            commands: [],
            mcpServers: [],
            skills: 0,
          });
        }),
      );
      return { record, done };
    },
    remove: async (request: { name: string }) => {
      clock = Date.now();
      const previous = installed.find((entry) => entry.name === request.name);
      if (!previous) throw new PackageNotInstalledError(request.name);
      const record = installs.start({
        action: "remove",
        name: request.name,
        version: null,
        previousVersion: previous.version,
        from: "local",
      });
      const done = new Promise<void>((resolve) =>
        later(() => {
          installed.splice(installed.indexOf(previous), 1);
          installs.finish(record.id, { outcome: "removed", output: "removed 1 package" });
          resolve();
        }),
      );
      return { record, done };
    },
  };

  let request: UpdateRequest | null = null;
  const updater = {
    support: "supported" as const,
    report: (): Omit<AgentUiUpdate, "request"> => ({
      selfUpdate: "supported",
      update: { state: "idle", version: null, previous: null, startsSincePending: 0, error: null },
      failedVersions: [FIXTURE_FAILED_VERSION],
    }),
    pendingRequest: () => (request ? { ...request } : null),
    request: (options: { version?: string | null } = {}) => {
      request = { version: options.version ?? null, requestedAt: new Date().toISOString() };
      hub.publish("update");
      return { ...request };
    },
  };

  const claudeStatus = (checkedAt: string): ClaudeStatus => ({
    status: "signed_in",
    source: "login",
    account: {
      email: "builds@acme.example",
      organization: "Acme Engineering",
      subscriptionType: "max",
    },
    models: [
      { value: "claude-opus-5-5", displayName: "Opus 5.5" },
      { value: "claude-sonnet-5-5", displayName: "Sonnet 5.5" },
      { value: "claude-haiku-5-5", displayName: "Haiku 5.5" },
    ],
    checkedAt,
  });
  let claudeState = claudeStatus(minutesAgo(now, 14));
  const claude = {
    status: () => claudeState,
    check: async () => {
      claudeState = claudeStatus(new Date().toISOString());
      hub.publish("claude");
      return claudeState;
    },
  };

  const filesystems: StorageFilesystem[] = [
    { paths: [FIXTURE_ROOTS.workspaceRoot], freeBytes: 268 * GB, totalBytes: 512 * GB, low: false },
    { paths: [FIXTURE_ROOTS.dataDir], freeBytes: 21 * GB, totalBytes: 64 * GB, low: false },
  ];
  const ws = FIXTURE_ROOTS.workspaceRoot;
  const report = (): StorageReport => ({
    items: [
      { key: "repo_cache", paths: [ws], bytes: 38.4 * GB },
      { key: "worktrees", paths: [`${ws}/.worktrees`], bytes: 6.2 * GB },
      { key: "branch_worktrees", paths: [`${ws}/.branches`], bytes: 2.9 * GB },
      { key: "packages", paths: [`${FIXTURE_ROOTS.dataDir}/installables`], bytes: 184 * MB },
      { key: "caches", paths: [`${FIXTURE_ROOTS.dataDir}/cache`], bytes: 1.1 * GB },
      { key: "logs", paths: [`${FIXTURE_ROOTS.dataDir}/logs`], bytes: 96 * MB },
    ].map((item) => ({ ...item, bytes: Math.round(item.bytes) })) as StorageReport["items"],
    measuredAt: minutesAgo(now, 6),
    filesystems,
    low: false,
  });
  const repos: StoredRepo[] = [
    {
      ...REPO.portal,
      host: null,
      path: `${ws}/github/github.com/acme/customer-portal`,
      bytes: Math.round(21.7 * GB),
      lastFetchedAt: minutesAgo(now, 12),
      lastSync: { outcome: "completed", error: null, at: minutesAgo(now, 359) },
      pinned: true,
    },
    {
      ...REPO.billing,
      host: "gitlab.acme.example",
      path: `${ws}/gitlab/gitlab.acme.example/platform/billing-api`,
      bytes: Math.round(14.3 * GB),
      lastFetchedAt: minutesAgo(now, 3),
      lastSync: null,
      pinned: false,
    },
    {
      ...REPO.docs,
      host: null,
      path: `${ws}/github/github.com/acme/docs-site`,
      bytes: Math.round(2.4 * GB),
      lastFetchedAt: minutesAgo(now, 2_880),
      lastSync: {
        outcome: "failed",
        error: "git fetch failed: Repository not found (HTTP 404)",
        at: minutesAgo(now, 55),
      },
      pinned: false,
    },
  ];
  const storage = {
    measure: async () => report(),
    filesystems: async () => filesystems,
    listRepos: async () => repos.map((repo) => ({ ...repo })),
    roots: () => ({ ...FIXTURE_ROOTS }),
    isMeasuring: () => false,
  };

  return {
    attempts,
    ring,
    installs,
    packages,
    updater,
    claude,
    storage,
    close: () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
