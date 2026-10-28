import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  effectiveLocalSettings,
  type AgentLocalSettings,
  type ClaimRequest,
  type Heartbeat,
  type HeartbeatResponse,
  type JobFailure,
  type JobOutcomeResponse,
  type JobPayload,
  type JobStartResponse,
  type RunSpec,
} from "@omniralph/shared";
import { RunSpecAgent, TaskDefinition } from "@omniralph/tasks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ControlPanelApi } from "./api.js";
import {
  CapabilityRegistry,
  defaultCapabilities,
  RetryableJobError,
  type Capability,
  type JobContext,
} from "./capabilities/index.js";
import { AttemptHistory } from "./attempts/history.js";
import { ReenrollmentRequiredError } from "./auth.js";
import type { ClaudeStatus } from "./claude-status.js";
import { AgentDaemon, JobCanceled, ShutdownAbort, type DaemonOptions } from "./daemon.js";
import { ralphCapability } from "./capabilities/ralph/index.js";
import { silentLogger } from "./logger.js";
import { LocalSettingsStore, type LocalSettingsState } from "./settings.js";
import { sessionRequest } from "./test/fake-query.js";
import { memorySettingsFs } from "./test/settings-fs.js";
import type { WakeEvent, WakeSubscription } from "./wake.js";
import type { RepoCache } from "./workspace/repoCache.js";
import { SelfUpdater, readUpdateState } from "./update.js";

const HELLO_FIXTURE = fileURLToPath(
  new URL("./test/fixtures/installables/hello/package.json", import.meta.url),
);

const ORG_ID = randomUUID();
/** The task types every claim carries when the local config sets none. */
const ALL_TYPES = ["query", "review", "coding"];

function centralConfig(overrides: Partial<HeartbeatResponse> = {}): HeartbeatResponse {
  return {
    pinnedRepositories: [],
    organizationId: ORG_ID,
    cancelJobIds: [],
    jobTokens: [],
    jobMessages: [],
    desiredVersion: null,
    requiredHostTools: [],
    ...overrides,
  };
}

type LocalSettings = Omit<AgentLocalSettings, "v">;

/** `settings.json` as the daemon sees it: `set` changes it like a page save. */
class FakeSettings extends EventEmitter<{ change: [LocalSettingsState] }> {
  constructor(private settings: AgentLocalSettings) {
    super();
  }

  effective() {
    return effectiveLocalSettings(this.settings);
  }

  set(settings: LocalSettings): void {
    this.settings = { v: 1, ...settings };
    this.emit("change", {
      settings: this.settings,
      effective: this.effective(),
      revision: "none",
      lastError: null,
    });
  }
}

/** The heartbeat's `local` for `settings`. */
function localReport(settings: LocalSettings) {
  const effective = effectiveLocalSettings({ v: 1, ...settings });
  return {
    maxConcurrency: effective.maxConcurrency,
    poolLimits: effective.poolLimits,
    versionPin: effective.versionPin,
    installablesAllow: effective.installablesAllow,
  };
}

function job(id: string, overrides: Partial<JobPayload> = {}): JobPayload {
  return {
    id,
    type: "review.run",
    taskType: "review",
    pool: "short",
    taskId: null,
    repositoryId: null,
    payload: {},
    deliveryCount: 1,
    ...overrides,
  };
}

function runSpecFor(j: JobPayload, tokens: RunSpec["tokens"]): RunSpec {
  return {
    jobId: j.id,
    // A legacy-shaped task type on a fixture job stands for a run of that type.
    taskType: j.taskType === "system" ? "query" : j.taskType,
    pool: "short",
    agent: RunSpecAgent.parse({
      id: "builtin:test-agent",
      name: "Test agent",
      systemPrompt: "You answer.",
      taskTypes: ["query"],
    }),
    task: TaskDefinition.parse({
      id: j.taskId,
      name: "Test task",
      taskType: "query",
      agentId: "builtin:test-agent",
      triggers: ["finding.dismissed"],
      promptTemplate: "{{finding.title}}",
      sink: "learned-rule",
    }),
    trigger: { kind: "finding.dismissed", context: { finding: { title: "Unused import" } } },
    repository: null,
    ref: null,
    requireCheckout: false,
    tools: { allowedTools: [], disallowedTools: [] },
    model: null,
    fallbackModel: null,
    tokenBudget: null,
    tokens,
  };
}

function runResponse(j: JobPayload): JobStartResponse {
  if (j.taskId !== null) {
    // A run-spec job: a lifecycle and a session token, and its run spec.
    const lifecycle = {
      jobId: j.id,
      token: `lifecycle-${j.id}`,
      expiresIn: 900,
      kind: "lifecycle" as const,
    };
    const session = {
      jobId: j.id,
      token: `session-${j.id}`,
      expiresIn: 900,
      kind: "session" as const,
    };
    return {
      action: "run",
      job: j,
      runSpec: runSpecFor(j, { lifecycle, session }),
      jobToken: lifecycle,
      sessionToken: session,
    };
  }
  return {
    action: "run",
    job: j,
    jobToken: { jobId: j.id, token: `job-token-${j.id}`, expiresIn: 900, kind: "legacy" },
  };
}

/**
 * An in-memory stand-in for `POST /api/agent/claim`: hands out the first
 * queued job of a requested pool and accepted task type (or a `system` job, which has neither), else holds the claim until a job is
 * pushed, the claim is aborted or 50s pass (null). A claim with
 * `waitSeconds: 0` returns null at once when there's no job.
 */
class FakeClaims {
  private readonly jobs: JobPayload[] = [];
  private readonly waiting = new Set<() => void>();
  /** Pools of every claim, in order. */
  readonly calls: string[][] = [];
  /** `acceptedTaskTypes` of every claim, in order. */
  readonly accepted: ClaimRequest["acceptedTaskTypes"][] = [];
  /** `waitSeconds` of every claim, in order (undefined: the default long-poll). */
  readonly waits: (number | undefined)[] = [];
  /** Pools of every aborted claim. */
  readonly aborted: string[][] = [];
  inFlight = 0;
  maxInFlight = 0;

  push(...jobs: JobPayload[]): void {
    this.jobs.push(...jobs);
    for (const wake of [...this.waiting]) wake();
  }

  readonly claim = async (
    { pools, acceptedTaskTypes, waitSeconds }: ClaimRequest,
    signal?: AbortSignal,
  ): Promise<JobStartResponse | null> => {
    this.calls.push(pools);
    this.accepted.push(acceptedTaskTypes);
    this.waits.push(waitSeconds);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      for (;;) {
        const index = this.jobs.findIndex(
          (j) =>
            j.taskType === "system" ||
            (j.pool !== null &&
              pools.includes(j.pool) &&
              (acceptedTaskTypes ?? []).some((type) => type === j.taskType)),
        );
        if (index >= 0) return runResponse(this.jobs.splice(index, 1)[0]!);
        if (waitSeconds === 0) return null;
        const outcome = await new Promise<"pushed" | "timeout">((resolve, reject) => {
          const finish = (settle: () => void) => {
            clearTimeout(timer);
            this.waiting.delete(onPush);
            signal?.removeEventListener("abort", onAbort);
            settle();
          };
          const onPush = () => finish(() => resolve("pushed"));
          const onAbort = () => {
            this.aborted.push(pools);
            finish(() => reject(signal!.reason));
          };
          const timer = setTimeout(() => finish(() => resolve("timeout")), 50_000);
          this.waiting.add(onPush);
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort);
        });
        if (outcome === "timeout") return null;
      }
    } finally {
      this.inFlight--;
    }
  };
}

function fakeApi(claims: FakeClaims, config: HeartbeatResponse = centralConfig()) {
  const state = { config };
  const api = {
    heartbeat: vi.fn(async (_body: Heartbeat) => state.config),
    claim: vi.fn(claims.claim),
    submitResult: vi.fn(async (): Promise<JobOutcomeResponse> => ({ status: "completed" })),
    submitFailure: vi.fn(async (_id: string, body: JobFailure): Promise<JobOutcomeResponse> =>
      body.retryable
        ? { status: "retry", retryAfterSeconds: body.retryAfterSeconds ?? 60 }
        : { status: "failed" },
    ),
  } satisfies ControlPanelApi;
  return { api, state };
}

/** A stand-in for the Ably wake subscription: tests emit its events. */
class FakeWake implements WakeSubscription {
  readonly tokens: { token: string; expiresAt: string }[] = [];
  closed = false;
  private readonly listeners = new Map<WakeEvent, (() => void)[]>();

  constructor(readonly organizationId: string) {}

  setToken(token: string, expiresAt: string): void {
    this.tokens.push({ token, expiresAt });
  }

  on(event: WakeEvent, listener: () => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
  }

  emit(event: WakeEvent): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => (resolve = res));
  return { promise, resolve };
}

function capability(run: Capability["run"], overrides: Partial<Capability> = {}): Capability {
  return {
    name: "review",
    jobTypes: ["review.run"],
    toolPolicy: {
      tools: "allowed",
      allowedTools: ["Read"],
      disallowedTools: ["Bash"],
      fileScope: "worktree",
      permissionMode: "dontAsk",
      settingSources: [],
      writable: false,
    },
    run,
    ...overrides,
  };
}

function setup(options: {
  run?: Capability["run"];
  runQueryTask?: DaemonOptions["runQueryTask"];
  runReviewTask?: DaemonOptions["runReviewTask"];
  runCodingTask?: DaemonOptions["runCodingTask"];
  capabilities?: Capability[];
  config?: HeartbeatResponse;
  repos?: RepoCache;
  updater?: SelfUpdater;
  dataDir?: string;
  localConfig?: DaemonOptions["localConfig"];
  /** `settings.json` (default: one slot); `local` makes it a `FakeSettings`. */
  settings?: DaemonOptions["settings"];
  local?: LocalSettings;
  hostToolSearchPath?: string;
  claude?: DaemonOptions["claude"];
  host?: DaemonOptions["host"];
  history?: DaemonOptions["history"];
  onHeartbeat?: DaemonOptions["onHeartbeat"];
  /** Opens fake wake subscriptions (into `wakes`); without it the daemon has no wake transport. */
  wake?: boolean;
}) {
  const claims = new FakeClaims();
  const { api, state } = fakeApi(claims, options.config);
  const local = new FakeSettings({ v: 1, maxConcurrency: 1, ...options.local });
  const tokens = { refresh: vi.fn(async () => "access") };
  const wakes: FakeWake[] = [];
  const wakeSubscription = options.wake
    ? (organizationId: string) => {
        const wake = new FakeWake(organizationId);
        wakes.push(wake);
        return wake;
      }
    : undefined;
  const daemon = new AgentDaemon({
    server: "https://omniralph.example",
    workspaceRoot: "/tmp/omniralph-test",
    repos: options.repos,
    version: "1.2.3",
    api,
    tokens,
    registry: new CapabilityRegistry(
      options.capabilities ?? [capability(options.run ?? (async () => ({ ok: true })))],
    ),
    // Never the real query lifecycle (it would start Claude sessions).
    runQueryTask:
      options.runQueryTask ?? (() => Promise.reject(new Error("this test runs no query tasks"))),
    runReviewTask:
      options.runReviewTask ?? (() => Promise.reject(new Error("this test runs no review tasks"))),
    runCodingTask:
      options.runCodingTask ?? (() => Promise.reject(new Error("this test runs no coding tasks"))),
    logger: silentLogger(),
    reportRetryDelayMs: 10,
    dataDir: options.dataDir,
    localConfig: options.localConfig,
    settings: options.settings ?? local,
    hostToolSearchPath: () => options.hostToolSearchPath,
    updater: options.updater,
    claude: options.claude,
    host: options.host ?? (() => ({ hostname: "agent-host", coder: null })),
    history: options.history,
    onHeartbeat: options.onHeartbeat,
    wakeSubscription,
  });
  return { api, state, claims, tokens, daemon, wakes, local };
}

/** Lets pending promises and zero-delay timers run. */
async function settle() {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AgentDaemon", () => {
  it("reports the installables in its data directory's prefix in every heartbeat", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "omniralph-daemon-data-"));
    try {
      const prefix = path.join(dataDir, "installables");
      const place = async (name: string, packageJson: Record<string, unknown>) => {
        const dir = path.join(prefix, "node_modules", ...name.split("/"));
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, "package.json"), JSON.stringify(packageJson));
      };
      await place("@omniralph/hello", JSON.parse(await readFile(HELLO_FIXTURE, "utf8")));
      // A dependency of an installable: in node_modules but not installed itself.
      await place("@omniralph/transitive", {
        name: "@omniralph/transitive",
        version: "3.0.0",
        omniralph: {},
      });
      // Installed, but not (or no longer) a valid installable.
      await place("left-pad", { name: "left-pad", version: "1.3.0" });
      await writeFile(
        path.join(prefix, "package.json"),
        JSON.stringify({
          name: "omniralph-installables",
          private: true,
          dependencies: {
            "left-pad": "1.3.0",
            "@omniralph/hello": "1.0.0",
            "@omniralph/gone": "1.0.0",
          },
        }),
      );

      const { api, daemon } = setup({ dataDir });
      await daemon.heartbeat();
      expect(api.heartbeat).toHaveBeenLastCalledWith(
        expect.objectContaining({ installables: [{ name: "@omniralph/hello", version: "1.0.0" }] }),
      );

      await rm(prefix, { recursive: true });
      await daemon.heartbeat();
      expect(api.heartbeat).toHaveBeenLastCalledWith(expect.objectContaining({ installables: [] }));
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("reports its host in every heartbeat", async () => {
    const host = { hostname: "coder-ws-1", coder: { owner: "steve", workspace: "omniralph" } };
    const { api, daemon } = setup({ host: () => host });
    await daemon.heartbeat();
    expect(api.heartbeat).toHaveBeenLastCalledWith(expect.objectContaining({ host }));
  });

  it("keeps the repositories the last heartbeat pinned to it", async () => {
    const { daemon, state } = setup({});
    expect(daemon.pinnedRepositories()).toEqual([]);
    const pin = { id: randomUUID(), provider: "gitlab" as const, fullPath: "acme/api" };
    state.config = centralConfig({ pinnedRepositories: [pin] });
    await daemon.heartbeat();
    expect(daemon.pinnedRepositories()).toEqual([pin]);
    state.config = centralConfig({ pinnedRepositories: [] });
    await daemon.heartbeat();
    expect(daemon.pinnedRepositories()).toEqual([]);
  });

  it("reports its configured and required host tools in the heartbeat and exposes their paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "omniralph-daemon-tools-"));
    try {
      const executable = async (relative: string) => {
        const file = path.join(root, relative);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, "#!/bin/sh\n");
        await chmod(file, 0o755);
        return file;
      };
      const configured = await executable("opt/configured");
      const blocked = await executable("blocked/blocked");
      const discovered = await executable("path/discovered");
      await executable("path/missing");
      await executable("blocked/hidden");
      const { api, state, daemon } = setup({
        localConfig: { blockedExecPaths: [path.join(root, "blocked")] },
        hostToolSearchPath: [path.join(root, "blocked"), path.join(root, "path")].join(
          path.delimiter,
        ),
        local: {
          maxConcurrency: 1,
          hostTools: {
            configured,
            missing: path.join(root, "opt/missing"),
            blocked,
          },
        },
      });
      state.config = centralConfig({ requiredHostTools: ["discovered", "hidden", "nowhere"] });

      // The first heartbeat knows only the configured tools; the response asks about more.
      await daemon.heartbeat();
      expect(api.heartbeat).toHaveBeenLastCalledWith(
        expect.objectContaining({
          hostTools: [
            { name: "blocked", path: null, source: null, problem: "blocked" },
            { name: "configured", path: configured, source: "configured", problem: null },
            { name: "missing", path: null, source: null, problem: "missing" },
          ],
        }),
      );
      expect(daemon.hostToolPath("configured")).toBe(configured);
      expect(daemon.hostToolPath("discovered")).toBeNull();

      await daemon.heartbeat();
      expect(api.heartbeat).toHaveBeenLastCalledWith(
        expect.objectContaining({
          hostTools: [
            { name: "blocked", path: null, source: null, problem: "blocked" },
            { name: "configured", path: configured, source: "configured", problem: null },
            { name: "discovered", path: discovered, source: "discovered", problem: null },
            { name: "hidden", path: null, source: null, problem: null },
            { name: "missing", path: null, source: null, problem: "missing" },
            { name: "nowhere", path: null, source: null, problem: null },
          ],
        }),
      );
      expect(daemon.hostToolPath("configured")).toBe(configured);
      expect(daemon.hostToolPath("missing")).toBeNull();
      expect(daemon.hostToolPath("discovered")).toBe(discovered);
      expect(daemon.hostToolPath("nowhere")).toBeNull();
      expect(daemon.hostToolPath("blocked")).toBeNull();
      expect(daemon.hostToolPath("hidden")).toBeNull();
      // Only what the playbooks require counts as missing.
      expect(daemon.missingRequiredHostTools()).toEqual(["hidden", "nowhere"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("re-checks and reports host tools at once when settings.json changes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "omniralph-daemon-tools-"));
    try {
      const discovered = path.join(root, "path/gh");
      const configured = path.join(root, "opt/gh");
      for (const file of [discovered, configured]) {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, "#!/bin/sh\n");
        await chmod(file, 0o755);
      }
      const { api, state, daemon, local } = setup({
        hostToolSearchPath: path.join(root, "path"),
        config: centralConfig({ requiredHostTools: ["gh"] }),
      });
      void daemon.run();
      await settle();
      // The first response asked about gh: it's checked and reported right away.
      expect(api.heartbeat).toHaveBeenCalledTimes(2);
      expect(api.heartbeat).toHaveBeenLastCalledWith(
        expect.objectContaining({
          hostTools: [{ name: "gh", path: discovered, source: "discovered", problem: null }],
        }),
      );
      expect(daemon.hostToolPath("gh")).toBe(discovered);

      local.set({ maxConcurrency: 1, hostTools: { gh: configured } });
      // The configured path changed: unavailable until checked, which the heartbeat does at once.
      expect(daemon.hostToolPath("gh")).toBeNull();
      await settle();
      expect(api.heartbeat).toHaveBeenCalledTimes(3);
      expect(api.heartbeat).toHaveBeenLastCalledWith(
        expect.objectContaining({
          hostTools: [{ name: "gh", path: configured, source: "configured", problem: null }],
        }),
      );
      expect(daemon.hostToolPath("gh")).toBe(configured);
      expect(state.config.requiredHostTools).toEqual(["gh"]);
      await daemon.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports the models Claude can run and its login state, without the account, in every heartbeat", async () => {
    const opus = { value: "opus", displayName: "Opus" };
    const checkedAt = "2026-10-28T10:00:00.000Z";
    const current = vi.fn<() => Promise<ClaudeStatus>>(async () => ({
      status: "signed_in",
      source: "login",
      account: { email: "steve@example.com", organization: "Example", subscriptionType: "max" },
      models: [opus],
      checkedAt,
    }));
    const { api, daemon } = setup({ claude: { current } });
    await daemon.heartbeat();
    expect(api.heartbeat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        models: [opus],
        claude: { status: "signed_in", source: "login", checkedAt },
      }),
    );
    expect(JSON.stringify(api.heartbeat.mock.lastCall)).not.toContain("steve@example.com");
    current.mockResolvedValueOnce({ status: "signed_out", source: null, models: [], checkedAt });
    await daemon.heartbeat();
    expect(api.heartbeat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        models: [],
        claude: { status: "signed_out", source: null, checkedAt },
      }),
    );
  });

  it("heartbeats every 20s with its version, running jobs and free slots", async () => {
    const { api, daemon } = setup({});
    void daemon.run();
    await settle();
    expect(api.heartbeat).toHaveBeenCalledTimes(1);
    expect(api.heartbeat).toHaveBeenLastCalledWith({
      version: "1.2.3",
      runningJobIds: [],
      freeSlots: 0,
      deliveredMessageIds: [],
      rejectedMessageIds: [],
      failedVersions: [],
      installables: [],
      hostTools: [],
      models: [],
      // Its local accepted task types: all by default.
      acceptedTaskTypes: ["query", "review", "coding"],
      host: { hostname: "agent-host", coder: null },
      // Its machine settings in force: one slot (the setup's), the rest defaults.
      local: {
        maxConcurrency: 1,
        poolLimits: { short: 1, long: 1 },
        versionPin: null,
        installablesAllow: ["@omniralph/*"],
      },
    });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(api.heartbeat).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.heartbeat).toHaveBeenCalledTimes(2);
    expect(api.heartbeat).toHaveBeenLastCalledWith(expect.objectContaining({ freeSlots: 1 }));
    await daemon.shutdown();
  });

  it("claims only the task types of its settings, reporting them in heartbeats and claims", async () => {
    const codingId = randomUUID();
    const reviewId = randomUUID();
    const runReviewTask = vi.fn(async (spec: RunSpec) => ({ review: spec.jobId }));
    const runCodingTask = vi.fn(async () => ({}));
    const { api, claims, daemon } = setup({
      runReviewTask,
      runCodingTask,
      local: { maxConcurrency: 2, acceptedTaskTypes: ["review"] },
    });
    claims.push(
      job(codingId, {
        type: "ralph.story",
        taskType: "coding",
        pool: "long",
        taskId: "builtin:test-task",
      }),
      job(reviewId, { taskType: "review", taskId: "builtin:test-task" }),
    );
    void daemon.run();
    await settle();
    expect(api.heartbeat).toHaveBeenLastCalledWith(
      expect.objectContaining({ acceptedTaskTypes: ["review"] }),
    );
    // Never the long pool (no accepted task type runs in it), and its types in every claim.
    expect(claims.calls.length).toBeGreaterThan(0);
    expect(claims.calls.every((pools) => pools.join() === "short")).toBe(true);
    expect(claims.accepted.every((types) => types?.join() === "review")).toBe(true);
    expect(runReviewTask).toHaveBeenCalledTimes(1);
    expect(api.submitResult).toHaveBeenCalledWith(reviewId, { result: { review: reviewId } });
    expect(runCodingTask).not.toHaveBeenCalled();
    await daemon.shutdown();
  });

  it("sends the accepted task types of settings.json current at each heartbeat and claim", async () => {
    const memory = memorySettingsFs();
    const store = await LocalSettingsStore.open({
      file: "/data/settings.json",
      logger: silentLogger(),
      fs: memory.fs,
    });
    const { api, claims, daemon } = setup({ settings: store });
    void daemon.run();
    await settle();
    expect(claims.accepted).toEqual([ALL_TYPES]);
    expect(claims.calls).toEqual([["short", "long"]]);
    expect(api.heartbeat).toHaveBeenCalledTimes(1);

    // Saved mid-run: a heartbeat goes out at once, and the long poll is replaced by a claim
    // with the new kinds.
    const saved = await store.update("kinds", { acceptedTaskTypes: ["coding"] }, "none");
    expect(saved.status).toBe("saved");
    await settle();
    expect(api.heartbeat).toHaveBeenCalledTimes(2);
    expect(api.heartbeat).toHaveBeenLastCalledWith(
      expect.objectContaining({ acceptedTaskTypes: ["coding"] }),
    );
    expect(claims.aborted).toEqual([["short", "long"]]);
    expect(claims.accepted.at(-1)).toEqual(["coding"]);
    expect(claims.calls.at(-1)).toEqual(["long"]);
    await daemon.shutdown();
  });

  it("does not claim before the first successful heartbeat", async () => {
    const { api, claims, daemon } = setup({});
    api.heartbeat.mockRejectedValueOnce(new ApiError(503, undefined, "down"));
    void daemon.run();
    await settle();
    expect(claims.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(claims.calls).toEqual([["short", "long"]]);
    await daemon.shutdown();
  });

  it("asks the token manager to refresh when the heartbeat gets 401", async () => {
    const { api, tokens, daemon } = setup({});
    api.heartbeat.mockRejectedValueOnce(new ApiError(401, "unauthorized", "401"));
    void daemon.run();
    await settle();
    expect(tokens.refresh).toHaveBeenCalledTimes(1);
    await daemon.shutdown();
  });

  it("tells since when the control panel is unreachable, and when a heartbeat gets through again", async () => {
    vi.setSystemTime(new Date("2026-10-28T10:42:00.000Z"));
    const onHeartbeat = vi.fn();
    const { api, daemon } = setup({ onHeartbeat });
    expect(daemon.status()).toMatchObject({
      connected: false,
      unreachableSince: null,
      revoked: false,
    });
    api.heartbeat.mockRejectedValueOnce(new ApiError(503, undefined, "down"));
    api.heartbeat.mockRejectedValueOnce(new TypeError("fetch failed"));
    await daemon.heartbeat();
    expect(daemon.status().unreachableSince).toBe("2026-10-28T10:42:00.000Z");
    vi.setSystemTime(new Date("2026-10-28T10:43:00.000Z"));
    await daemon.heartbeat();
    // Still since the first failure.
    expect(daemon.status().unreachableSince).toBe("2026-10-28T10:42:00.000Z");
    expect(onHeartbeat).toHaveBeenCalledTimes(2);

    await daemon.heartbeat();
    expect(daemon.status()).toMatchObject({
      connected: true,
      lastHeartbeatAt: "2026-10-28T10:43:00.000Z",
      unreachableSince: null,
    });
    expect(onHeartbeat).toHaveBeenCalledTimes(3);
  });

  it("keeps heartbeating when the heartbeat listener throws", async () => {
    const { api, daemon } = setup({
      onHeartbeat: () => {
        throw new Error("broken listener");
      },
    });
    await daemon.heartbeat();
    await daemon.heartbeat();
    expect(api.heartbeat).toHaveBeenCalledTimes(2);
  });

  it("says it was revoked when it has to be enrolled again", async () => {
    const { daemon } = setup({});
    const exit = daemon.run();
    await settle();
    daemon.fail(new ReenrollmentRequiredError("re-enrollment required (refresh_token_reused)"));
    expect(await exit).toBe(1);
    expect(daemon.status().revoked).toBe(true);
  });

  it("isn't revoked when it stops for another reason", async () => {
    const { daemon } = setup({});
    const exit = daemon.run();
    await settle();
    daemon.fail(new Error("something else"));
    expect(await exit).toBe(1);
    expect(daemon.status().revoked).toBe(false);
  });

  it("runs a claimed job with the job token, reports the result and claims again at once", async () => {
    const id = randomUUID();
    const seen: { jobToken?: string; workspaceRoot?: string } = {};
    const { api, claims, daemon } = setup({
      run: async (j, ctx) => {
        seen.jobToken = ctx.jobToken();
        seen.workspaceRoot = ctx.workspaceRoot;
        return { findings: [], jobId: j.id };
      },
    });
    claims.push(job(id));
    void daemon.run();
    await settle();
    expect(api.claim).toHaveBeenCalledWith(
      { pools: ["short", "long"], acceptedTaskTypes: ALL_TYPES },
      expect.any(AbortSignal),
    );
    expect(seen).toEqual({ jobToken: `job-token-${id}`, workspaceRoot: "/tmp/omniralph-test" });
    expect(api.submitResult).toHaveBeenCalledWith(id, { result: { findings: [], jobId: id } });
    expect(claims.calls).toEqual([
      ["short", "long"],
      ["short", "long"],
    ]);
    expect(claims.inFlight).toBe(1);
    await daemon.shutdown();
  });

  it("claims again as soon as an empty claim returns", async () => {
    const { claims, daemon } = setup({});
    void daemon.run();
    await settle();
    expect(claims.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(49_999);
    expect(claims.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(claims.calls).toHaveLength(2);
    await daemon.shutdown();
  });

  it("backs off on claim errors (doubling up to 30s) and resets after a successful claim", async () => {
    const { api, claims, tokens, daemon } = setup({});
    api.claim.mockRejectedValue(new ApiError(503, undefined, "down"));
    void daemon.run();
    await settle();
    expect(api.claim).toHaveBeenCalledTimes(1);
    for (const [i, delay] of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(api.claim).toHaveBeenCalledTimes(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(api.claim).toHaveBeenCalledTimes(i + 2);
    }

    // A 401 also asks for a fresh access token.
    api.claim.mockRejectedValueOnce(new ApiError(401, "unauthorized", "401"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(tokens.refresh).toHaveBeenCalledTimes(1);

    api.claim.mockImplementation(claims.claim);
    await vi.advanceTimersByTimeAsync(30_000);
    const calls = api.claim.mock.calls.length;
    // The empty claim returns after 50s; the next one fails and waits only 1s.
    api.claim.mockRejectedValueOnce(new ApiError(503, undefined, "down"));
    await vi.advanceTimersByTimeAsync(50_000);
    expect(api.claim).toHaveBeenCalledTimes(calls + 1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.claim).toHaveBeenCalledTimes(calls + 2);
    await daemon.shutdown();
  });

  it("only reports a retryable failure: no acknowledgement, lease or redelivery handling", async () => {
    const id = randomUUID();
    const { api, claims, daemon } = setup({
      run: async () => {
        throw new RetryableJobError("rate limited", 120);
      },
    });
    claims.push(job(id));
    void daemon.run();
    await settle();
    expect(api.submitFailure).toHaveBeenCalledTimes(1);
    expect(api.submitFailure).toHaveBeenCalledWith(id, {
      retryable: true,
      error: "rate limited",
      retryAfterSeconds: 120,
    });
    expect(api.submitResult).not.toHaveBeenCalled();
    // Nothing else is sent for the job: the next heartbeat and claim don't mention it.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.heartbeat).toHaveBeenLastCalledWith(
      expect.objectContaining({ runningJobIds: [], freeSlots: 1 }),
    );
    expect(api.claim.mock.calls.map(([body]) => body)).toEqual([
      { pools: ["short", "long"], acceptedTaskTypes: ALL_TYPES },
      { pools: ["short", "long"], acceptedTaskTypes: ALL_TYPES },
    ]);
    expect(daemon.status().runningJobIds).toEqual([]);
    await daemon.shutdown();
  });

  it("reports other errors as non-retryable failures", async () => {
    const id = randomUUID();
    const { api, claims, daemon } = setup({
      run: async () => {
        throw new Error("boom");
      },
    });
    claims.push(job(id));
    void daemon.run();
    await settle();
    expect(api.submitFailure).toHaveBeenCalledWith(id, { retryable: false, error: "boom" });
    await daemon.shutdown();
  });

  it("ignores the deprecated topics, queueRegion and pollIntervalSeconds", async () => {
    const id = randomUUID();
    const { api, claims, daemon } = setup({
      config: centralConfig({
        topics: [`review-jobs-org-${randomUUID()}`],
        queueRegion: "iad1",
        pollIntervalSeconds: 5,
      }),
    });
    claims.push(job(id));
    void daemon.run();
    await settle();
    expect(api.submitResult).toHaveBeenCalledWith(id, { result: { ok: true } });
    // Long-polls instead of waiting pollIntervalSeconds.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(claims.calls).toEqual([
      ["short", "long"],
      ["short", "long"],
    ]);
    await daemon.shutdown();
  });

  it("claims long jobs only once coding is accepted, and runs them by job type", async () => {
    const id = randomUUID();
    const { api, local, claims, daemon } = setup({
      capabilities: [capability(async () => ({})), ralphCapability],
      local: { maxConcurrency: 1, acceptedTaskTypes: ["query", "review"] },
    });
    claims.push(job(id, { type: "ralph.prepare", taskType: "coding", pool: "long" }));
    void daemon.run();
    await settle();
    expect(claims.calls).toEqual([["short"]]);
    expect(api.submitFailure).not.toHaveBeenCalled();

    local.set({ maxConcurrency: 1 });
    await settle();
    // The claim without the long pool was aborted and replaced.
    expect(claims.aborted).toEqual([["short"]]);
    expect(claims.calls[1]).toEqual(["short", "long"]);
    expect(api.submitFailure).toHaveBeenCalledWith(id, {
      retryable: false,
      error: "invalid ralph.prepare payload",
    });
    await daemon.shutdown();
  });

  it("reports its version pin, at once when it changes", async () => {
    const { api, local, daemon } = setup({
      local: { maxConcurrency: 1, update: { pin: "2.0.3" } },
    });
    void daemon.run();
    await settle();
    expect(api.heartbeat).toHaveBeenLastCalledWith(
      expect.objectContaining({ local: expect.objectContaining({ versionPin: "2.0.3" }) }),
    );
    const before = api.heartbeat.mock.calls.length;
    local.set({ maxConcurrency: 1 });
    await settle();
    expect(api.heartbeat.mock.calls.length).toBeGreaterThan(before);
    expect(api.heartbeat).toHaveBeenLastCalledWith(
      expect.objectContaining({ local: expect.objectContaining({ versionPin: null }) }),
    );
    await daemon.shutdown();
  });

  it("reports an unknown job type as a non-retryable failure", async () => {
    const id = randomUUID();
    const run = vi.fn(async () => ({}));
    const { api, claims, daemon } = setup({ run });
    claims.push(job(id, { type: "review.frobnicate" }));
    void daemon.run();
    await settle();
    expect(run).not.toHaveBeenCalled();
    expect(api.submitFailure).toHaveBeenCalledWith(id, {
      retryable: false,
      error: "unknown job type review.frobnicate",
    });
    await daemon.shutdown();
  });

  it("fails a legacy review.run job (no task) instead of running it", async () => {
    const id = randomUUID();
    const runReviewTask = vi.fn(async () => ({}));
    const { api, claims, daemon } = setup({
      capabilities: defaultCapabilities(),
      runReviewTask,
    });
    claims.push(job(id, { type: "review.run", taskType: "review", taskId: null }));
    void daemon.run();
    await settle();
    expect(runReviewTask).not.toHaveBeenCalled();
    expect(api.submitResult).not.toHaveBeenCalled();
    expect(api.submitFailure).toHaveBeenCalledWith(id, {
      retryable: false,
      error: "unknown job type review.run",
    });
    await daemon.shutdown();
  });

  it("drops the outcome when the job was taken over by another agent (409)", async () => {
    const { api, claims, daemon } = setup({});
    api.submitResult.mockRejectedValueOnce(new ApiError(409, "not_current_agent", "409"));
    claims.push(job(randomUUID()));
    void daemon.run();
    await settle();
    expect(api.submitResult).toHaveBeenCalledTimes(1);
    expect(claims.calls).toHaveLength(2);
    await daemon.shutdown();
  });

  it("retries reporting, then gives up (the lease lapses) and goes on claiming", async () => {
    const { api, claims, daemon } = setup({});
    api.submitResult.mockRejectedValue(new ApiError(503, undefined, "down"));
    claims.push(job(randomUUID()));
    void daemon.run();
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    expect(api.submitResult).toHaveBeenCalledTimes(3);
    expect(daemon.status().runningJobIds).toEqual([]);
    expect(claims.inFlight).toBe(1);
    await daemon.shutdown();
  });

  it("claims up to maxConcurrency jobs, one claim at a time", async () => {
    const gates = new Map<string, ReturnType<typeof deferred>>();
    let running = 0;
    let maxRunning = 0;
    const { api, claims, daemon } = setup({
      local: { maxConcurrency: 2 },
      run: async (j) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        const gate = deferred();
        gates.set(j.id, gate);
        await gate.promise;
        running--;
        return {};
      },
    });
    const ids = Array.from({ length: 5 }, () => randomUUID());
    claims.push(...ids.map((id) => job(id)));
    void daemon.run();
    await settle();
    expect(running).toBe(2);
    expect(daemon.status().runningJobIds).toEqual(ids.slice(0, 2));
    // Full: no claim in flight, and heartbeats while busy don't start one.
    expect(claims.inFlight).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(claims.calls).toHaveLength(2);
    expect(api.heartbeat).toHaveBeenLastCalledWith(expect.objectContaining({ freeSlots: 0 }));

    gates.get(ids[0]!)!.resolve();
    await settle();
    expect(running).toBe(2);
    expect(daemon.status().runningJobIds).toEqual([ids[1], ids[2]]);
    for (const id of ids.slice(1)) {
      gates.get(id)?.resolve();
      await settle();
    }
    gates.get(ids[4]!)?.resolve();
    await settle();
    expect(api.submitResult).toHaveBeenCalledTimes(5);
    expect(maxRunning).toBe(2);
    expect(claims.maxInFlight).toBe(1);
    await daemon.shutdown();
  });

  /** Review and ralph capabilities whose jobs wait on gates. */
  function gatedCapabilities(local: LocalSettings) {
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const runningJobs: Record<string, string[]> = { review: [], ralph: [] };
    const signals = new Map<string, AbortSignal>();
    const run =
      (name: string): Capability["run"] =>
      async (j, ctx) => {
        runningJobs[name]!.push(j.id);
        signals.set(j.id, ctx.signal);
        const gate = deferred();
        gates.set(j.id, gate);
        await gate.promise;
        runningJobs[name] = runningJobs[name]!.filter((id) => id !== j.id);
        return {};
      };
    const env = setup({
      local,
      capabilities: [
        capability(run("review")),
        capability(run("ralph"), { name: "ralph", jobTypes: ["ralph.story"] }),
      ],
    });
    const pushRalph = (...ids: string[]) =>
      env.claims.push(
        ...ids.map((id) => job(id, { type: "ralph.story", taskType: "coding", pool: "long" })),
      );
    return { ...env, gates, runningJobs, signals, pushRalph };
  }

  it("caps the long pool at its limit so a slot stays free for short jobs", async () => {
    const { api, claims, daemon, gates, runningJobs, pushRalph } = gatedCapabilities({
      maxConcurrency: 2,
      poolLimits: { short: 2, long: 1 },
    });
    const ralph = Array.from({ length: 3 }, () => randomUUID());
    pushRalph(...ralph);
    void daemon.run();
    await settle();
    expect(daemon.poolLimit("long")).toBe(1);
    expect(runningJobs.ralph).toEqual([ralph[0]]);
    expect(daemon.freeSlots()).toBe(1);
    // With one coding job running at the long limit of 1, only `short` is asked for.
    expect(claims.calls).toEqual([["short", "long"], ["short"]]);
    expect(daemon.claimablePools()).toEqual(["short"]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.heartbeat).toHaveBeenLastCalledWith(expect.objectContaining({ freeSlots: 1 }));

    const review = randomUUID();
    claims.push(job(review));
    await settle();
    expect(runningJobs.review).toEqual([review]);
    expect(runningJobs.ralph).toEqual([ralph[0]]);
    expect(daemon.freeSlots()).toBe(0);

    // A finished review frees its slot, but the long pool still has none.
    gates.get(review)!.resolve();
    await settle();
    expect(runningJobs.ralph).toEqual([ralph[0]]);
    expect(claims.calls.at(-1)).toEqual(["short"]);
    expect(daemon.freeSlots()).toBe(1);

    // A finished coding job aborts the short-only claim and claims the long pool again.
    gates.get(ralph[0]!)!.resolve();
    await settle();
    expect(runningJobs.ralph).toEqual([ralph[1]]);
    expect(claims.aborted).toEqual([["short"]]);
    gates.get(ralph[1]!)!.resolve();
    await settle();
    gates.get(ralph[2]!)!.resolve();
    await settle();
    expect(api.submitResult).toHaveBeenCalledTimes(4);
    expect(claims.maxInFlight).toBe(1);
    await daemon.shutdown();
  });

  it("keeps running jobs when a limit is lowered below them and aborts the claim when it's raised", async () => {
    const { api, local, claims, daemon, gates, runningJobs, signals, pushRalph } =
      gatedCapabilities({ maxConcurrency: 3, poolLimits: { short: 3, long: 2 } });
    const ralph = Array.from({ length: 3 }, () => randomUUID());
    pushRalph(...ralph);
    void daemon.run();
    await settle();
    expect(runningJobs.ralph).toEqual([ralph[0], ralph[1]]);
    expect(daemon.freeSlots()).toBe(1);
    expect(claims.calls.at(-1)).toEqual(["short"]);

    // Lowered below the 2 running coding jobs: nothing is canceled, no coding job is claimed.
    const late = randomUUID();
    pushRalph(late);
    local.set({ maxConcurrency: 3, poolLimits: { short: 3, long: 1 } });
    await settle();
    expect(daemon.poolLimit("long")).toBe(1);
    expect(api.heartbeat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        local: expect.objectContaining({ poolLimits: { short: 3, long: 1 } }),
      }),
    );
    expect(runningJobs.ralph).toEqual([ralph[0], ralph[1]]);
    expect(signals.get(ralph[0]!)!.aborted).toBe(false);
    expect(signals.get(ralph[1]!)!.aborted).toBe(false);
    // Over the limit: only short jobs could still start, as the claim already asks.
    expect(daemon.freeSlots()).toBe(1);
    expect(claims.aborted).toEqual([]);

    // Still at the limit after one finishes: no coding job until the count drops below it.
    gates.get(ralph[0]!)!.resolve();
    await settle();
    expect(runningJobs.ralph).toEqual([ralph[1]]);
    expect(claims.aborted).toEqual([]);
    expect(claims.calls.at(-1)).toEqual(["short"]);

    // Raising the limit aborts the short-only claim; the new one gets the long job.
    local.set({ maxConcurrency: 3, poolLimits: { short: 3, long: 3 } });
    await settle();
    expect(claims.aborted).toEqual([["short"]]);
    expect(runningJobs.ralph).toEqual([ralph[1], ralph[2], late]);
    for (const gate of gates.values()) gate.resolve();
    await settle();
    await daemon.shutdown();
  });

  it("applies a change of its slots at once, without restarting", async () => {
    const gates: ReturnType<typeof deferred>[] = [];
    let running = 0;
    let maxRunning = 0;
    const { api, local, claims, daemon } = setup({
      local: { maxConcurrency: 1 },
      run: async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        const gate = deferred();
        gates.push(gate);
        await gate.promise;
        running--;
        return {};
      },
    });
    claims.push(...Array.from({ length: 4 }, () => job(randomUUID())));
    void daemon.run();
    await settle();
    expect(running).toBe(1);

    // Raised: claims at once, and a heartbeat reports the new slots without waiting.
    local.set({ maxConcurrency: 3 });
    await settle();
    expect(running).toBe(3);
    expect(api.heartbeat).toHaveBeenCalledTimes(2);
    expect(api.heartbeat).toHaveBeenLastCalledWith(
      expect.objectContaining({ local: localReport({ maxConcurrency: 3 }) }),
    );
    expect(daemon.status().maxConcurrency).toBe(3);

    // Lowering it cancels nothing: running jobs finish, and none starts until under it.
    local.set({ maxConcurrency: 1 });
    await settle();
    expect(api.heartbeat).toHaveBeenCalledTimes(3);
    expect(api.heartbeat).toHaveBeenLastCalledWith(
      expect.objectContaining({ freeSlots: 0, local: localReport({ maxConcurrency: 1 }) }),
    );
    expect(running).toBe(3);
    claims.push(job(randomUUID()));
    gates.splice(0, 2).forEach((gate) => gate.resolve());
    await settle();
    expect(running).toBe(1);
    gates.splice(0).forEach((gate) => gate.resolve());
    await settle();
    expect(running).toBe(1);
    expect(maxRunning).toBe(3);
    gates.splice(0).forEach((gate) => gate.resolve());
    await settle();
    gates.splice(0).forEach((gate) => gate.resolve());
    await settle();
    expect(api.submitResult).toHaveBeenCalledTimes(5);

    // Narrowed to coding: only the long pool is claimed, so a review job waits.
    local.set({ maxConcurrency: 1, acceptedTaskTypes: ["coding"] });
    await settle();
    expect(claims.calls.at(-1)).toEqual(["long"]);
    claims.push(job(randomUUID()));
    await vi.advanceTimersByTimeAsync(20_000);
    await settle();
    expect(api.submitResult).toHaveBeenCalledTimes(5);
    await daemon.shutdown();
  });

  it("heartbeats again right after the one in flight when the settings change meanwhile", async () => {
    const { api, local, daemon } = setup({});
    void daemon.run();
    await settle();
    expect(api.heartbeat).toHaveBeenCalledTimes(1);
    const gate = deferred();
    api.heartbeat.mockImplementationOnce(async () => {
      await gate.promise;
      return centralConfig();
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.heartbeat).toHaveBeenCalledTimes(2);
    local.set({ maxConcurrency: 4 });
    await settle();
    // One at a time: the next waits for the one in flight, then goes at once.
    expect(api.heartbeat).toHaveBeenCalledTimes(2);
    gate.resolve();
    await settle();
    expect(api.heartbeat).toHaveBeenCalledTimes(3);
    expect(api.heartbeat).toHaveBeenLastCalledWith(
      expect.objectContaining({ local: localReport({ maxConcurrency: 4 }) }),
    );
    // Then the interval again, from that heartbeat.
    await vi.advanceTimersByTimeAsync(19_999);
    expect(api.heartbeat).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.heartbeat).toHaveBeenCalledTimes(4);

    // After shutdown a change sends nothing.
    await daemon.shutdown();
    local.set({ maxConcurrency: 2 });
    await settle();
    expect(api.heartbeat).toHaveBeenCalledTimes(4);
  });

  it("always claims system jobs and runs repo.sync through the repo cache with the job env", async () => {
    const repository = {
      provider: "gitlab" as const,
      fullPath: "group/app",
      cloneUrl: "https://gitlab.example/group/app.git",
    };
    const sync = vi.fn(async () => ({
      dir: "/cache/gitlab/group/app",
      cloned: true,
      fetched: false,
    }));
    const { api, claims, daemon } = setup({
      repos: { sync } as unknown as RepoCache,
    });
    const id = randomUUID();
    claims.push(
      job(id, {
        type: "repo.sync",
        taskType: "system",
        pool: null,
        payload: { repository },
      }),
    );
    void daemon.run();
    await settle();
    // System jobs need no pool: any claim gets them.
    expect(sync).toHaveBeenCalledTimes(1);
    const [repo, options] = sync.mock.calls[0] as unknown as [unknown, { env: NodeJS.ProcessEnv }];
    expect(repo).toEqual(repository);
    expect(options.env.OMNIRALPH_JOB_TOKEN).toBe(`job-token-${id}`);
    expect(api.submitResult).toHaveBeenCalledWith(id, {
      result: { repository: "gitlab/group/app", cloned: true, fetched: false },
    });
    await daemon.shutdown();
  });

  it("dispatches system jobs to the RPC registry before capabilities, and fails unknown RPCs", async () => {
    const run = vi.fn(async () => ({ ok: true }));
    const { api, claims, daemon } = setup({
      // A capability claiming the RPC's job type is never asked.
      capabilities: [{ ...capability(run), name: "legacy", jobTypes: ["repo.sync", "repo.other"] }],
    });
    const unknown = randomUUID();
    claims.push(job(unknown, { type: "repo.other", taskType: "system", pool: null }));
    void daemon.run();
    await settle();
    expect(run).not.toHaveBeenCalled();
    expect(api.submitFailure).toHaveBeenCalledWith(unknown, {
      retryable: false,
      error: "unknown system RPC repo.other",
    });
    await daemon.shutdown();
  });

  it("updates job tokens from heartbeats", async () => {
    const id = randomUUID();
    const gate = deferred();
    let ctx: JobContext | undefined;
    const { state, claims, daemon } = setup({
      run: async (_j, c) => {
        ctx = c;
        await gate.promise;
        return {};
      },
    });
    claims.push(job(id));
    void daemon.run();
    await settle();
    expect(ctx?.jobToken()).toBe(`job-token-${id}`);
    state.config = centralConfig({
      jobTokens: [{ jobId: id, token: "fresh", expiresIn: 900, kind: "legacy" }],
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ctx?.jobToken()).toBe("fresh");
    expect(ctx?.env().OMNIRALPH_JOB_TOKEN).toBe("fresh");
    // A legacy job's session uses its single token.
    expect(ctx?.sessionToken()).toBe("fresh");
    expect(ctx?.sessionEnv().OMNIRALPH_JOB_TOKEN).toBe("fresh");
    gate.resolve();
    await settle();
    await daemon.shutdown();
  });

  it("keeps a run-spec job's lifecycle token out of its session env", async () => {
    const id = randomUUID();
    const gate = deferred();
    let ctx: JobContext | undefined;
    const { state, claims, daemon } = setup({
      runQueryTask: async (_spec, c) => {
        ctx = c;
        await gate.promise;
        return {};
      },
    });
    // The task ID makes it a run-spec job.
    claims.push(job(id, { taskType: "query", taskId: "builtin:learn-rule" }));
    void daemon.run();
    await settle();

    const sessionEnvLeaks = async (lifecycle: string) => {
      const env = ctx!.sessionEnv({ EXTRA: "1" });
      const file = await readFile(env.OMNIRALPH_JOB_TOKEN_FILE!, "utf8");
      return Object.values(env).some((v) => v?.includes(lifecycle)) || file.includes(lifecycle);
    };
    expect(ctx?.runSpec).toMatchObject({ jobId: id, task: { id: "builtin:learn-rule" } });
    expect(ctx?.jobToken()).toBe(`lifecycle-${id}`);
    expect(ctx?.env().OMNIRALPH_JOB_TOKEN).toBe(`lifecycle-${id}`);
    expect(ctx?.sessionToken()).toBe(`session-${id}`);
    const env = ctx!.sessionEnv();
    expect(env.OMNIRALPH_JOB_TOKEN).toBe(`session-${id}`);
    const tokenFile = env.OMNIRALPH_JOB_TOKEN_FILE!;
    expect(await readFile(tokenFile, "utf8")).toBe(`session-${id}`);
    expect(await sessionEnvLeaks(`lifecycle-${id}`)).toBe(false);

    // Heartbeats refresh both tokens by kind; the session env follows the session token only.
    state.config = centralConfig({
      jobTokens: [
        { jobId: id, token: "lifecycle-fresh", expiresIn: 900, kind: "lifecycle" },
        { jobId: id, token: "session-fresh", expiresIn: 900, kind: "session" },
      ],
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ctx?.jobToken()).toBe("lifecycle-fresh");
    expect(ctx?.env().OMNIRALPH_JOB_TOKEN).toBe("lifecycle-fresh");
    expect(ctx?.sessionToken()).toBe("session-fresh");
    expect(await readFile(tokenFile, "utf8")).toBe("session-fresh");
    expect(ctx?.sessionEnv().OMNIRALPH_JOB_TOKEN).toBe("session-fresh");
    expect(await sessionEnvLeaks("lifecycle-fresh")).toBe(false);

    gate.resolve();
    await settle();
    // The session token file goes with the job.
    await expect(readFile(tokenFile, "utf8")).rejects.toThrow();
    await daemon.shutdown();
  });

  it("runs a query run through the query lifecycle and legacy jobs through their capability", async () => {
    const [runId, legacyId] = [randomUUID(), randomUUID()];
    const capabilityRun = vi.fn(async (j: JobPayload) => ({ legacy: j.id }));
    const runQueryTask = vi.fn(async (spec: RunSpec, c: JobContext) => ({
      query: spec.jobId,
      sameSpec: c.runSpec === spec,
      dataDir: c.dataDir,
      // The daemon's negotiated host tool paths (none negotiated in this test).
      hostTool: c.hostToolPath?.("opengrep"),
      // The local config's blockedExecPaths.
      blocked: [
        await c.execPathBlocked?.("/opt/blocked/bin/tool"),
        await c.execPathBlocked?.("/opt/fine/bin/tool"),
      ],
    }));
    const { api, claims, daemon } = setup({
      run: capabilityRun,
      runQueryTask,
      dataDir: "/data/omniralph",
      localConfig: { blockedExecPaths: ["/opt/blocked"] },
    });
    // A run-spec job of a legacy type: dispatched by its run spec, not its type.
    claims.push(job(runId, { taskType: "query", taskId: "builtin:test-task" }));
    claims.push(job(legacyId));
    void daemon.run();
    await settle();
    // execPathBlocked does real fs I/O (realpath).
    await vi.waitFor(() => expect(api.submitResult).toHaveBeenCalledTimes(2));
    expect(runQueryTask).toHaveBeenCalledTimes(1);
    expect(runQueryTask.mock.calls[0]?.[0]).toMatchObject({ jobId: runId, taskType: "query" });
    expect(api.submitResult).toHaveBeenCalledWith(runId, {
      result: {
        query: runId,
        sameSpec: true,
        dataDir: "/data/omniralph",
        hostTool: null,
        blocked: [true, false],
      },
    });
    expect(capabilityRun).toHaveBeenCalledTimes(1);
    expect(capabilityRun.mock.calls[0]?.[0]).toMatchObject({ id: legacyId });
    expect(api.submitResult).toHaveBeenCalledWith(legacyId, { result: { legacy: legacyId } });
    await daemon.shutdown();
  });

  it("runs a review run through the review lifecycle", async () => {
    const id = randomUUID();
    const runQueryTask = vi.fn(async () => ({}));
    const runReviewTask = vi.fn(async (spec: RunSpec) => ({ review: spec.jobId }));
    const { api, claims, daemon } = setup({ runQueryTask, runReviewTask });
    claims.push(job(id, { taskType: "review", taskId: "builtin:test-task" }));
    void daemon.run();
    await settle();
    expect(runReviewTask).toHaveBeenCalledTimes(1);
    expect(runReviewTask.mock.calls[0]?.[0]).toMatchObject({ jobId: id, taskType: "review" });
    expect(api.submitResult).toHaveBeenCalledWith(id, { result: { review: id } });
    expect(runQueryTask).not.toHaveBeenCalled();
    await daemon.shutdown();
  });

  it("runs a coding run through the coding lifecycle, not the legacy capability", async () => {
    const id = randomUUID();
    const capabilityRun = vi.fn(async () => ({}));
    const runCodingTask = vi.fn(async (spec: RunSpec) => ({ coding: spec.jobId }));
    const { api, claims, daemon } = setup({ run: capabilityRun, runCodingTask });
    claims.push(job(id, { type: "ralph.story", taskType: "coding", taskId: "builtin:test-task" }));
    void daemon.run();
    await settle();
    expect(runCodingTask).toHaveBeenCalledTimes(1);
    expect(runCodingTask.mock.calls[0]?.[0]).toMatchObject({ jobId: id, taskType: "coding" });
    expect(api.submitResult).toHaveBeenCalledWith(id, { result: { coding: id } });
    expect(capabilityRun).not.toHaveBeenCalled();
    await daemon.shutdown();
  });

  it("ignores a session token refresh for a legacy job", async () => {
    const id = randomUUID();
    const gate = deferred();
    let ctx: JobContext | undefined;
    const { state, claims, daemon } = setup({
      run: async (_j, c) => {
        ctx = c;
        await gate.promise;
        return {};
      },
    });
    claims.push(job(id));
    void daemon.run();
    await settle();
    state.config = centralConfig({
      jobTokens: [{ jobId: id, token: "session-fresh", expiresIn: 900, kind: "session" }],
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ctx?.jobToken()).toBe(`job-token-${id}`);
    expect(ctx?.sessionToken()).toBe(`job-token-${id}`);
    expect(ctx?.runSpec).toBeUndefined();
    gate.resolve();
    await settle();
    await daemon.shutdown();
  });

  it("injects jobMessages into the job's live session and acknowledges them in the next heartbeat", async () => {
    const id = randomUUID();
    const [first, second, unknown, late] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const injected: string[] = [];
    const sessionOpen = deferred();
    const sessionEnd = deferred();
    const gate = deferred();
    const { api, state, claims, daemon } = setup({
      run: async (_job, ctx) => {
        ctx.setMessageInjector?.((text) => {
          injected.push(text);
          return true;
        });
        sessionOpen.resolve();
        await sessionEnd.promise;
        // Past the session (e.g. running the quality gates): nothing can be injected.
        ctx.setMessageInjector?.(undefined);
        await gate.promise;
        return {};
      },
    });
    claims.push(job(id));
    void daemon.run();
    await settle();
    await sessionOpen.promise;

    state.config = {
      ...state.config,
      jobMessages: [
        { jobId: id, messageId: first, text: "Use a smallint column" },
        { jobId: randomUUID(), messageId: unknown, text: "not ours" },
      ],
    };
    await daemon.heartbeat();
    expect(injected).toEqual(["Use a smallint column"]);

    // The control panel resends a message until it sees the acknowledgement: injected once.
    state.config = {
      ...state.config,
      jobMessages: [
        { jobId: id, messageId: first, text: "Use a smallint column" },
        { jobId: id, messageId: second, text: "how is it going?" },
      ],
    };
    await daemon.heartbeat();
    expect(injected).toEqual(["Use a smallint column", "how is it going?"]);
    expect(api.heartbeat).toHaveBeenLastCalledWith(
      expect.objectContaining({ deliveredMessageIds: [first], rejectedMessageIds: [unknown] }),
    );
    state.config = { ...state.config, jobMessages: [] };
    await daemon.heartbeat();
    expect(api.heartbeat).toHaveBeenLastCalledWith(
      expect.objectContaining({ deliveredMessageIds: [second], rejectedMessageIds: [] }),
    );

    // No live session: rejected, and acknowledged before the job's outcome is reported.
    sessionEnd.resolve();
    await settle();
    state.config = {
      ...state.config,
      jobMessages: [{ jobId: id, messageId: late, text: "too late" }],
    };
    await daemon.heartbeat();
    state.config = { ...state.config, jobMessages: [] };
    expect(injected).toHaveLength(2);
    const before = api.heartbeat.mock.calls.length;
    gate.resolve();
    await settle();
    expect(api.heartbeat.mock.calls.length).toBe(before + 1);
    expect(api.heartbeat).toHaveBeenLastCalledWith(
      expect.objectContaining({ deliveredMessageIds: [], rejectedMessageIds: [late] }),
    );
    expect(api.heartbeat.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      api.submitResult.mock.invocationCallOrder.at(-1)!,
    );
    await daemon.shutdown();
  });

  it("keeps acknowledgements whose heartbeat failed for the next one", async () => {
    const id = randomUUID();
    const messageId = randomUUID();
    const gate = deferred();
    const { api, state, claims, daemon } = setup({
      run: async (_job, ctx) => {
        ctx.setMessageInjector?.(() => true);
        await gate.promise;
        return {};
      },
    });
    claims.push(job(id));
    void daemon.run();
    await settle();
    state.config = { ...state.config, jobMessages: [{ jobId: id, messageId, text: "hi" }] };
    await daemon.heartbeat();
    state.config = { ...state.config, jobMessages: [] };
    api.heartbeat.mockRejectedValueOnce(new ApiError(503, undefined, "down"));
    await daemon.heartbeat();
    await daemon.heartbeat();
    expect(api.heartbeat).toHaveBeenLastCalledWith(
      expect.objectContaining({ deliveredMessageIds: [messageId] }),
    );
    await daemon.heartbeat();
    expect(api.heartbeat).toHaveBeenLastCalledWith(
      expect.objectContaining({ deliveredMessageIds: [] }),
    );
    gate.resolve();
    await settle();
    await daemon.shutdown();
  });

  it("records each attempt in the history and tees its sessions into the attempt's tail", async () => {
    const [codingId, failingId, canceledId] = [randomUUID(), randomUUID(), randomUUID()];
    const history = new AttemptHistory({ logger: silentLogger() });
    let release!: () => void;
    const runCodingTask = vi.fn(async (_spec: RunSpec, c: JobContext) => {
      // The lifecycle's session runner, wrapped by the daemon's tee.
      const runner = c.sessions!.runner(async (request) => {
        request.onEvent?.({ type: "text", text: "Reading the PRD." });
        return { stop: "completed", output: "", usage: { inputTokens: 0, outputTokens: 0 } };
      });
      const relayed: string[] = [];
      await runner(
        sessionRequest({
          onEvent: (event) => relayed.push(event.type),
        }),
      );
      await new Promise<void>((resolve) => (release = resolve));
      return { relayed };
    });
    const { api, state, claims, daemon } = setup({
      local: { maxConcurrency: 3 },
      history,
      runCodingTask,
      run: async (j, ctx) => {
        if (j.id === failingId) throw new Error("the gate failed");
        return new Promise((_resolve, reject) =>
          ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason)),
        );
      },
    });
    api.submitFailure.mockResolvedValue({ status: "failed" });
    claims.push(
      job(codingId, { type: "ralph.story", taskType: "coding", pool: "long", taskId: "builtin:t" }),
    );
    claims.push(job(failingId));
    claims.push(job(canceledId));
    void daemon.run();
    await settle();

    expect(history.running().map((a) => a.id)).toEqual([codingId, canceledId]);
    expect(history.get(codingId)).toMatchObject({
      type: "ralph.story",
      outcome: null,
      label: "Building this run",
      events: [{ type: "thought", body: "Reading the PRD.", parameter: null }],
    });
    expect(history.get(failingId)).toMatchObject({
      outcome: "failed",
      error: "the gate failed",
    });
    expect(history.get(failingId)!.label).not.toContain("review.run");

    state.config = centralConfig({ cancelJobIds: [canceledId] });
    await vi.advanceTimersByTimeAsync(20_000);
    await settle();
    expect(history.get(canceledId)).toMatchObject({ outcome: "canceled", error: null });

    release();
    await settle();
    expect(api.submitResult).toHaveBeenCalledWith(codingId, { result: { relayed: ["text"] } });
    expect(history.running()).toEqual([]);
    expect(history.recent().map((a) => [a.id, a.outcome])).toEqual([
      [codingId, "completed"],
      [canceledId, "canceled"],
      [failingId, "failed"],
    ]);
    expect(history.get(codingId)!.events).toHaveLength(1);
    await daemon.shutdown();
    await history.close();
  });

  it("aborts a job listed in cancelJobIds and reports it canceled", async () => {
    const id = randomUUID();
    let signal: AbortSignal | undefined;
    const { api, state, claims, daemon } = setup({
      run: (_j, ctx) =>
        new Promise((_resolve, reject) => {
          signal = ctx.signal;
          ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason));
        }),
    });
    api.submitFailure.mockResolvedValueOnce({ status: "canceled" });
    claims.push(job(id));
    void daemon.run();
    await settle();
    expect(signal?.aborted).toBe(false);

    state.config = centralConfig({ cancelJobIds: [id, randomUUID()] });
    await vi.advanceTimersByTimeAsync(20_000);
    await settle();
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBeInstanceOf(JobCanceled);
    expect(api.submitFailure).toHaveBeenCalledWith(id, { retryable: false, error: "canceled" });
    expect(daemon.status().runningJobIds).toEqual([]);
    await daemon.shutdown();
  });

  it("on SIGTERM aborts the claim and the jobs, and exits without reporting them", async () => {
    const id = randomUUID();
    let signal: AbortSignal | undefined;
    const { api, claims, daemon } = setup({
      local: { maxConcurrency: 2 },
      run: (_j, ctx) =>
        new Promise((_resolve, reject) => {
          signal = ctx.signal;
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    claims.push(job(id));
    const exit = daemon.run();
    await settle();
    expect(claims.inFlight).toBe(1);
    const polls = claims.calls.length;
    const heartbeats = api.heartbeat.mock.calls.length;

    await daemon.shutdown();
    expect(await exit).toBe(0);
    expect(claims.inFlight).toBe(0);
    expect(claims.aborted).toEqual([["short", "long"]]);
    expect(signal?.reason).toBeInstanceOf(ShutdownAbort);
    expect(api.submitFailure).not.toHaveBeenCalled();
    expect(api.submitResult).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(claims.calls.length).toBe(polls);
    expect(api.heartbeat.mock.calls.length).toBe(heartbeats);
  });

  it("on SIGTERM lets jobs finish within 60s and reports them", async () => {
    const id = randomUUID();
    const { api, claims, daemon } = setup({
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30_000));
        return { done: true };
      },
    });
    claims.push(job(id));
    const exit = daemon.run();
    await settle();
    let exited = false;
    void exit.then(() => (exited = true));
    const shutdown = daemon.shutdown();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(exited).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await shutdown;
    expect(await exit).toBe(0);
    expect(api.submitResult).toHaveBeenCalledWith(id, { result: { done: true } });
  });

  it("on SIGTERM gives up after 60s and leaves unfinished jobs unreported", async () => {
    const { api, claims, daemon } = setup({ run: () => new Promise(() => {}) });
    claims.push(job(randomUUID()));
    const exit = daemon.run();
    await settle();
    let exited = false;
    void exit.then(() => (exited = true));
    void daemon.shutdown();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(exited).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await exit).toBe(0);
    expect(api.submitResult).not.toHaveBeenCalled();
    expect(api.submitFailure).not.toHaveBeenCalled();
  });

  it("doesn't start a job claimed as shutdown began", async () => {
    const run = vi.fn(async () => ({}));
    const { api, daemon } = setup({ run });
    const claimed = deferred();
    const id = randomUUID();
    // A claim whose response was already on its way when the claim was aborted.
    api.claim.mockImplementationOnce(async () => {
      await claimed.promise;
      return runResponse(job(id));
    });
    void daemon.run();
    await settle();
    await daemon.shutdown();
    claimed.resolve();
    await settle();
    expect(run).not.toHaveBeenCalled();
    expect(api.submitResult).not.toHaveBeenCalled();
    expect(api.submitFailure).not.toHaveBeenCalled();
    expect(api.claim).toHaveBeenCalledTimes(1);
  });

  it("fail() stops everything and exits non-zero", async () => {
    const { claims, daemon } = setup({});
    const exit = daemon.run();
    await settle();
    daemon.fail(new Error("re-enrollment required"));
    expect(await exit).toBe(1);
    expect(claims.inFlight).toBe(0);
    const polls = claims.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(claims.calls.length).toBe(polls);
  });
});

describe("self-update", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "omniralph-daemon-update-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function updater(installs: string[], underPm2 = true) {
    return new SelfUpdater({
      statePath: path.join(dir, "update-state.json"),
      runningVersion: "1.2.3",
      underPm2,
      installer: { install: async (version) => void installs.push(version) },
      logger: silentLogger(),
    });
  }

  it("drains (no new jobs, running ones finish), installs and exits for pm2", async () => {
    const first = randomUUID();
    const second = randomUUID();
    const gate = deferred();
    const installs: string[] = [];
    const { api, claims, state, daemon } = setup({
      local: { maxConcurrency: 2 },
      run: async (j) => {
        if (j.id === first) await gate.promise;
        return {};
      },
      updater: updater(installs),
    });
    claims.push(job(first));
    const exit = daemon.run();
    await settle();
    expect(daemon.status().runningJobIds).toEqual([first]);

    state.config = centralConfig({ desiredVersion: "2.0.0" });
    await vi.advanceTimersByTimeAsync(20_000);
    await settle();
    expect(daemon.status().draining).toBe(true);
    // Draining aborted the in-flight claim.
    expect(claims.inFlight).toBe(0);
    expect(claims.aborted).toEqual([["short", "long"]]);
    // The next heartbeat reports the drain.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.heartbeat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        selfUpdate: "supported",
        freeSlots: 0,
        update: expect.objectContaining({ state: "draining", version: "2.0.0", previous: "1.2.3" }),
      }),
    );
    // A job queued meanwhile isn't taken; heartbeats go on.
    claims.push(job(second));
    const polls = claims.calls.length;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(claims.calls.length).toBe(polls);
    expect(api.submitResult).not.toHaveBeenCalledWith(second, expect.anything());
    expect(installs).toEqual([]);

    gate.resolve();
    expect(await exit).toBe(0);
    expect(api.submitResult).toHaveBeenCalledWith(first, { result: {} });
    expect(installs).toEqual(["2.0.0"]);
    expect(await readUpdateState(path.join(dir, "update-state.json"))).toMatchObject({
      previous: "1.2.3",
      pending: "2.0.0",
      startsSincePending: 0,
    });
  });

  it("aborts jobs still running after 2 hours, unreported so they're redelivered, then updates", async () => {
    const id = randomUUID();
    const installs: string[] = [];
    let signal: AbortSignal | undefined;
    const { api, claims, state, daemon } = setup({
      config: centralConfig({ desiredVersion: "2.0.0" }),
      run: (_j, ctx) =>
        new Promise((_resolve, reject) => {
          signal = ctx.signal;
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      updater: updater(installs),
    });
    // The first heartbeat has no desired version, so the job starts.
    state.config = centralConfig();
    claims.push(job(id));
    const exit = daemon.run();
    await settle();
    expect(daemon.status().runningJobIds).toEqual([id]);
    state.config = centralConfig({ desiredVersion: "2.0.0" });

    await vi.advanceTimersByTimeAsync(20_000 + 2 * 60 * 60_000 - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(signal?.reason).toBeInstanceOf(ShutdownAbort);
    expect(await exit).toBe(0);
    expect(installs).toEqual(["2.0.0"]);
    expect(api.submitFailure).not.toHaveBeenCalled();
    expect(api.submitResult).not.toHaveBeenCalled();
  });

  it("takes jobs again when the install fails", async () => {
    const id = randomUUID();
    let attempted = false;
    const { api, claims, daemon } = setup({
      config: centralConfig({ desiredVersion: "2.0.0" }),
      updater: new SelfUpdater({
        statePath: path.join(dir, "update-state.json"),
        runningVersion: "1.2.3",
        underPm2: true,
        installer: {
          install: async () => {
            attempted = true;
            throw new Error("E404");
          },
        },
        logger: silentLogger(),
      }),
    });
    void daemon.run();
    await vi.waitFor(() => expect(attempted && !daemon.status().draining).toBe(true));
    claims.push(job(id));
    await settle();
    expect(api.submitResult).toHaveBeenCalledWith(id, { result: { ok: true } });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.heartbeat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        failedVersions: ["2.0.0"],
        update: expect.objectContaining({ state: "idle", error: "Installing 2.0.0 failed: E404" }),
      }),
    );
    await daemon.shutdown();
  });

  it("reports unsupported and keeps working when not under pm2", async () => {
    const installs: string[] = [];
    const { api, daemon } = setup({
      config: centralConfig({ desiredVersion: "2.0.0" }),
      updater: updater(installs, false),
    });
    void daemon.run();
    await settle();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(daemon.status().draining).toBe(false);
    expect(installs).toEqual([]);
    expect(api.heartbeat).toHaveBeenLastCalledWith(
      expect.objectContaining({ selfUpdate: "unsupported", freeSlots: 1 }),
    );
    await daemon.shutdown();
  });
});

describe("AgentDaemon wake mode", () => {
  const ABLY = { token: "ably-jwt", expiresAt: "2026-10-16T00:00:00.000Z" };

  /** A daemon whose first heartbeat hands over an Ably token. */
  async function started(
    options: Parameters<typeof setup>[0] & { connect?: boolean } = {},
  ): Promise<ReturnType<typeof setup>> {
    const result = setup({ wake: true, config: centralConfig({ ably: ABLY }), ...options });
    void result.daemon.run();
    await settle();
    if (options.connect ?? true) {
      result.wakes[0]!.emit("connected");
      await settle();
    }
    return result;
  }

  it("opens the wake subscription on a token and claims without waiting once connected", async () => {
    const { api, claims, daemon, wakes } = await started({ connect: false });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.organizationId).toBe(ORG_ID);
    expect(wakes[0]!.tokens).toEqual([ABLY]);
    expect(claims.calls).toEqual([]);

    wakes[0]!.emit("connected");
    await settle();
    expect(api.claim).toHaveBeenCalledWith(
      { pools: ["short", "long"], acceptedTaskTypes: ALL_TYPES, waitSeconds: 0 },
      expect.any(AbortSignal),
    );
    // No job: nothing more until a trigger, heartbeats or not.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(claims.calls).toEqual([["short", "long"]]);
    expect(wakes[0]!.tokens).toHaveLength(4);
    await daemon.shutdown();
  });

  it("reports its token's expiry and, with a free slot, its claimable pools in the heartbeat", async () => {
    const gate = deferred();
    const { api, claims, daemon, wakes } = await started({
      run: () => gate.promise.then(() => ({})),
    });
    expect(api.heartbeat.mock.calls[0]![0]).not.toHaveProperty("ablyTokenExpiresAt");
    expect(api.heartbeat.mock.calls[0]![0]).not.toHaveProperty("claimablePools");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.heartbeat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ablyTokenExpiresAt: ABLY.expiresAt,
        claimablePools: ["short", "long"],
      }),
    );

    claims.push(job(randomUUID()));
    wakes[0]!.emit("wake");
    await settle();
    expect(daemon.status().runningJobIds).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20_000);
    const last = api.heartbeat.mock.lastCall![0];
    expect(last).toMatchObject({ ablyTokenExpiresAt: ABLY.expiresAt, freeSlots: 0 });
    expect(last).not.toHaveProperty("claimablePools");
    gate.resolve();
    await daemon.shutdown();
  });

  it("claims on a wake, again at once after a job, and when a job ends", async () => {
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const { claims, daemon, wakes } = await started({
      local: { maxConcurrency: 2 },
      run: async (j) => {
        const gate = deferred();
        gates.set(j.id, gate);
        await gate.promise;
        return {};
      },
    });
    expect(claims.calls).toHaveLength(1);
    const ids = [randomUUID(), randomUUID()];
    claims.push(...ids.map((id) => job(id)));
    wakes[0]!.emit("wake");
    await settle();
    // Two jobs, then the agent is full: no third claim.
    expect(claims.calls).toHaveLength(3);
    expect(daemon.status().runningJobIds).toEqual(ids);

    wakes[0]!.emit("wake");
    await settle();
    expect(claims.calls).toHaveLength(3);

    gates.get(ids[0]!)!.resolve();
    await settle();
    expect(claims.calls).toHaveLength(4);
    expect(claims.waits).toEqual([0, 0, 0, 0]);
    expect(claims.inFlight).toBe(0);
    gates.get(ids[1]!)!.resolve();
    await daemon.shutdown();
  });

  it("claims when its claimable pools change", async () => {
    const { local, claims, daemon } = await started({
      local: { maxConcurrency: 1, acceptedTaskTypes: ["review"] },
    });
    expect(claims.calls).toEqual([["short"]]);
    local.set({ maxConcurrency: 1 });
    await settle();
    expect(claims.calls).toEqual([["short"], ["short", "long"]]);
    expect(claims.waits).toEqual([0, 0]);
    await daemon.shutdown();
  });

  it("claims on claimable: true from the heartbeat", async () => {
    const { state, claims, daemon } = await started();
    expect(claims.calls).toHaveLength(1);
    state.config = centralConfig({ claimable: false });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(claims.calls).toHaveLength(1);
    state.config = centralConfig({ claimable: true });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(claims.calls).toHaveLength(2);
    expect(claims.waits).toEqual([0, 0]);
    await daemon.shutdown();
  });

  it("while disconnected neither long-polls nor claims on other triggers, only on claimable: true", async () => {
    const { state, local, claims, daemon, wakes } = await started();
    expect(claims.calls).toHaveLength(1);
    wakes[0]!.emit("disconnected");
    wakes[0]!.emit("wake");
    local.set({ maxConcurrency: 1, acceptedTaskTypes: ["review"] });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(claims.calls).toHaveLength(1);

    state.config = centralConfig({ claimable: true });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(claims.calls).toHaveLength(2);
    expect(claims.waits).toEqual([0, 0]);

    // Reconnecting is a trigger of its own.
    wakes[0]!.emit("connected");
    await settle();
    expect(claims.calls).toHaveLength(3);
    await daemon.shutdown();
  });

  it("claims exactly once more after triggers that arrive while a claim is in flight", async () => {
    const gate = deferred();
    const { api, state, daemon, wakes } = await started({ connect: false });
    api.claim.mockImplementationOnce(async () => {
      await gate.promise;
      return null;
    });
    wakes[0]!.emit("connected");
    await settle();
    expect(api.claim).toHaveBeenCalledTimes(1);

    wakes[0]!.emit("wake");
    wakes[0]!.emit("wake");
    state.config = centralConfig({ claimable: true });
    await vi.advanceTimersByTimeAsync(20_000);
    wakes[0]!.emit("wake");
    expect(api.claim).toHaveBeenCalledTimes(1);

    gate.resolve();
    await settle();
    expect(api.claim).toHaveBeenCalledTimes(2);
    state.config = centralConfig();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.claim).toHaveBeenCalledTimes(2);
    await daemon.shutdown();
  });

  it("drops back to the long-poll on ably: null; an absent ably changes nothing", async () => {
    const { api, state, claims, daemon, wakes } = await started();
    state.config = centralConfig();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.closed).toBe(false);
    expect(claims.calls).toHaveLength(1);

    state.config = centralConfig({ ably: null });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(wakes[0]!.closed).toBe(true);
    expect(claims.waits).toEqual([0, undefined]);
    expect(claims.inFlight).toBe(1);

    await vi.advanceTimersByTimeAsync(20_000);
    const last = api.heartbeat.mock.lastCall![0];
    expect(last).not.toHaveProperty("ablyTokenExpiresAt");
    expect(last).not.toHaveProperty("claimablePools");
    await daemon.shutdown();
  });

  it("stops a long-poll in flight when a token arrives", async () => {
    const { state, claims, daemon, wakes } = setup({ wake: true });
    void daemon.run();
    await settle();
    expect(claims.inFlight).toBe(1);
    expect(claims.waits).toEqual([undefined]);

    state.config = centralConfig({ ably: ABLY });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(claims.aborted).toEqual([["short", "long"]]);
    expect(claims.inFlight).toBe(0);
    wakes[0]!.emit("connected");
    await settle();
    expect(claims.waits).toEqual([undefined, 0]);
    await daemon.shutdown();
  });

  it("ignores Ably tokens without a wake transport", async () => {
    const { api, claims, daemon } = setup({ config: centralConfig({ ably: ABLY }) });
    void daemon.run();
    await settle();
    expect(claims.waits).toEqual([undefined]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.heartbeat.mock.lastCall![0]).not.toHaveProperty("ablyTokenExpiresAt");
    await daemon.shutdown();
  });

  it("backs off on claim errors in wake mode", async () => {
    const { api, daemon, wakes } = await started({ connect: false });
    api.claim.mockRejectedValueOnce(new ApiError(503, undefined, "down"));
    api.claim.mockRejectedValueOnce(new ApiError(503, undefined, "down"));
    wakes[0]!.emit("connected");
    await settle();
    expect(api.claim).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(api.claim).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.claim).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(api.claim).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.claim).toHaveBeenCalledTimes(3);
    expect(api.claim).toHaveBeenLastCalledWith(
      { pools: ["short", "long"], acceptedTaskTypes: ALL_TYPES, waitSeconds: 0 },
      expect.any(AbortSignal),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.claim).toHaveBeenCalledTimes(3);
    await daemon.shutdown();
  });

  it("drain aborts the claim in flight and closes the subscription; resume reopens it", async () => {
    const { api, claims, daemon, wakes } = await started({ connect: false });
    let aborted = false;
    api.claim.mockImplementationOnce(
      (_body, signal) =>
        new Promise((_resolve, reject) =>
          signal!.addEventListener("abort", () => {
            aborted = true;
            reject(signal!.reason);
          }),
        ),
    );
    wakes[0]!.emit("connected");
    await settle();
    await daemon.drain(1_000);
    expect(aborted).toBe(true);
    expect(wakes[0]!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(wakes).toHaveLength(1);
    const last = api.heartbeat.mock.lastCall![0];
    expect(last).toMatchObject({ ablyTokenExpiresAt: ABLY.expiresAt });
    expect(last).not.toHaveProperty("claimablePools");
    expect(api.claim).toHaveBeenCalledTimes(1);

    daemon.resume();
    expect(wakes).toHaveLength(2);
    expect(wakes[1]!.tokens).toEqual([ABLY]);
    wakes[1]!.emit("connected");
    await settle();
    expect(claims.waits).toEqual([0]);
    expect(api.claim).toHaveBeenCalledTimes(2);
    await daemon.shutdown();
    expect(wakes[1]!.closed).toBe(true);
  });

  it("shutdown aborts the claim in flight and closes the subscription", async () => {
    const { api, daemon, wakes } = await started({ connect: false });
    let aborted = false;
    api.claim.mockImplementationOnce(
      (_body, signal) =>
        new Promise((_resolve, reject) =>
          signal!.addEventListener("abort", () => {
            aborted = true;
            reject(signal!.reason);
          }),
        ),
    );
    wakes[0]!.emit("connected");
    await settle();
    await daemon.shutdown();
    expect(aborted).toBe(true);
    expect(wakes[0]!.closed).toBe(true);
  });
});
