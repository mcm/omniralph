import {
  HEARTBEAT_INTERVAL_SECONDS,
  JobMessage,
  QUEUE_CONSUMER_GROUP,
  SYSTEM_CAPABILITY,
  capabilityTopic,
  effectiveCapabilityLimit,
  type HeartbeatResponse,
  type JobFailure,
  type JobOutcomeResponse,
  type JobPayload,
} from "@omniralph/shared";
import { ApiError, type ControlPanelApi } from "./api.js";
import {
  RetryableJobError,
  type CapabilityRegistry,
  type JobContext,
  type JobOutput,
} from "./capabilities/index.js";
import { jobProcessEnv, spawnJobProcess } from "./job-env.js";
import type { Logger } from "./logger.js";
import type { DrainableDaemon, SelfUpdater } from "./update.js";
import type {
  MessageMetadata,
  QueueReceiver,
  QueueReceiverFactory,
  RetryDirective,
} from "./queue.js";
import { defaultCredentialHelper } from "./workspace/git.js";
import { RepoCache } from "./workspace/repoCache.js";

/** Lease taken per receive; the SDK re-extends it every min(60s, lease/5) while the job runs. */
export const VISIBILITY_TIMEOUT_SECONDS = 300;
/** How long SIGTERM waits for running jobs before exiting. */
export const SHUTDOWN_GRACE_MS = 60_000;
/** Delay before redelivering a message whose `/start` call failed. */
const START_FAILED_RETRY_SECONDS = 30;
const REPORT_ATTEMPTS = 3;

/** Aborts a job because the agent is shutting down: no report, no acknowledgement. */
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

/** Thrown out of the receive handler: the SDK applies the directive instead of acknowledging. */
class Redeliver extends Error {
  override name = "Redeliver";
  constructor(readonly directive: RetryDirective | undefined) {
    super("message not acknowledged");
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
  queue: QueueReceiverFactory;
  logger: Logger;
  heartbeatIntervalMs?: number;
  shutdownGraceMs?: number;
  /** Delay between attempts to report a job's outcome. */
  reportRetryDelayMs?: number;
  /** Self-update: reported in every heartbeat and told about each response. */
  updater?: Pick<SelfUpdater, "report" | "onHeartbeat">;
}

interface RunningJob {
  capability: string;
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
 * tokens), one poll worker per free slot, and the job lifecycle
 * (start → run → result/fail → acknowledge) inside the queue's receive handler.
 */
export class AgentDaemon implements DrainableDaemon {
  private config: HeartbeatResponse | null = null;
  private lastHeartbeatAt: Date | null = null;
  private readonly running = new Map<string, RunningJob>();
  /** Running receive handlers (for the shutdown wait). */
  private readonly handlers = new Set<Promise<unknown>>();
  /** Poll workers; each holds at most one message, so this is the number of used slots. */
  private workers = 0;
  /**
   * Workers receiving from (and so running a job of) each capability's topics.
   * A worker only receives from a capability's topics while this is under the
   * capability's limit.
   */
  private readonly capabilitySlots = new Map<string, number>();
  private stopping = false;
  /** Set by `drain()`: no new receives until `resume()`. */
  private draining = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly sleepers = new Set<() => void>();
  private readonly receivers = new Map<string, QueueReceiver>();
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

  /** Starts heartbeating and polling. Resolves with the exit code once the daemon stops. */
  run(): Promise<number> {
    void this.heartbeatLoop();
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
   * Graceful stop (SIGTERM): no more polling, running jobs are aborted and
   * get up to `shutdownGraceMs` to finish. Unfinished messages are not
   * acknowledged, so the queue redelivers them.
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
          "exiting with unfinished jobs; their messages will be redelivered",
        );
      }
    }
    this.resolveExit(0);
  }

  /**
   * Stops taking jobs (for a self-update) and waits up to `timeoutMs` for the
   * running ones, then aborts the rest: their messages aren't acknowledged,
   * so they're redelivered. Heartbeats go on, so running jobs keep their
   * tokens and messages. Port of cyralph's `SessionManager.drain`.
   */
  async drain(timeoutMs: number): Promise<void> {
    this.draining = true;
    for (const wake of this.sleepers) wake();
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
        "aborted jobs didn't finish in time; their messages will be redelivered",
      );
    }
  }

  /** Takes jobs again after `drain()`. */
  resume(): void {
    if (!this.draining) return;
    this.draining = false;
    this.options.logger.info("taking jobs again");
    this.fillSlots();
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

  /** Waits for the running receive handlers; false when `timeoutMs` passed first. */
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
        capabilities: this.options.registry.names(),
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

  /** Applies a heartbeat response without restarting anything. */
  applyConfig(config: HeartbeatResponse): void {
    const previous = this.config;
    this.config = config;
    if (
      !previous ||
      previous.maxConcurrency !== config.maxConcurrency ||
      previous.pollIntervalSeconds !== config.pollIntervalSeconds ||
      previous.queueRegion !== config.queueRegion ||
      previous.topics.join() !== config.topics.join() ||
      JSON.stringify(previous.capabilityLimits) !== JSON.stringify(config.capabilityLimits) ||
      previous.enabledCapabilities.join() !== config.enabledCapabilities.join()
    ) {
      this.options.logger.info(
        {
          maxConcurrency: config.maxConcurrency,
          pollIntervalSeconds: config.pollIntervalSeconds,
          enabledCapabilities: config.enabledCapabilities,
          capabilityLimits: config.capabilityLimits,
          topics: this.pollableTopics(),
          queueRegion: config.queueRegion,
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
    this.fillSlots();
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

  // --- Polling ----------------------------------------------------------------------------

  /**
   * Topics to poll: those from the heartbeat whose capability this host has
   * registered and the control panel has enabled (the built-in `system`
   * capability is always enabled). Pinned (per-agent) topics first.
   */
  pollableTopics(): string[] {
    const config = this.config;
    if (!config) return [];
    const topics = config.topics.filter((topic) => this.topicCapability(topic) !== undefined);
    return [
      ...topics.filter((topic) => topic.includes("-agent-")),
      ...topics.filter((topic) => !topic.includes("-agent-")),
    ];
  }

  /** Capabilities this host has registered and the control panel has enabled (plus `system`). */
  private pollableCapabilities(): string[] {
    const config = this.config;
    if (!config) return [];
    return this.options.registry
      .names()
      .filter((name) => name === SYSTEM_CAPABILITY || config.enabledCapabilities.includes(name));
  }

  /** The pollable capability whose jobs a topic carries, if any. */
  private topicCapability(topic: string): string | undefined {
    return this.pollableCapabilities().find((name) => {
      const shared = capabilityTopic(name);
      return topic === shared || topic.startsWith(`${shared}-agent-`);
    });
  }

  /**
   * How many of a capability's jobs may run at once: the heartbeat's limit, or
   * the protocol default when the control panel sent none.
   */
  capabilityLimit(capability: string): number {
    const config = this.config;
    if (!config) return 0;
    return effectiveCapabilityLimit(capability, config.capabilityLimits, config.maxConcurrency);
  }

  /**
   * Jobs the agent could take right now: its free slots, but no more than the
   * pollable capabilities still have room for under their limits.
   */
  freeSlots(): number {
    const config = this.config;
    if (!config || this.draining) return 0;
    const running = new Map<string, number>();
    for (const job of this.running.values()) {
      running.set(job.capability, (running.get(job.capability) ?? 0) + 1);
    }
    const room = this.pollableCapabilities().reduce(
      (sum, name) => sum + Math.max(0, this.capabilityLimit(name) - (running.get(name) ?? 0)),
      0,
    );
    return Math.max(0, Math.min(config.maxConcurrency - this.running.size, room));
  }

  /**
   * Takes one of a capability's slots for a receive (and the job it may run).
   * Synchronous, so two workers can't both take the last slot. A lowered
   * limit cancels nothing: receives just stop until the count drops below it.
   */
  private takeCapabilitySlot(capability: string): boolean {
    const used = this.capabilitySlots.get(capability) ?? 0;
    if (used >= this.capabilityLimit(capability)) return false;
    this.capabilitySlots.set(capability, used + 1);
    return true;
  }

  private releaseCapabilitySlot(capability: string): void {
    const used = (this.capabilitySlots.get(capability) ?? 1) - 1;
    if (used > 0) this.capabilitySlots.set(capability, used);
    else this.capabilitySlots.delete(capability);
  }

  private fillSlots(): void {
    if (this.stopping || this.draining || !this.config || this.pollableTopics().length === 0) {
      return;
    }
    while (this.workers < this.config.maxConcurrency) {
      this.workers++;
      void this.worker();
    }
  }

  private receiver(region: string): QueueReceiver {
    let receiver = this.receivers.get(region);
    if (!receiver) {
      receiver = this.options.queue(region);
      this.receivers.set(region, receiver);
    }
    return receiver;
  }

  private async worker(): Promise<void> {
    for (;;) {
      const config = this.config;
      const topics = this.pollableTopics();
      // Leave synchronously (check and decrement together) so a lowered maxConcurrency
      // retires exactly the surplus workers.
      if (
        this.stopping ||
        this.draining ||
        !config ||
        this.workers > config.maxConcurrency ||
        topics.length === 0
      ) {
        this.workers--;
        return;
      }
      let received = false;
      for (const topic of topics) {
        if (this.stopping || this.draining) break;
        const capability = this.topicCapability(topic);
        if (!capability || !this.takeCapabilitySlot(capability)) continue;
        try {
          const result = await this.receiver(config.queueRegion).receive(
            topic,
            QUEUE_CONSUMER_GROUP,
            (message, metadata) => this.track(this.handleMessage(message, metadata)),
            {
              limit: 1,
              visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_SECONDS,
              retry: (error) => (error instanceof Redeliver ? error.directive : undefined),
            },
          );
          if (result.ok) {
            received = true;
            break;
          }
        } catch (error) {
          if (!(error instanceof Redeliver)) this.onApiError(error, `receive from ${topic} failed`);
        } finally {
          this.releaseCapabilitySlot(capability);
        }
      }
      if (!received) await this.sleep(config.pollIntervalSeconds * 1000);
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
   * Runs inside `receive()`: returning acknowledges the message, throwing
   * `Redeliver` applies its directive (or leaves the lease to lapse).
   */
  private async handleMessage(message: unknown, metadata: MessageMetadata): Promise<void> {
    const log = this.options.logger.child({ messageId: metadata.messageId });
    if (this.stopping || this.draining) throw new Redeliver({ afterSeconds: 0 });
    const parsed = JobMessage.safeParse(message);
    if (!parsed.success) {
      log.warn("dropping a malformed queue message");
      return;
    }
    const { jobId } = parsed.data;

    let start;
    try {
      start = await this.options.api.startJob(jobId);
    } catch (error) {
      this.onApiError(error, "job start failed");
      throw new Redeliver({ afterSeconds: START_FAILED_RETRY_SECONDS });
    }
    if (start.action === "skip") {
      log.info({ jobId, reason: start.reason }, "skipping job");
      return;
    }

    const { job } = start;
    const jobLog = log.child({ jobId, capability: job.capability, type: job.type });
    const capability = this.options.registry.forJob(job);
    if (!capability) {
      jobLog.error("unknown job type");
      await this.report(job.id, jobLog, () =>
        this.options.api.submitFailure(job.id, {
          retryable: false,
          error: `unknown job type ${job.capability}/${job.type}`,
        }),
      );
      return;
    }

    const controller = new AbortController();
    const running: RunningJob = {
      capability: job.capability,
      controller,
      jobToken: start.jobToken.token,
    };
    this.running.set(job.id, running);
    jobLog.info({ deliveryCount: job.deliveryCount }, "running job");
    let output: JobOutput | undefined;
    let failure: unknown;
    try {
      output = await capability.run(job, this.jobContext(job, running, jobLog));
    } catch (error) {
      failure = error ?? new Error("job failed");
    } finally {
      this.running.delete(job.id);
    }
    if ([...this.pendingAcks.values()].some((ack) => ack.jobId === job.id)) {
      // Acknowledge the job's messages before its outcome, so none is taken for undelivered.
      await this.heartbeat();
    }

    const reason: unknown = controller.signal.reason;
    if (failure !== undefined && reason instanceof ShutdownAbort) {
      // Not acknowledged: the lease lapses and the job is redelivered.
      jobLog.info("job interrupted by shutdown");
      throw new Redeliver(undefined);
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
   * Reports a job's outcome and settles its message: `retry` leaves it
   * unacknowledged with the lease set to `retryAfterSeconds`; anything else
   * acknowledges it. If reporting keeps failing the message isn't
   * acknowledged, so the job runs again after redelivery.
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
        if (attempt >= REPORT_ATTEMPTS) throw new Redeliver(undefined);
        await new Promise((resolve) => setTimeout(resolve, this.reportRetryDelayMs * attempt));
      }
    }
    log.info({ jobId, status: outcome.status }, "job outcome recorded");
    if (outcome.status === "retry") {
      throw new Redeliver({ afterSeconds: outcome.retryAfterSeconds });
    }
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
