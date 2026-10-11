import {
  HEARTBEAT_INTERVAL_SECONDS,
  effectivePoolLimit,
  type HeartbeatResponse,
  type JobFailure,
  type JobOutcomeResponse,
  type JobPayload,
  type JobStartResponse,
} from "@omniralph/shared";
import { ApiError, type ControlPanelApi } from "./api.js";
import {
  RetryableJobError,
  type Capability,
  type CapabilityRegistry,
  type JobContext,
  type JobOutput,
} from "./capabilities/index.js";
import { jobProcessEnv, spawnJobProcess } from "./job-env.js";
import type { Logger } from "./logger.js";
import type { DrainableDaemon, SelfUpdater } from "./update.js";
import { defaultCredentialHelper } from "./workspace/git.js";
import { RepoCache } from "./workspace/repoCache.js";

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
  registry: CapabilityRegistry;
  logger: Logger;
  heartbeatIntervalMs?: number;
  shutdownGraceMs?: number;
  /** Delay between attempts to report a job's outcome. */
  reportRetryDelayMs?: number;
  /** Self-update: reported in every heartbeat and told about each response. */
  updater?: Pick<SelfUpdater, "report" | "onHeartbeat">;
}

interface RunningJob {
  /** The pool whose slot the job takes; null for `system` jobs (they take a slot, but no pool's). */
  pool: string | null;
  controller: AbortController;
  jobToken: string;
  /** Delivers a `jobMessages` message into the job's live session, while it has one. */
  injector?: (text: string) => boolean;
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
  runningJobIds: string[];
  maxConcurrency: number | null;
}

/**
 * The agent's main loop: heartbeats (central config, cancellations, job
 * tokens; the control panel renews the running jobs' leases), a claim loop
 * that long-polls for a job while a slot is free, and the job lifecycle
 * (claim → run → result/fail).
 */
export class AgentDaemon implements DrainableDaemon {
  private config: HeartbeatResponse | null = null;
  private lastHeartbeatAt: Date | null = null;
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
  private readonly sleepers = new Set<() => void>();
  private resolveExit!: (code: number) => void;
  private readonly exit = new Promise<number>((resolve) => (this.resolveExit = resolve));
  private readonly heartbeatIntervalMs: number;
  private readonly shutdownGraceMs: number;
  private readonly reportRetryDelayMs: number;
  private repoCache: RepoCache | undefined;
  /** `jobMessages` handled since the last heartbeat that got through: ID → job and whether it was injected. */
  private readonly pendingAcks = new Map<string, { jobId: string; delivered: boolean }>();
  /** Message IDs already acknowledged (oldest first). */
  private readonly ackedMessageIds = new Set<string>();

  constructor(private readonly options: DaemonOptions) {
    this.repoCache = options.repos;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_SECONDS * 1000;
    this.shutdownGraceMs = options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;
    this.reportRetryDelayMs = options.reportRetryDelayMs ?? 2_000;
  }

  /** Starts heartbeating and claiming. Resolves with the exit code once the daemon stops. */
  run(): Promise<number> {
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
      runningJobIds: [...this.running.keys()],
      maxConcurrency: this.config?.maxConcurrency ?? null,
    };
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
    this.stop();
    for (const job of this.running.values()) job.controller.abort(new ShutdownAbort());
    if (!wasStopping) this.options.logger.error({ err: error }, "agent stopped");
    this.resolveExit(1);
  }

  private stop(): void {
    this.stopping = true;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const wake of this.sleepers) wake();
    this.refreshClaim();
  }

  // --- Heartbeat and central config -------------------------------------------------------

  private async heartbeatLoop(): Promise<void> {
    if (this.stopping) return;
    await this.heartbeat();
    if (this.stopping) return;
    this.heartbeatTimer = setTimeout(() => void this.heartbeatLoop(), this.heartbeatIntervalMs);
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
    try {
      const response = await this.options.api.heartbeat({
        version: this.options.version,
        runningJobIds: [...this.running.keys()],
        freeSlots: this.freeSlots(),
        deliveredMessageIds,
        rejectedMessageIds,
        failedVersions: [],
        ...this.options.updater?.report(),
      });
      this.lastHeartbeatAt = new Date();
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
      this.onApiError(error, "heartbeat failed");
      this.notifyUpdater(null);
    }
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
    if (
      !previous ||
      previous.maxConcurrency !== config.maxConcurrency ||
      JSON.stringify(previous.poolLimits) !== JSON.stringify(config.poolLimits) ||
      previous.acceptedTaskTypes.join() !== config.acceptedTaskTypes.join()
    ) {
      this.options.logger.info(
        {
          maxConcurrency: config.maxConcurrency,
          acceptedTaskTypes: config.acceptedTaskTypes,
          poolLimits: config.poolLimits,
          claimablePools: this.claimablePools(),
        },
        "applied central config",
      );
    }
    for (const jobId of config.cancelJobIds) {
      const job = this.running.get(jobId);
      if (job && !job.controller.signal.aborted) {
        this.options.logger.info({ jobId }, "canceling job");
        job.controller.abort(new JobCanceled());
      }
    }
    for (const { jobId, token } of config.jobTokens) {
      const job = this.running.get(jobId);
      if (job) job.jobToken = token;
    }
    this.deliverMessages(config.jobMessages);
    this.refreshClaim();
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

  // --- Claiming --------------------------------------------------------------------------

  /** The pools of the harness's organization, from the heartbeat. */
  private pools(): string[] {
    return this.config ? Object.keys(this.config.poolLimits) : [];
  }

  /**
   * How many of a pool's jobs may run at once: the heartbeat's limit, or the
   * protocol default when the control panel sent none.
   */
  poolLimit(pool: string): number {
    const config = this.config;
    if (!config) return 0;
    return effectivePoolLimit(pool, config.poolLimits, config.maxConcurrency);
  }

  private runningByPool(): Map<string, number> {
    const running = new Map<string, number>();
    for (const { pool } of this.running.values()) {
      if (pool !== null) running.set(pool, (running.get(pool) ?? 0) + 1);
    }
    return running;
  }

  /** Jobs the harness could take right now: its free slots (none while draining). */
  freeSlots(): number {
    const config = this.config;
    if (!config || this.draining) return 0;
    return Math.max(0, config.maxConcurrency - this.running.size);
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
    this.wakeClaimLoop?.();
  }

  /**
   * One claim at a time: long-polls while a slot is free, starts the job it
   * gets and claims again at once. Backs off (up to 30s) on API errors.
   */
  private async claimLoop(): Promise<void> {
    while (!this.stopping) {
      const pools = this.claimablePools();
      if (pools === null) {
        await new Promise<void>((resolve) => (this.wakeClaimLoop = resolve));
        this.wakeClaimLoop = null;
        continue;
      }
      const controller = new AbortController();
      this.claim = { controller, pools };
      let start: JobStartResponse | null;
      try {
        start = await this.options.api.claim({ pools }, controller.signal);
        this.claimBackoffMs = 0;
      } catch (error) {
        if (controller.signal.aborted) continue;
        this.onApiError(error, "claim failed");
        this.claimBackoffMs = Math.min(
          MAX_CLAIM_BACKOFF_MS,
          Math.max(CLAIM_BACKOFF_MS, this.claimBackoffMs * 2),
        );
        await this.sleep(this.claimBackoffMs);
        continue;
      } finally {
        this.claim = null;
      }
      if (start) this.startJob(start);
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
    const capability = this.options.registry.forJob(job);
    if (!capability) {
      jobLog.error("unknown job type");
      void this.track(
        this.report(job.id, jobLog, () =>
          this.options.api.submitFailure(job.id, {
            retryable: false,
            error: `unknown job type ${job.type}`,
          }),
        ),
      );
      return;
    }
    const running: RunningJob = {
      pool: job.pool,
      controller: new AbortController(),
      jobToken: start.jobToken.token,
    };
    this.running.set(job.id, running);
    jobLog.info({ deliveryCount: job.deliveryCount }, "running job");
    void this.track(
      this.runJob(job, capability, running, jobLog).catch((error: unknown) =>
        jobLog.error({ err: error }, "job handler failed"),
      ),
    );
  }

  /**
   * Runs a job and reports its outcome. A retryable failure is only reported:
   * the control panel makes the job claimable again after `retryAfterSeconds`.
   */
  private async runJob(
    job: JobPayload,
    capability: Capability,
    running: RunningJob,
    jobLog: Logger,
  ): Promise<void> {
    let output: JobOutput | undefined;
    let failure: unknown;
    try {
      output = await capability.run(job, this.jobContext(job, running, jobLog));
    } catch (error) {
      failure = error ?? new Error("job failed");
    } finally {
      this.running.delete(job.id);
      this.refreshClaim();
    }
    if ([...this.pendingAcks.values()].some((ack) => ack.jobId === job.id)) {
      // Acknowledge the job's messages before its outcome, so none is taken for undelivered.
      await this.heartbeat();
    }

    const reason: unknown = running.controller.signal.reason;
    if (failure !== undefined && reason instanceof ShutdownAbort) {
      // Not reported: the lease lapses and the job is redelivered.
      jobLog.info("job interrupted by shutdown");
      return;
    }
    if (failure === undefined) {
      jobLog.info("job finished");
      await this.report(job.id, jobLog, () =>
        this.options.api.submitResult(job.id, { result: output ?? {} }),
      );
      return;
    }
    const body = failureBody(failure, reason);
    jobLog.warn({ err: failure, retryable: body.retryable }, "job failed");
    await this.report(job.id, jobLog, () => this.options.api.submitFailure(job.id, body));
  }

  private jobContext(job: JobPayload, running: RunningJob, logger: Logger): JobContext {
    const { server, workspaceRoot } = this.options;
    const identity = () => ({ jobId: job.id, jobToken: running.jobToken, server });
    return {
      signal: running.controller.signal,
      jobToken: () => running.jobToken,
      env: (extra) => jobProcessEnv(identity(), process.env, extra),
      spawn: (command, args, options) => spawnJobProcess(identity(), command, args, options),
      server,
      workspaceRoot,
      repos: this.repos(),
      logger,
      setMessageInjector: (inject) => {
        running.injector = inject;
      },
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
