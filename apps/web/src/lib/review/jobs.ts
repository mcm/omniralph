import "server-only";
import {
  CANCELED_REVIEW_ERROR,
  findCompletedReview,
  finishReview,
  getReview,
  markReviewQueued,
  markReviewRunning,
  markReviewRunRunning,
  saveReviewOutcome,
  settleReviewRun,
  type Database,
  type Job,
} from "@omniralph/db";
import { skipJobAndClearDue, syncJobsDueFromPostgres } from "@/lib/dispatch/due";
import {
  ReviewJobResult,
  reviewTriggerContext,
  type ReviewTriggerContext,
} from "@omniralph/shared";
import { startCorrelation } from "./correlate";
import { finishReviewRun } from "./run";

/**
 * The review side of the job lifecycle: the `review` sink (review task runs,
 * e.g. `builtin:review-pr`) calls these hooks so that the `reviews` row
 * follows its job and the result is persisted. The review's review run
 * follows: it is `running` once one of its reviews started and ends once
 * all of them did (`settleReviewRun`, maybe after a correlation); then it
 * is posted as one review, or one failure note when every task run failed
 * (`finishReviewRun`).
 */

/** What the hooks read from a review job: the `ReviewTriggerContext` of its run. */
export type ReviewJobState = Pick<
  ReviewTriggerContext,
  | "reviewId"
  | "repositoryId"
  | "prNumber"
  | "headSha"
  | "changeRequest"
  | "reviewConfig"
  | "mode"
  | "previousReview"
>;

/** A review job's state: its run's trigger context. */
export function reviewJobState(job: Pick<Job, "payload">): ReviewJobState {
  return reviewTriggerContext(job.payload);
}

/**
 * Moves review run `reviewRunId` on (correlation or its end) if no review of
 * it is active any more, then posts it if it ended (`finishReviewRun`).
 */
async function settleAndFinishReviewRun(db: Database, reviewRunId: string): Promise<void> {
  let correlationJobId: string | undefined;
  const status = await settleReviewRun(db, reviewRunId, async (tx, run, inputs) => {
    const started = await startCorrelation(tx, run, inputs);
    if ("jobId" in started) correlationJobId = started.jobId;
    return started;
  });
  // The correlation job was inserted in the settle's transaction: due once it committed.
  if (status === "correlating" && correlationJobId) {
    await syncJobsDueFromPostgres(db, [correlationJobId]);
  }
  await finishReviewRun(db, reviewRunId);
}

/** `settleAndFinishReviewRun` for the review run of review `reviewId`, if any. */
export async function settleReviewRunOf(db: Database, reviewId: string): Promise<void> {
  const review = await getReview(db, reviewId);
  if (review?.reviewRunId) await settleAndFinishReviewRun(db, review.reviewRunId);
}

/**
 * After a delivery started: a webhook review of a head SHA that already has a
 * `completed` review of the same review task isn't reviewed again (job and
 * review become `skipped`); otherwise (and always for an explicit
 * `@bot review` or Re-run) the review is marked `running` on the agent, and
 * its review run `running`.
 */
async function onReviewStarted(
  db: Database,
  job: Pick<Job, "id" | "organizationId">,
  state: ReviewJobState,
  harnessId: string,
): Promise<{ skip: false } | { skip: true; reason: "already_reviewed" }> {
  const review = await getReview(db, state.reviewId);
  const completed =
    (review?.trigger ?? "webhook") === "webhook" &&
    (await findCompletedReview(db, {
      repositoryId: state.repositoryId,
      prNumber: state.prNumber,
      headSha: state.headSha,
      taskId: review?.taskId ?? undefined,
      exceptReviewId: state.reviewId,
    }));
  if (completed) {
    const reason = `Head ${state.headSha.slice(0, 12)} was already reviewed (review ${completed.id})`;
    await skipJobAndClearDue(db, job, { reason });
    await finishReview(db, state.reviewId, { status: "skipped", error: reason });
    if (review?.reviewRunId) await settleAndFinishReviewRun(db, review.reviewRunId);
    return { skip: true, reason: "already_reviewed" };
  }
  await markReviewRunning(db, state.reviewId, harnessId);
  if (review?.reviewRunId) await markReviewRunRunning(db, review.reviewRunId);
  return { skip: false };
}

/**
 * For a `completed` review job: persists the review and its findings (once),
 * with the earlier open findings it re-checked and found fixed, then settles
 * its review run, which is posted once it ended (`finishReviewRun`). Safe to
 * call again for a replayed result; that also retries a post that failed
 * before.
 */
async function onReviewCompleted(
  db: Database,
  state: ReviewJobState,
  result: ReviewJobResult & { summary?: string },
): Promise<void> {
  await saveReviewResult(db, state, result);
  await settleReviewRunOf(db, state.reviewId);
}

/**
 * Persists a review task run's result on its review (once; a replay is a
 * no-op): outcome, usage, summary, scope, the earlier open findings it found
 * fixed and its findings.
 */
export async function saveReviewResult(
  db: Database,
  state: ReviewJobState,
  result: ReviewJobResult & { summary?: string },
): Promise<void> {
  await saveReviewOutcome(db, state.reviewId, {
    status: result.stopReason === "budget_exhausted" ? "budget_exhausted" : "completed",
    tokensIn: result.usage.inputTokens,
    tokensOut: result.usage.outputTokens,
    durationMs: result.durationMs,
    skippedFiles: result.skipped,
    summary: result.summary ?? null,
    scope: result.scope,
    fixedFindingIds: fixedFindingIds(state, result),
    findings: result.findings.map((f) => ({
      path: f.path,
      startLine: f.startLine,
      endLine: f.endLine,
      severity: f.severity,
      category: f.category,
      title: f.title,
      body: f.body,
      suggestion: f.suggestion ?? null,
      confidence: f.confidence,
    })),
  });
}

/**
 * The IDs of the earlier open findings a review result reports fixed
 * (`fixedOpenFindings` indexes into the job's `previousReview.openFindings`).
 */
function fixedFindingIds(
  state: Pick<ReviewJobState, "previousReview">,
  result: Pick<ReviewJobResult, "fixedOpenFindings">,
): string[] {
  const given = state.previousReview?.openFindings ?? [];
  return [...new Set((result.fixedOpenFindings ?? []).flatMap((i) => given[i]?.id ?? []))];
}

/** A review job that ended `canceled` (e.g. superseded by a newer push). */
async function onReviewCanceled(db: Database, state: ReviewJobState): Promise<void> {
  await finishReview(db, state.reviewId, { status: "skipped", error: CANCELED_REVIEW_ERROR });
  await settleReviewRunOf(db, state.reviewId);
}

/** A retryable failure: the review waits for the job's redelivery. */
async function onReviewRetry(db: Database, state: ReviewJobState, error: string | null) {
  await markReviewQueued(db, state.reviewId, error);
}

/**
 * A final failure: the review becomes `failed` with the error. Its review
 * run settles: it is posted without the task's findings, naming the task,
 * or gets one failure note when every task run failed.
 */
async function onReviewFailed(db: Database, state: ReviewJobState, error: string): Promise<void> {
  await finishReview(db, state.reviewId, { status: "failed", error });
  await settleReviewRunOf(db, state.reviewId);
}

// The hooks by job, for the `review` sink.

export function onReviewJobStarted(db: Database, job: Job, harnessId: string) {
  return onReviewStarted(db, job, reviewJobState(job), harnessId);
}

export function onReviewJobCompleted(db: Database, job: Job): Promise<void> {
  return applyReviewResult(db, job, ReviewJobResult.parse(job.result));
}

/** `onReviewJobCompleted` with the job's result already parsed. */
export function applyReviewResult(
  db: Database,
  job: Pick<Job, "payload" | "taskId">,
  result: ReviewJobResult & { summary?: string },
): Promise<void> {
  return onReviewCompleted(db, reviewJobState(job), result);
}

export function onReviewJobCanceled(db: Database, job: Job): Promise<void> {
  return onReviewCanceled(db, reviewJobState(job));
}

export function onReviewJobRetry(db: Database, job: Job, error: string | null) {
  return onReviewRetry(db, reviewJobState(job), error);
}

export function onReviewJobFailed(db: Database, job: Job, error: string): Promise<void> {
  return onReviewFailed(db, reviewJobState(job), error);
}
