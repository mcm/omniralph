import {
  DEFAULT_POOLS,
  EMPTY_LOCAL_SETTINGS,
  HEARTBEAT_INTERVAL_SECONDS,
  effectiveLocalSettings,
  poolForTaskType,
  type AgentHostReport,
  type EffectiveLocalSettings,
  type Heartbeat,
  type HeartbeatResponse,
  type HostToolReport,
  type PinnedRepository,
  type JobFailure,
  type JobOutcomeResponse,
  type JobPayload,
  type JobStartResponse,
  type RunSpec,
} from "@omniralph/shared";
import type { TaskType } from "@omniralph/tasks";
import { ApiError, type ControlPanelApi } from "./api.js";
import type { AttemptHistory } from "./attempts/history.js";
import { ReenrollmentRequiredError } from "./auth.js";
import {
  RetryableJobError,
  type CapabilityRegistry,
  type JobContext,
  type JobOutput,
} from "./capabilities/index.js";
import { execPathBlocked, type AgentConfig } from "./config.js";
import { agentHost } from "./host.js";
import { HostToolPaths } from "./host-tools.js";
import { listInstalledInstallables } from "./installables.js";
import { ClaudeStatusReporter } from "./claude-status.js";
import { runCodingTask } from "./lifecycle/coding.js";
import { runQueryTask } from "./lifecycle/query.js";
import { runReviewTask } from "./lifecycle/review.js";
import { SystemRpcRegistry, defaultSystemRpcs, type SystemRpcContext } from "./rpc/index.js";
import { JOB_TOKEN_FILE_ENV, jobProcessEnv, spawnJobProcess } from "./job-env.js";
import type { Logger } from "./logger.js";
import type { SessionTee } from "./session/session.js";
import { SessionTokenFile } from "./session-token-file.js";
import type { DrainableDaemon, SelfUpdater } from "./update.js";
import { defaultCredentialHelper } from "./workspace/git.js";
import { RepoCache } from "./workspace/repoCache.js";
import type { WakeSubscription } from "./wake.js";

/** How long SIGTERM waits for running jobs before exiting. */
export const SHUTDOWN_GRACE_MS = 60_000;
/** First and longest back-off between claims after an API error. */
export const CLAIM_BACKOFF_MS = 1_000;
export const MAX_CLAIM_BACKOFF_MS = 30_000;
const REPORT_ATTEMPTS = 3;

/** Aborts a job because the agent is shutting down: no report; its lease lapses. */
export class ShutdownAbort extends Error {
  override name = "ShutdownAbort";
  constructor() {
    super("agent is shutting down");
  }
}

/** Aborts a job the control panel listed in `cancelJobIds`. */
export class JobCanceled extends Error {
  override name = "JobCanceled";
  constructor() {
    super("job canceled by the control panel");
  }
}

export interface DaemonOptions {
  server: string;
  workspaceRoot: string;
  /** The repo cache under `workspaceRoot` (default: one with this CLI's credential helper). */
  repos?: RepoCache;
  version: string;
  api: ControlPanelApi;
  /** Asked to refresh when an authenticated call gets 401. */
  tokens: { refresh(): Promise<string> };
  /** Runs legacy jobs (no run spec), by job type. */
  registry: CapabilityRegistry;
  /** Runs jobs of task type `system`, by job type (default: `defaultSystemRpcs()`). */
  rpcs?: SystemRpcRegistry;
  /** Runs claimed runs of task type `query` (default `runQueryTask`). */
  runQueryTask?: (spec: RunSpec, ctx: JobContext) => Promise<JobOutput>;
  /** Runs claimed runs of task type `review` (default `runReviewTask`). */
  runReviewTask?: (spec: RunSpec, ctx: JobContext) => Promise<JobOutput>;
  /** Runs claimed runs of task type `coding` (default `runCodingTask`). */
  runCodingTask?: (spec: RunSpec, ctx: JobContext) => Promise<JobOutput>;
  logger: Logger;
  heartbeatIntervalMs?: number;
  shutdownGraceMs?: number;
  /** Delay between attempts to report a job's outcome. */
  reportRetryDelayMs?: number;
  /**
   * The agent's data directory: the installables in its prefix are reported
   * in every heartbeat (none when unset).
   */
  dataDir?: string;
  /**
   * The local config: paths it blocks (`blockedExecPaths`) are never reported
   * as host tools, and no run executes a host tool, installable command or
   * installable MCP server under them.
   */
  localConfig?: Pick<AgentConfig, "blockedExecPaths">;
  /**
   * The machine settings (`settings.json`), read whenever they're needed: the
   * slots and pool limits cap the claims, the accepted task types go in every
   * heartbeat and claim (only their jobs, and `system` jobs, are claimed), and
   * every heartbeat reports them (`local`). On each `change` the daemon
   * re-checks its claim and heartbeats at once. Default: every default.
   */
  settings?: DaemonSettings;
  /** The `PATH` host tools are discovered on (default: the agent process's own `PATH`). */
  hostToolSearchPath?: () => string | undefined;
  /**
   * Claude's login state and models, reported in every heartbeat (`claude`
   * without the account, and `models`). Unset: no models and no `claude`.
   */
  claude?: Pick<ClaudeStatusReporter, "current">;
  /** The machine the agent runs on, reported in every heartbeat (default `agentHost()`). */
  host?: () => AgentHostReport;
  /**
   * Records each job's start and outcome, and tees its Claude sessions into
   * the attempt's live tail (`ctx.sessions`). Unset: nothing is recorded.
   */
  history?: Pick<AttemptHistory, "start" | "finish">;
  /** Self-update: reported in every heartbeat and told about each response. */
  updater?: Pick<SelfUpdater, "report" | "onHeartbeat">;
  /**
   * Opens the Ably wake subscription for the agent's organization, once a
   * heartbeat hands over an Ably token. Without it the agent always long-polls.
   */
  wakeSubscription?: (organizationId: string) => WakeSubscription;
  /** After each heartbeat, whether it got through or not (the agent page's live status). */
  onHeartbeat?: () => void;
}

/** The machine settings as the daemon reads them (a `LocalSettingsStore`). */
export interface DaemonSettings {
  /** The settings in force, every default filled in. */
  effective(): EffectiveLocalSettings;
  /** After each page save or hand edit of `settings.json`. */
  on(event: "change", listener: () => void): unknown;
  off(event: "change", listener: () => void): unknown;
}

/** Runs one claimed job with its context and returns its output. */
type JobHandler = (ctx: JobContext) => Promise<JobOutput>;

interface RunningJob {
  /** The pool whose slot the job takes; null for `system` jobs (they take a slot, but no pool's). */
  pool: string | null;
  controller: AbortController;
  /** The lifecycle token of a run-spec job (the agent's own), or a legacy job's single token. */
  jobToken: string;
  /** A run-spec job's session token, the only token its Claude session gets; unset for legacy jobs. */
  sessionToken?: string;
  /** `OMNIRALPH_JOB_TOKEN_FILE` of `sessionEnv()`, holding the session token. */
  sessionTokenFile: SessionTokenFile;
  /** Delivers a `jobMessages` message into the job's live session, while it has one. */
  injector?: (text: string) => boolean;
  /** A run-spec job's run, resolved by the control panel at claim time; unset for legacy jobs. */
  runSpec?: RunSpec;
  /** Tees the job's sessions into its attempt's tail (with a `history`). */
  sessions?: SessionTee;
}

/** A host tool as last checked (`DaemonHostTools`). */
export interface DaemonHostTool extends HostToolReport {
  /** The configured path it was checked with; null when it was looked up on `PATH`. */
  checkedPath: string | null;
  /** A playbook of the organization requires it. */
  required: boolean;
}

export interface DaemonHostTools {
  tools: DaemonHostTool[];
  /** The names the organization's playbooks require, sorted. */
  required: string[];
}

export interface DaemonVersionPolicy {
  kind: "latest" | "pinned";
  version: string;
}

/** Most message IDs one heartbeat acknowledges (per kind); the rest wait for the next one. */
const MAX_ACKS_PER_HEARTBEAT = 500;
/** Acknowledged message IDs remembered, so a message the control panel resends isn't injected twice. */
const ACKED_MESSAGES_KEPT = 1000;

export interface DaemonStatus {
  stopping: boolean;
  /** Taking no new jobs while running ones finish (for a self-update). */
  draining: boolean;
  connected: boolean;
  lastHeartbeatAt: string | null;
  /** When heartbeats started failing (the first failure since the last one that got through); null when the last got through. */
  unreachableSince: string | null;
  /** The control panel refused the agent's refresh token: it has to be enrolled again. */
  revoked: boolean;
  runningJobIds: string[];
  /** Its slots (`settings.json` `maxConcurrency`). */
  maxConcurrency: number;
}

/**
 * The agent's main loop: heartbeats (central config, cancellations, job
 * tokens; the control panel renews the running jobs' leases), a claim loop
 * that, while one of its local slots is free, long-polls for a job or (with an Ably token)
 * claims on wake signals, and the job lifecycle (claim → run → result/fail).
 */
export class AgentDaemon implements DrainableDaemon {
  private config: HeartbeatResponse | null = null;
  private lastHeartbeatAt: Date | null = null;
  private unreachableSince: Date | null = null;
  private revoked = false;
  private readonly running = new Map<string, RunningJob>();
  /** Running job handlers (for the shutdown wait). */
  private readonly handlers = new Set<Promise<unknown>>();
  /** The in-flight claim and the pools it asked for. */
  private claim: { controller: AbortController; pools: string[] } | null = null;
  /** Wakes the claim loop while it waits for a free slot. */
  private wakeClaimLoop: (() => void) | null = null;
  private claimBackoffMs = 0;
  private stopping = false;
  /** Set by `drain()`: no new claims until `resume()`. */
  private draining = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  /** A heartbeat of the loop is in flight. */
  private heartbeating = false;
  /** Asked for a heartbeat while one was in flight: send another right after it. */
  private heartbeatAgain = false;
  private readonly onSettingsChange = () => this.applyLocalSettings();
  private readonly sleepers = new Set<() => void>();
  private resolveExit!: (code: number) => void;
  private readonly exit = new Promise<number>((resolve) => (this.resolveExit = resolve));
  private readonly heartbeatIntervalMs: number;
  private readonly shutdownGraceMs: number;
  private readonly reportRetryDelayMs: number;
  private readonly rpcs: SystemRpcRegistry;
  private repoCache: RepoCache | undefined;
  /** `jobMessages` handled since the last heartbeat that got through: ID → job and whether it was injected. */
  private readonly pendingAcks = new Map<string, { jobId: string; delivered: boolean }>();
  /** Message IDs already acknowledged (oldest first). */
  private readonly ackedMessageIds = new Set<string>();
  private readonly hostTools: HostToolPaths;
  /** The latest Ably token from a heartbeat: while held, the agent is in wake mode (no long-poll). */
  private ablyToken: { token: string; expiresAt: string } | null = null;
  /** The open wake subscription and its organization (none while draining or stopping). */
  private wake: { subscription: WakeSubscription; organizationId: string } | null = null;
  private wakeConnected = false;
  /** In wake mode: a trigger asked for a claim the loop hasn't sent yet. */
  private claimRequested = false;
  /** The claimable pools `refreshClaim` last saw (to claim when they change). */
  private lastClaimablePools: string | null = null;

  constructor(private readonly options: DaemonOptions) {
    this.hostTools = new HostToolPaths({
      config: options.localConfig ?? {},
      configured: () => this.localSettings().hostTools,
      searchPath: options.hostToolSearchPath ?? (() => process.env.PATH),
      logger: options.logger,
    });
    this.repoCache = options.repos;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_SECONDS * 1000;
    this.shutdownGraceMs = options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;
    this.reportRetryDelayMs = options.reportRetryDelayMs ?? 2_000;
    this.rpcs = options.rpcs ?? new SystemRpcRegistry(defaultSystemRpcs());
  }

  /** Starts heartbeating and claiming. Resolves with the exit code once the daemon stops. */
  run(): Promise<number> {
    this.options.settings?.on("change", this.onSettingsChange);
    void this.heartbeatLoop();
    this.claimLoop().catch((error: unknown) =>
      this.fail(error instanceof Error ? error : new Error(String(error))),
    );
    return this.exit;
  }

  status(): DaemonStatus {
    return {
      stopping: this.stopping,
      draining: this.draining,
      connected: this.config !== null,
      lastHeartbeatAt: this.lastHeartbeatAt?.toISOString() ?? null,
      unreachableSince: this.unreachableSince?.toISOString() ?? null,
      revoked: this.revoked,
      runningJobIds: [...this.running.keys()],
      maxConcurrency: this.localSettings().maxConcurrency,
    };
  }

  /**
   * Heartbeats now instead of at the next interval (e.g. after a local
   * install, so Fleet sees the new installables at once). Does nothing
   * before `run()` or once stopping.
   */
  heartbeatSoon(): void {
    if (this.stopping || (!this.heartbeating && this.heartbeatTimer === null)) return;
    void this.heartbeatLoop();
  }

  /** The repositories the last heartbeat pinned to this agent (none before the first one). */
  pinnedRepositories(): PinnedRepository[] {
    return this.config?.pinnedRepositories ?? [];
  }

  /**
   * The host tools as last checked (each with the configured path it was
   * checked with, so the page tells a path saved since as still being checked)
   * and the names the organization's playbooks require (sorted; none before
   * the first heartbeat).
   */
  hostToolsState(): DaemonHostTools {
    const required = [...(this.config?.requiredHostTools ?? [])].sort();
    const tools = this.hostTools.checkedTools().map(({ configuredPath, report }) => ({
      ...report,
      checkedPath: configuredPath,
      required: required.includes(report.name),
    }));
    return { tools, required };
  }

  /**
   * The organization's version policy from the last heartbeat (`latest` with
   * the version it resolves to, or one `pinned` version); null when it has
   * none or before the first heartbeat.
   */
  versionPolicy(): DaemonVersionPolicy | null {
    const version = this.config?.desiredVersion ?? null;
    if (version === null) return null;
    return { kind: this.config?.versionPolicy ?? "pinned", version };
  }

  /**
   * The host tools the organization's playbooks require (the last heartbeat's
   * `requiredHostTools`) that this agent can't run, as last checked; sorted.
   */
  missingRequiredHostTools(): string[] {
    return (this.config?.requiredHostTools ?? [])
      .filter((name) => this.hostTools.path(name) === null)
      .sort();
  }

  /**
   * Graceful stop (SIGTERM): no more claims, running jobs are aborted and
   * get up to `shutdownGraceMs` to finish. Unfinished jobs aren't reported:
   * their leases lapse and the control panel hands them out again.
   */
  async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stop();
    for (const job of this.running.values()) job.controller.abort(new ShutdownAbort());
    if (this.handlers.size > 0) {
      this.options.logger.info(
        { runningJobs: this.running.size, graceMs: this.shutdownGraceMs },
        "shutting down; waiting for running jobs",
      );
      if (!(await this.waitForHandlers(this.shutdownGraceMs))) {
        this.options.logger.warn(
          { unfinishedJobIds: [...this.running.keys()] },
          "exiting with unfinished jobs; they will be redelivered once their leases lapse",
        );
      }
    }
    this.resolveExit(0);
  }

  /**
   * Stops taking jobs (for a self-update; the in-flight claim is aborted) and
   * waits up to `timeoutMs` for the running ones, then aborts the rest: they
   * aren't reported, so they're redelivered once their leases lapse.
   * Heartbeats go on, so running jobs keep their leases, tokens and messages.
   * Port of cyralph's `SessionManager.drain`.
   */
  async drain(timeoutMs: number): Promise<void> {
    this.draining = true;
    for (const wake of this.sleepers) wake();
    this.syncWakeSubscription();
    this.refreshClaim();
    if (this.handlers.size === 0) return;
    const log = this.options.logger;
    log.info({ runningJobs: this.running.size, timeoutMs }, "draining; waiting for running jobs");
    if (await this.waitForHandlers(timeoutMs)) return;
    if (this.stopping) return;
    log.warn(
      { abortedJobIds: [...this.running.keys()] },
      "drain timed out; aborting the running jobs, which will be redelivered",
    );
    for (const job of this.running.values()) job.controller.abort(new ShutdownAbort());
    if (!(await this.waitForHandlers(this.shutdownGraceMs))) {
      log.warn(
        { unfinishedJobIds: [...this.running.keys()] },
        "aborted jobs didn't finish in time; they will be redelivered",
      );
    }
  }

  /** Takes jobs again after `drain()`. */
  resume(): void {
    if (!this.draining) return;
    this.draining = false;
    this.options.logger.info("taking jobs again");
    this.syncWakeSubscription();
    this.refreshClaim();
  }

  /** Stops with exit code 0 after a self-update, so pm2 starts the new version. */
  exitForUpdate(): void {
    this.stop();
    for (const job of this.running.values()) job.controller.abort(new ShutdownAbort());
    this.resolveExit(0);
  }

  isStopping(): boolean {
    return this.stopping;
  }

  /** Waits for the running job handlers; false when `timeoutMs` passed first. */
  private async waitForHandlers(timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const finished = await Promise.race([
      Promise.allSettled([...this.handlers]).then(() => true),
      new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs))),
    ]);
    clearTimeout(timer);
    return finished;
  }

  /** Immediate stop with a non-zero exit code (e.g. re-enrollment required). */
  fail(error: Error): void {
    const wasStopping = this.stopping;
    if (error instanceof ReenrollmentRequiredError) this.revoked = true;
    this.stop();
    for (const job of this.running.values()) job.controller.abort(new ShutdownAbort());
    if (!wasStopping) this.options.logger.error({ err: error }, "agent stopped");
    this.resolveExit(1);
  }

  private stop(): void {
    this.stopping = true;
    this.options.settings?.off("change", this.onSettingsChange);
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const wake of this.sleepers) wake();
    this.syncWakeSubscription();
    this.refreshClaim();
  }

  // --- Heartbeat and central config -------------------------------------------------------

  /**
   * Heartbeats now, then every `heartbeatIntervalMs`. Called while one is in
   * flight, it sends another right after that one (and the interval restarts).
   */
  private async heartbeatLoop(): Promise<void> {
    if (this.stopping) return;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.heartbeating) {
      this.heartbeatAgain = true;
      return;
    }
    this.heartbeating = true;
    try {
      await this.heartbeat();
    } finally {
      this.heartbeating = false;
    }
    if (this.stopping) return;
    if (this.heartbeatAgain) {
      this.heartbeatAgain = false;
      void this.heartbeatLoop();
      return;
    }
    this.heartbeatTimer = setTimeout(() => void this.heartbeatLoop(), this.heartbeatIntervalMs);
  }

  /**
   * A `settings.json` change (a page save or a hand edit): the claim follows the new slots,
   * pool limits and kinds at once (lowering a limit cancels nothing), and a heartbeat
   * re-checks the host tools and reports everything without waiting for the interval.
   */
  private applyLocalSettings(): void {
    if (this.stopping) return;
    const local = this.localSettings();
    this.options.logger.info(
      {
        maxConcurrency: local.maxConcurrency,
        poolLimits: local.poolLimits,
        acceptedTaskTypes: local.acceptedTaskTypes,
        claimablePools: this.claimablePools(),
      },
      "applied local settings",
    );
    this.refreshClaim();
    void this.heartbeatLoop();
  }

  /** Sends one heartbeat and applies the response. */
  async heartbeat(): Promise<void> {
    const acks = [...this.pendingAcks];
    const ids = (delivered: boolean) =>
      acks
        .filter(([, ack]) => ack.delivered === delivered)
        .map(([id]) => id)
        .slice(0, MAX_ACKS_PER_HEARTBEAT);
    const deliveredMessageIds = ids(true);
    const rejectedMessageIds = ids(false);
    const installables = await this.installedInstallables();
    const hostTools = await this.checkHostTools();
    const claude = await this.options.claude?.current();
    const local = this.localSettings();
    try {
      const response = await this.options.api.heartbeat({
        version: this.options.version,
        runningJobIds: [...this.running.keys()],
        freeSlots: this.freeSlots(),
        deliveredMessageIds,
        rejectedMessageIds,
        failedVersions: [],
        installables,
        hostTools,
        models: claude?.models ?? [],
        ...(claude && { claude: ClaudeStatusReporter.report(claude) }),
        acceptedTaskTypes: local.acceptedTaskTypes,
        host: (this.options.host ?? (() => agentHost()))(),
        local: {
          maxConcurrency: local.maxConcurrency,
          poolLimits: { short: local.poolLimits.short, long: local.poolLimits.long },
          versionPin: local.versionPin,
          installablesAllow: local.installablesAllow,
        },
        ...this.options.updater?.report(),
        ...this.wakeReport(),
      });
      this.lastHeartbeatAt = new Date();
      this.unreachableSince = null;
      for (const id of [...deliveredMessageIds, ...rejectedMessageIds]) {
        this.pendingAcks.delete(id);
        this.ackedMessageIds.add(id);
      }
      for (const id of this.ackedMessageIds) {
        if (this.ackedMessageIds.size <= ACKED_MESSAGES_KEPT) break;
        this.ackedMessageIds.delete(id);
      }
      this.applyConfig(response);
      this.notifyUpdater(response);
    } catch (error) {
      this.unreachableSince ??= new Date();
      this.onApiError(error, "heartbeat failed");
      this.notifyUpdater(null);
    }
    try {
      this.options.onHeartbeat?.();
    } catch (error) {
      this.options.logger.warn({ err: error }, "heartbeat listener failed");
    }
  }

  /** The installables to report; none when they can't be listed (the heartbeat still goes out). */
  private async installedInstallables(): Promise<Heartbeat["installables"]> {
    if (this.options.dataDir === undefined) return [];
    try {
      return await listInstalledInstallables(this.options.dataDir, this.options.logger);
    } catch (error) {
      this.options.logger.warn({ err: error }, "cannot list installed installables");
      return [];
    }
  }

  /**
   * Checks the host tools configured in `settings.json` and the ones the last
   * heartbeat response asked about (`requiredHostTools`, none before the
   * first), and keeps their paths for `hostToolPath()`.
   */
  private async checkHostTools(): Promise<Heartbeat["hostTools"]> {
    try {
      return await this.hostTools.check(this.config?.requiredHostTools ?? []);
    } catch (error) {
      this.options.logger.warn({ err: error }, "cannot check host tools");
      return [];
    }
  }

  /**
   * The absolute path to run a host tool from, as last checked: its path in
   * `settings.json` when that's a usable executable, else the one discovered
   * on the agent's `PATH` when none is configured, else null (unavailable, or
   * its configured path changed since the check). Never a path covered by
   * `blockedExecPaths`.
   */
  hostToolPath(name: string): string | null {
    return this.hostTools.path(name);
  }

  private notifyUpdater(response: HeartbeatResponse | null): void {
    const updater = this.options.updater;
    if (!updater || this.stopping) return;
    updater.onHeartbeat(response, this).catch((error: unknown) => {
      this.options.logger.error({ err: error }, "self-update failed");
      this.resume();
    });
  }

  /**
   * Applies a heartbeat response without restarting anything. The deprecated
   * `topics`, `queueRegion` and `pollIntervalSeconds` are ignored.
   */
  applyConfig(config: HeartbeatResponse): void {
    const previous = this.config;
    this.config = config;
    if (!previous) {
      const local = this.localSettings();
      this.options.logger.info(
        {
          organizationId: config.organizationId,
          maxConcurrency: local.maxConcurrency,
          poolLimits: local.poolLimits,
          acceptedTaskTypes: local.acceptedTaskTypes,
          claimablePools: this.claimablePools(),
        },
        "connected to the control panel",
      );
    }
    for (const jobId of config.cancelJobIds) {
      const job = this.running.get(jobId);
      if (job && !job.controller.signal.aborted) {
        this.options.logger.info({ jobId }, "canceling job");
        job.controller.abort(new JobCanceled());
      }
    }
    for (const { jobId, token, kind } of config.jobTokens) {
      const job = this.running.get(jobId);
      if (!job) continue;
      if (kind === "session") {
        // Only a run-spec job has a session token to replace.
        if (job.sessionToken !== undefined) {
          job.sessionToken = token;
          job.sessionTokenFile.update(token);
        }
      } else {
        job.jobToken = token;
        // A legacy job's session uses its single token.
        if (job.sessionToken === undefined) job.sessionTokenFile.update(token);
      }
    }
    // Newly required host tools are checked and reported right away, not a heartbeat later.
    const required = config.requiredHostTools.join("\0");
    if (this.heartbeating && required !== (previous?.requiredHostTools.join("\0") ?? "")) {
      this.heartbeatAgain = true;
    }
    this.deliverMessages(config.jobMessages);
    this.applyAbly(config);
    this.refreshClaim();
    if (config.claimable === true) this.requestClaim("claimable");
  }

  /**
   * Injects each new message into its job's live session. The outcome is
   * acknowledged in the next heartbeat: delivered, or rejected when the job
   * has no live session (anymore) to take it.
   */
  private deliverMessages(messages: HeartbeatResponse["jobMessages"]): void {
    for (const { jobId, messageId, text } of messages) {
      if (this.pendingAcks.has(messageId) || this.ackedMessageIds.has(messageId)) continue;
      const delivered = this.running.get(jobId)?.injector?.(text) ?? false;
      this.pendingAcks.set(messageId, { jobId, delivered });
      this.options.logger.info(
        { jobId, messageId, delivered },
        delivered ? "delivered a message to the job's session" : "rejected a message for the job",
      );
    }
  }

  private onApiError(error: unknown, message: string): void {
    this.options.logger.warn({ err: error }, message);
    if (error instanceof ApiError && error.status === 401) {
      // A 401 from /token itself stops the daemon (TokenManager → fail()).
      this.options.tokens.refresh().catch(() => {});
    }
  }

  // --- Wake mode ------------------------------------------------------------------------

  /** In wake mode (holding an Ably token) the agent claims on triggers, never long-polling. */
  private wakeMode(): boolean {
    return this.ablyToken !== null;
  }

  /** The heartbeat's Ably fields: the held token's expiry, and in wake mode the pools to check. */
  private wakeReport(): Pick<Heartbeat, "ablyTokenExpiresAt" | "claimablePools"> {
    if (!this.ablyToken) return {};
    const pools = this.claimablePools();
    return {
      ablyTokenExpiresAt: this.ablyToken.expiresAt,
      ...(pools === null ? {} : { claimablePools: pools }),
    };
  }

  /**
   * A heartbeat's `ably`: a token starts (or keeps) wake mode, null drops back
   * to the long-poll, absent changes nothing.
   */
  private applyAbly(config: HeartbeatResponse): void {
    if (!this.options.wakeSubscription || config.ably === undefined) return;
    if (config.ably === null) {
      if (this.ablyToken) this.options.logger.info("Ably is off; long-polling for jobs");
      this.ablyToken = null;
    } else {
      const entering = this.ablyToken === null;
      this.ablyToken = { token: config.ably.token, expiresAt: config.ably.expiresAt };
      if (entering) {
        this.options.logger.info("claiming on Ably wake signals");
        // A long-poll in flight would hold its request open: claim on triggers instead.
        this.claim?.controller.abort();
      }
    }
    this.syncWakeSubscription();
    this.wakeClaimLoop?.();
  }

  /**
   * Opens the wake subscription while there's a token and jobs may be taken
   * (closes it otherwise, e.g. while draining) and hands it the latest token.
   */
  private syncWakeSubscription(): void {
    const create = this.options.wakeSubscription;
    const organizationId = this.config?.organizationId;
    const wanted =
      create !== undefined &&
      this.ablyToken !== null &&
      organizationId !== undefined &&
      !this.stopping &&
      !this.draining;
    if (this.wake && (!wanted || this.wake.organizationId !== organizationId)) {
      this.wake.subscription.close();
      this.wake = null;
      this.wakeConnected = false;
    }
    if (!wanted || !this.ablyToken) return;
    if (!this.wake) {
      let subscription: WakeSubscription;
      try {
        subscription = create(organizationId);
      } catch (error) {
        this.options.logger.warn({ err: error }, "cannot open the wake subscription; long-polling");
        this.ablyToken = null;
        return;
      }
      const wake = { subscription, organizationId };
      subscription.on("wake", () => this.requestClaim("wake"));
      subscription.on("connected", () => {
        if (this.wake !== wake) return;
        this.wakeConnected = true;
        this.requestClaim("connected");
      });
      subscription.on("disconnected", () => {
        if (this.wake === wake) this.wakeConnected = false;
      });
      this.wake = wake;
    }
    this.wake.subscription.setToken(this.ablyToken.token, this.ablyToken.expiresAt);
  }

  /**
   * A wake-mode trigger: claims once a slot is free. Coalesces: any number of
   * triggers during a claim cause one more claim after it. While the Ably
   * connection is down only the heartbeat's `claimable` counts.
   */
  private requestClaim(trigger: "wake" | "claimable" | "connected" | "job-ended" | "pools"): void {
    if (!this.wakeMode() || this.claimablePools() === null) return;
    if (trigger !== "claimable" && !this.wakeConnected) return;
    this.claimRequested = true;
    this.wakeClaimLoop?.();
  }

  // --- Claiming --------------------------------------------------------------------------

  /** The machine settings in force (`settings.json`), every default filled in. */
  private localSettings(): EffectiveLocalSettings {
    return this.options.settings?.effective() ?? effectiveLocalSettings(EMPTY_LOCAL_SETTINGS);
  }

  /**
   * The `DEFAULT_POOLS` the accepted task types run in (a job's pool follows from its task
   * type): no claim asks for a pool it would get no job from. None before the first heartbeat.
   */
  private pools(): string[] {
    if (!this.config) return [];
    const accepted = new Set<string>(this.acceptedTaskTypes().map((type) => poolForTaskType(type)));
    return DEFAULT_POOLS.filter((pool) => accepted.has(pool));
  }

  /** The task types the agent runs: `acceptedTaskTypes` of its settings, default all. */
  acceptedTaskTypes(): TaskType[] {
    return this.localSettings().acceptedTaskTypes;
  }

  /** How many of a pool's jobs may run at once: its local limit (0 for an unknown pool). */
  poolLimit(pool: string): number {
    const limits: Partial<Record<string, number>> = this.localSettings().poolLimits;
    return limits[pool] ?? 0;
  }

  private runningByPool(): Map<string, number> {
    const running = new Map<string, number>();
    for (const { pool } of this.running.values()) {
      if (pool !== null) running.set(pool, (running.get(pool) ?? 0) + 1);
    }
    return running;
  }

  /**
   * Jobs the agent could take right now: its free local slots (none while draining or
   * before the first heartbeat).
   */
  freeSlots(): number {
    if (!this.config || this.draining) return 0;
    return Math.max(0, this.localSettings().maxConcurrency - this.running.size);
  }

  /**
   * What to claim for now: the pools still under their limits, while a slot
   * is free (`system` jobs need no pool, so a claim with none still gets
   * them). Null while stopping, draining or without a free slot. A lowered
   * limit cancels nothing: the pool just isn't claimed until it's under it.
   */
  claimablePools(): string[] | null {
    if (this.stopping || this.freeSlots() === 0) return null;
    const running = this.runningByPool();
    return this.pools().filter((pool) => (running.get(pool) ?? 0) < this.poolLimit(pool));
  }

  /**
   * Re-checks what to claim: aborts the in-flight claim when it asked for
   * other pools (a limit, slot, drain or stop changed them) and wakes the
   * loop, which claims again with the current ones.
   */
  private refreshClaim(): void {
    const pools = this.claimablePools();
    if (this.claim && (pools === null || this.claim.pools.join() !== pools.join())) {
      this.claim.controller.abort();
    }
    const key = pools === null ? null : pools.join();
    if (key !== this.lastClaimablePools) {
      this.lastClaimablePools = key;
      this.requestClaim("pools");
    }
    this.wakeClaimLoop?.();
  }

  /**
   * One claim at a time while a slot is free, starting the job it gets and
   * claiming again at once. Long-polls without an Ably token; in wake mode
   * claims without waiting, only when a trigger asked (`requestClaim`).
   * Backs off (up to 30s) on API errors.
   */
  private async claimLoop(): Promise<void> {
    while (!this.stopping) {
      const pools = this.claimablePools();
      const wakeMode = this.wakeMode();
      // Triggers only count while a slot is free.
      if (pools === null) this.claimRequested = false;
      if (pools === null || (wakeMode && !this.claimRequested)) {
        await new Promise<void>((resolve) => (this.wakeClaimLoop = resolve));
        this.wakeClaimLoop = null;
        continue;
      }
      this.claimRequested = false;
      const controller = new AbortController();
      this.claim = { controller, pools };
      let start: JobStartResponse | null;
      try {
        const acceptedTaskTypes = this.acceptedTaskTypes();
        start = await this.options.api.claim(
          wakeMode ? { pools, acceptedTaskTypes, waitSeconds: 0 } : { pools, acceptedTaskTypes },
          controller.signal,
        );
        this.claimBackoffMs = 0;
      } catch (error) {
        if (controller.signal.aborted) continue;
        this.onApiError(error, "claim failed");
        // The trigger wasn't served: claim again after the back-off.
        if (wakeMode) this.claimRequested = true;
        this.claimBackoffMs = Math.min(
          MAX_CLAIM_BACKOFF_MS,
          Math.max(CLAIM_BACKOFF_MS, this.claimBackoffMs * 2),
        );
        await this.sleep(this.claimBackoffMs);
        continue;
      } finally {
        this.claim = null;
      }
      if (start) {
        this.startJob(start);
        // There may be more: claim again at once while a slot is free.
        if (wakeMode) this.claimRequested = true;
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.sleepers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.sleepers.add(wake);
    });
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.handlers.add(promise);
    const remove = () => this.handlers.delete(promise);
    promise.then(remove, remove);
    return promise;
  }

  // --- Job lifecycle ----------------------------------------------------------------------

  /**
   * Takes a claimed job's slot (synchronously, so the next claim already
   * counts it) and runs it in the background.
   */
  private startJob(start: JobStartResponse): void {
    const log = this.options.logger;
    if (start.action === "skip") {
      log.info({ reason: start.reason }, "skipping job");
      return;
    }
    const { job } = start;
    const jobLog = log.child({
      jobId: job.id,
      taskType: job.taskType,
      pool: job.pool,
      type: job.type,
    });
    if (this.stopping) {
      // Claimed as the agent stopped: the lease lapses and the job is redelivered.
      jobLog.info("not starting a job claimed during shutdown");
      return;
    }
    // System RPCs first (by job type), then run specs (by task type), then legacy capabilities.
    const system = job.taskType === "system";
    const run = system
      ? this.rpcHandler(job)
      : start.runSpec
        ? this.runSpecHandler(start.runSpec)
        : this.capabilityHandler(job);
    if (!run) {
      const error = system ? `unknown system RPC ${job.type}` : `unknown job type ${job.type}`;
      jobLog.error(system ? "unknown system RPC" : "unknown job type");
      void this.track(
        this.report(job.id, jobLog, () =>
          this.options.api.submitFailure(job.id, { retryable: false, error }),
        ),
      );
      return;
    }
    const running: RunningJob = {
      pool: job.pool,
      controller: new AbortController(),
      jobToken: start.jobToken.token,
      // A system RPC runs no session: it only ever gets the single job token.
      ...(system ? {} : { sessionToken: start.sessionToken?.token, runSpec: start.runSpec }),
      sessionTokenFile: new SessionTokenFile(),
    };
    const sessions = this.options.history?.start(job, running.runSpec);
    if (sessions) running.sessions = sessions;
    this.running.set(job.id, running);
    jobLog.info({ deliveryCount: job.deliveryCount }, "running job");
    void this.track(
      this.runJob(job, run, running, jobLog).catch((error: unknown) =>
        jobLog.error({ err: error }, "job handler failed"),
      ),
    );
  }

  /**
   * How a claimed run is run, by its task type: `query`, `review` and
   * `coding` through their fixed lifecycles; any other task type fails the run.
   */
  private runSpecHandler(spec: RunSpec): JobHandler {
    switch (spec.taskType) {
      case "query": {
        const runQuery = this.options.runQueryTask ?? runQueryTask;
        return (ctx) => runQuery(spec, ctx);
      }
      case "review": {
        const runReview = this.options.runReviewTask ?? runReviewTask;
        return (ctx) => runReview(spec, ctx);
      }
      case "coding": {
        const runCoding = this.options.runCodingTask ?? runCodingTask;
        return async (ctx) => ({ ...(await runCoding(spec, ctx)) });
      }
      default:
        return () => Promise.reject(new Error(`unsupported task type ${spec.taskType}`));
    }
  }

  /** A system job's RPC (by job type), or undefined for an unknown RPC. */
  private rpcHandler(job: JobPayload): JobHandler | undefined {
    const rpc = this.rpcs.get(job.type);
    return rpc && ((ctx) => rpc.run(job, systemRpcContext(ctx)));
  }

  /** A legacy job's capability code (by job type), or undefined for an unknown job type. */
  private capabilityHandler(job: JobPayload): JobHandler | undefined {
    const capability = this.options.registry.forJob(job);
    return capability && ((ctx) => capability.run(job, ctx));
  }

  /**
   * Runs a job and reports its outcome. A retryable failure is only reported:
   * the control panel makes the job claimable again after `retryAfterSeconds`.
   */
  private async runJob(
    job: JobPayload,
    run: JobHandler,
    running: RunningJob,
    jobLog: Logger,
  ): Promise<void> {
    let output: JobOutput | undefined;
    let failure: unknown;
    try {
      output = await run(this.jobContext(job, running, jobLog));
    } catch (error) {
      failure = error ?? new Error("job failed");
    } finally {
      this.running.delete(job.id);
      running.sessionTokenFile.close();
      this.refreshClaim();
      this.requestClaim("job-ended");
    }
    if ([...this.pendingAcks.values()].some((ack) => ack.jobId === job.id)) {
      // Acknowledge the job's messages before its outcome, so none is taken for undelivered.
      await this.heartbeat();
    }

    const reason: unknown = running.controller.signal.reason;
    const history = this.options.history;
    if (failure !== undefined && reason instanceof ShutdownAbort) {
      // Not reported: the lease lapses and the job is redelivered.
      jobLog.info("job interrupted by shutdown");
      history?.finish(job.id, "canceled", "The agent stopped before the attempt finished");
      return;
    }
    if (failure === undefined) {
      jobLog.info("job finished");
      history?.finish(job.id, "completed");
      await this.report(job.id, jobLog, () =>
        this.options.api.submitResult(job.id, { result: output ?? {} }),
      );
      return;
    }
    const body = failureBody(failure, reason);
    if (reason instanceof JobCanceled) history?.finish(job.id, "canceled");
    else history?.finish(job.id, "failed", body.error);
    jobLog.warn({ err: failure, retryable: body.retryable }, "job failed");
    await this.report(job.id, jobLog, () => this.options.api.submitFailure(job.id, body));
  }

  private jobContext(job: JobPayload, running: RunningJob, logger: Logger): JobContext {
    const { server, workspaceRoot } = this.options;
    const identity = () => ({ jobId: job.id, jobToken: running.jobToken, server });
    // A legacy job has one token, which its session uses too.
    const sessionToken = () => running.sessionToken ?? running.jobToken;
    return {
      signal: running.controller.signal,
      jobToken: () => running.jobToken,
      sessionToken,
      ...(running.runSpec ? { runSpec: running.runSpec } : {}),
      env: (extra) => jobProcessEnv(identity(), process.env, extra),
      sessionEnv: (extra) => {
        const token = sessionToken();
        return {
          ...jobProcessEnv({ jobId: job.id, jobToken: token, server }, process.env, extra),
          [JOB_TOKEN_FILE_ENV]: running.sessionTokenFile.path(token),
        };
      },
      spawn: (command, args, options) => spawnJobProcess(identity(), command, args, options),
      server,
      workspaceRoot,
      repos: this.repos(),
      logger,
      setMessageInjector: (inject) => {
        running.injector = inject;
      },
      hostToolPath: (name) => this.hostToolPath(name),
      execPathBlocked: (file) => execPathBlocked(this.options.localConfig ?? {}, file),
      ...(this.options.dataDir !== undefined && { dataDir: this.options.dataDir }),
      ...(running.sessions && { sessions: running.sessions }),
    };
  }

  private repos(): RepoCache {
    this.repoCache ??= new RepoCache({
      workspaceRoot: this.options.workspaceRoot,
      credentialHelper: defaultCredentialHelper(),
      logger: this.options.logger,
    });
    return this.repoCache;
  }

  /**
   * Reports a job's outcome. If reporting keeps failing the job stays
   * running without a heartbeat to renew its lease, so it runs again once
   * the lease lapses.
   */
  private async report(
    jobId: string,
    log: Logger,
    send: () => Promise<JobOutcomeResponse>,
  ): Promise<void> {
    let outcome: JobOutcomeResponse | undefined;
    for (let attempt = 1; !outcome; attempt++) {
      try {
        outcome = await send();
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          // The job was redelivered to (and started by) another agent; our lease is gone.
          log.warn("job is no longer ours; dropping the outcome");
          return;
        }
        if (error instanceof ApiError && error.status === 404) {
          log.warn("job no longer exists");
          return;
        }
        this.onApiError(error, "reporting the job outcome failed");
        if (attempt >= REPORT_ATTEMPTS) {
          log.warn("giving up reporting the outcome; the job will be redelivered");
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, this.reportRetryDelayMs * attempt));
      }
    }
    log.info({ jobId, status: outcome.status }, "job outcome recorded");
  }
}

/** The part of a job's context a system RPC gets: no session token, session env or run spec. */
function systemRpcContext(ctx: JobContext): SystemRpcContext {
  const { signal, jobToken, env, spawn, server, workspaceRoot, repos, logger } = ctx;
  return { signal, jobToken, env, spawn, server, workspaceRoot, repos, logger };
}

function failureBody(error: unknown, abortReason: unknown): JobFailure {
  if (abortReason instanceof JobCanceled) {
    return { retryable: false, error: "canceled" };
  }
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 4000);
  if (error instanceof RetryableJobError) {
    return {
      retryable: true,
      error: message,
      ...(error.retryAfterSeconds !== undefined && {
        retryAfterSeconds: Math.min(3600, Math.max(0, Math.round(error.retryAfterSeconds))),
      }),
    };
  }
  return { retryable: false, error: message };
}
