import "server-only";
import type { Database, Job } from "@omniralph/db";
import {
  CHAT_ASK_CAPABILITY,
  CHAT_ASK_JOB_TYPE,
  ChatAskJobPayload,
  LEARN_RULE_CAPABILITY,
  LEARN_RULE_JOB_TYPE,
  LearnRuleJobPayload,
  RALPH_CAPABILITY,
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
  REVIEW_CAPABILITY,
  REVIEW_JOB_TYPE,
  REVIEW_REPLY_CAPABILITY,
  REVIEW_REPLY_JOB_TYPE,
  ReviewJobPayload,
  ReviewReplyJobPayload,
  TRIAGE_CAPABILITY,
  TRIAGE_RUN_JOB_TYPE,
  TriageRunPayload,
  TriageRunResult,
  type JobSkipReason,
} from "@omniralph/shared";
import type { z } from "zod";
import { onChatAskJobCompleted, onChatAskJobFailed, parseChatAskResult } from "@/lib/chat/ask";
import { onReplyJobCompleted, onReplyJobFailed, parseReplyResult } from "@/lib/mentions/reply";
import {
  onReviewJobCanceled,
  onReviewJobCompleted,
  onReviewJobFailed,
  onReviewJobRetry,
  onReviewJobStarted,
  parseReviewResult,
} from "@/lib/review/jobs";
import { onRalphCleanupJobFinished, onRalphJobFinished, onRalphJobStarted } from "@/lib/ralph/jobs";
import { onLearnRuleJobCompleted, parseLearnRuleResult } from "@/lib/rules/learn";
import {
  onTriageJobCompleted,
  onTriageJobFinishedWithoutResult,
  onTriageJobStarted,
} from "@/lib/triage/apply";

/**
 * Per-job-type hooks into the generic job lifecycle (`/start`, `/result`,
 * `/fail`, revocation, expiry and cancel). The lifecycle routes update the
 * `jobs` row; these hooks keep the capability's own state (reviews, rules,
 * ralph runs) in step with it. Every hook is optional.
 */
export interface JobOutcomeHandler {
  capability: string;
  /** Jobs whose payload doesn't parse get the generic lifecycle only. */
  payload: z.ZodType;
  /**
   * After a delivery started. `skip` acknowledges the message without running
   * it (the hook has already recorded why).
   */
  onStarted?(
    db: Database,
    job: Job,
    agentId: string,
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

/** The hooks for `job`, or undefined when its type has none or its capability or payload don't match. */
export function jobOutcomeHandler(
  job: Pick<Job, "capability" | "type" | "payload">,
): JobOutcomeHandler | undefined {
  const handler = handlers.get(job.type);
  if (!handler || handler.capability !== job.capability) return undefined;
  return handler.payload.safeParse(job.payload).success ? handler : undefined;
}

registerJobOutcomeHandler(REVIEW_JOB_TYPE, {
  capability: REVIEW_CAPABILITY,
  payload: ReviewJobPayload,
  onStarted: onReviewJobStarted,
  isValidResult: (result) => parseReviewResult(result) !== null,
  onCompleted: onReviewJobCompleted,
  onFailed: (db, job, error) => onReviewJobFailed(db, job, error ?? "Review failed"),
  onRetry: onReviewJobRetry,
  onCanceled: onReviewJobCanceled,
});

registerJobOutcomeHandler(LEARN_RULE_JOB_TYPE, {
  capability: LEARN_RULE_CAPABILITY,
  payload: LearnRuleJobPayload,
  isValidResult: (result) => parseLearnRuleResult(result) !== null,
  onCompleted: onLearnRuleJobCompleted,
});

registerJobOutcomeHandler(REVIEW_REPLY_JOB_TYPE, {
  capability: REVIEW_REPLY_CAPABILITY,
  payload: ReviewReplyJobPayload,
  isValidResult: (result) => parseReplyResult(result) !== null,
  onCompleted: onReplyJobCompleted,
  onFailed: (db, job) => onReplyJobFailed(db, job),
});

registerJobOutcomeHandler(CHAT_ASK_JOB_TYPE, {
  capability: CHAT_ASK_CAPABILITY,
  payload: ChatAskJobPayload,
  isValidResult: (result) => parseChatAskResult(result) !== null,
  onCompleted: (db, job) => onChatAskJobCompleted(db, job),
  onFailed: (db, job) => onChatAskJobFailed(db, job),
});

registerJobOutcomeHandler(RALPH_DESCRIBE_PR_JOB_TYPE, {
  capability: RALPH_CAPABILITY,
  payload: RalphDescribePrPayload,
  onStarted: onRalphJobStarted,
  isValidResult: (result) => RalphDescribePrResult.safeParse(result).success,
  onCompleted: (db, job) => onRalphJobFinished(db, job),
  onFailed: (db, job) => onRalphJobFinished(db, job),
  onCanceled: (db, job) => onRalphJobFinished(db, job),
});

registerJobOutcomeHandler(RALPH_PREPARE_JOB_TYPE, {
  capability: RALPH_CAPABILITY,
  payload: RalphPreparePayload,
  onStarted: onRalphJobStarted,
  isValidResult: (result) => RalphPrepareResult.safeParse(result).success,
  onCompleted: (db, job) => onRalphJobFinished(db, job),
  onFailed: (db, job) => onRalphJobFinished(db, job),
  onCanceled: (db, job) => onRalphJobFinished(db, job),
});

registerJobOutcomeHandler(RALPH_REQUEST_JOB_TYPE, {
  capability: RALPH_CAPABILITY,
  payload: RalphRequestPayload,
  onStarted: onRalphJobStarted,
  isValidResult: (result) => RalphRequestResult.safeParse(result).success,
  onCompleted: (db, job) => onRalphJobFinished(db, job),
  onFailed: (db, job) => onRalphJobFinished(db, job),
  onCanceled: (db, job) => onRalphJobFinished(db, job),
});

registerJobOutcomeHandler(RALPH_STORY_JOB_TYPE, {
  capability: RALPH_CAPABILITY,
  payload: RalphStoryPayload,
  onStarted: onRalphJobStarted,
  isValidResult: (result) => RalphStoryResult.safeParse(result).success,
  onCompleted: (db, job) => onRalphJobFinished(db, job),
  onFailed: (db, job) => onRalphJobFinished(db, job),
  onCanceled: (db, job) => onRalphJobFinished(db, job),
});

// No `onStarted`: a cleanup runs after the run is over too, and doesn't make its agent sticky.
registerJobOutcomeHandler(RALPH_CLEANUP_JOB_TYPE, {
  capability: RALPH_CAPABILITY,
  payload: RalphCleanupPayload,
  isValidResult: (result) => RalphCleanupResult.safeParse(result).success,
  onCompleted: (db, job) => onRalphCleanupJobFinished(db, job),
  onFailed: (db, job) => onRalphCleanupJobFinished(db, job),
  onCanceled: (db, job) => onRalphCleanupJobFinished(db, job),
});

// A well-formed result is accepted even when `validateTriageOutput` rejects it:
// `onCompleted` then fails the job and the run, and tells the Linear session why.
registerJobOutcomeHandler(TRIAGE_RUN_JOB_TYPE, {
  capability: TRIAGE_CAPABILITY,
  payload: TriageRunPayload,
  onStarted: (db, job) => onTriageJobStarted(db, job),
  isValidResult: (result) => TriageRunResult.safeParse(result).success,
  onCompleted: (db, job) => onTriageJobCompleted(db, job),
  onFailed: (db, job, error) => onTriageJobFinishedWithoutResult(db, job, "failed", error),
  onCanceled: (db, job) => onTriageJobFinishedWithoutResult(db, job, "stopped", null),
});
