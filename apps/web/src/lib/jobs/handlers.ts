import "server-only";
import type { Database, Job } from "@omniralph/db";
import {
  RALPH_CLEANUP_JOB_TYPE,
  RALPH_DESCRIBE_PR_JOB_TYPE,
  RALPH_PREPARE_JOB_TYPE,
  RALPH_REQUEST_JOB_TYPE,
  RALPH_STORY_JOB_TYPE,
  RalphCleanupPayload,
  RalphCleanupResult,
  RalphDescribePrPayload,
  RalphDescribePrResult,
  RalphPreparePayload,
  RalphPrepareResult,
  RalphRequestPayload,
  RalphRequestResult,
  RalphStoryPayload,
  RalphStoryResult,
  WORKTREE_CLEANUP_JOB_TYPE,
  WORKTREE_EXEC_JOB_TYPE,
  WorktreeCleanupPayload,
  WorktreeCleanupResult,
  WorktreeExecPayload,
  WorktreeExecResult,
  type JobSkipReason,
} from "@omniralph/shared";
import type { z } from "zod";
import { onRalphCleanupJobFinished, onRalphJobFinished, onRalphJobStarted } from "@/lib/ralph/jobs";

/**
 * Per-job-type hooks into the generic job lifecycle (`/claim`, `/result`,
 * `/fail`, revocation, expiry and cancel) for legacy jobs (without a
 * `task_id`); run-spec jobs use their task's sink (`lib/sinks`) instead. The lifecycle routes update the
 * `jobs` row; these hooks keep the job type's own state (reviews, rules,
 * ralph runs) in step with it. Every hook is optional.
 */
export interface JobOutcomeHandler {
  /** Jobs whose payload doesn't parse get the generic lifecycle only. */
  payload: z.ZodType;
  /**
   * After a delivery started. `skip` ends the claim without running it (the
   * hook has already recorded why); the claim then moves on to the next job.
   */
  onStarted?(
    db: Database,
    job: Job,
    harnessId: string,
  ): Promise<{ skip: false } | { skip: true; reason: JobSkipReason }>;
  /** Whether a submitted result is valid; an invalid one is rejected (400) before the job completes. */
  isValidResult?(result: unknown): boolean;
  /** The job `completed`. Called again for a replayed result, so it must be idempotent. */
  onCompleted?(db: Database, job: Job): Promise<unknown>;
  /**
   * The job failed for good (non-retryable, out of deliveries, expired or its
   * agent revoked); `error` is null when the agent reported none.
   */
  onFailed?(db: Database, job: Job, error: string | null): Promise<unknown>;
  /** A retryable failure: the job waits for a redelivery. */
  onRetry?(db: Database, job: Job, error: string | null): Promise<unknown>;
  /** The job was canceled. */
  onCanceled?(db: Database, job: Job): Promise<unknown>;
}

const handlers = new Map<string, JobOutcomeHandler>();

/** Registers the hooks of a job type (`jobs.type`); each type has one handler. */
export function registerJobOutcomeHandler(type: string, handler: JobOutcomeHandler): void {
  if (handlers.has(type)) throw new Error(`job outcome handler for '${type}' registered twice`);
  handlers.set(type, handler);
}

/** The hooks for `job`, or undefined when its type has none or its payload doesn't match. */
export function jobOutcomeHandler(
  job: Pick<Job, "type" | "payload">,
): JobOutcomeHandler | undefined {
  const handler = handlers.get(job.type);
  if (!handler) return undefined;
  return handler.payload.safeParse(job.payload).success ? handler : undefined;
}

registerJobOutcomeHandler(RALPH_DESCRIBE_PR_JOB_TYPE, {
  payload: RalphDescribePrPayload,
  onStarted: onRalphJobStarted,
  isValidResult: (result) => RalphDescribePrResult.safeParse(result).success,
  onCompleted: (db, job) => onRalphJobFinished(db, job),
  onFailed: (db, job) => onRalphJobFinished(db, job),
  onCanceled: (db, job) => onRalphJobFinished(db, job),
});

// Legacy `ralph.prepare` jobs queued before preparations ran as `worktree.exec`.
registerJobOutcomeHandler(RALPH_PREPARE_JOB_TYPE, {
  payload: RalphPreparePayload,
  onStarted: onRalphJobStarted,
  isValidResult: (result) => RalphPrepareResult.safeParse(result).success,
  onCompleted: (db, job) => onRalphJobFinished(db, job),
  onFailed: (db, job) => onRalphJobFinished(db, job),
  onCanceled: (db, job) => onRalphJobFinished(db, job),
});

// A manual story's approved preparation (a system RPC of the run, on its sticky harness).
registerJobOutcomeHandler(WORKTREE_EXEC_JOB_TYPE, {
  payload: WorktreeExecPayload,
  onStarted: onRalphJobStarted,
  isValidResult: (result) => WorktreeExecResult.safeParse(result).success,
  onCompleted: (db, job) => onRalphJobFinished(db, job),
  onFailed: (db, job) => onRalphJobFinished(db, job),
  onCanceled: (db, job) => onRalphJobFinished(db, job),
});

registerJobOutcomeHandler(RALPH_REQUEST_JOB_TYPE, {
  payload: RalphRequestPayload,
  onStarted: onRalphJobStarted,
  isValidResult: (result) => RalphRequestResult.safeParse(result).success,
  onCompleted: (db, job) => onRalphJobFinished(db, job),
  onFailed: (db, job) => onRalphJobFinished(db, job),
  onCanceled: (db, job) => onRalphJobFinished(db, job),
});

registerJobOutcomeHandler(RALPH_STORY_JOB_TYPE, {
  payload: RalphStoryPayload,
  onStarted: onRalphJobStarted,
  isValidResult: (result) => RalphStoryResult.safeParse(result).success,
  onCompleted: (db, job) => onRalphJobFinished(db, job),
  onFailed: (db, job) => onRalphJobFinished(db, job),
  onCanceled: (db, job) => onRalphJobFinished(db, job),
});

// No `onStarted`: a cleanup runs after the run is over too, and doesn't make its agent sticky.
registerJobOutcomeHandler(WORKTREE_CLEANUP_JOB_TYPE, {
  payload: WorktreeCleanupPayload,
  isValidResult: (result) => WorktreeCleanupResult.safeParse(result).success,
  onCompleted: (db, job) => onRalphCleanupJobFinished(db, job),
  onFailed: (db, job) => onRalphCleanupJobFinished(db, job),
  onCanceled: (db, job) => onRalphCleanupJobFinished(db, job),
});

// Legacy `ralph.cleanup` jobs queued before cleanups ran as `worktree.cleanup`.
registerJobOutcomeHandler(RALPH_CLEANUP_JOB_TYPE, {
  payload: RalphCleanupPayload,
  isValidResult: (result) => RalphCleanupResult.safeParse(result).success,
  onCompleted: (db, job) => onRalphCleanupJobFinished(db, job),
  onFailed: (db, job) => onRalphCleanupJobFinished(db, job),
  onCanceled: (db, job) => onRalphCleanupJobFinished(db, job),
});
