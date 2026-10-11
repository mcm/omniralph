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
  skipJob,
  type Database,
  type Job,
} from "@omniralph/db";
import { ReviewJobPayload, ReviewJobResult, reviewTriggerContext } from "@omniralph/shared";
import { startCorrelation } from "./correlate";
import { postFailureNote, postReview } from "./post";
import { resolveFixedFindings } from "./resolve";
import { finishReviewRun } from "./run";
import { supersedeEarlierFindings } from "./supersede";

/**
 * The review side of the job lifecycle: the `review` sink (for
 * `builtin:review-pr` runs) and, for `review.run` jobs enqueued before the
 * port, the legacy outcome handler call these hooks so that the `reviews`
 * row follows its job and the result is persisted. The review's review run
 * follows: it is `running` once one of its reviews started and ends once
 * all of them did (`settleReviewRun`, maybe after a correlation); then it
 * is posted as one review, or one failure note when every task run failed
 * (`finishReviewRun`). A legacy review without a review run is posted
 * itself.
 */

/**
 * What the hooks read from a review job: its legacy `ReviewJobPayload` or the
 * `ReviewTriggerContext` of its run, which has the same fields.
 */
export type ReviewJobState = Pick<
  ReviewJobPayload,
  | "reviewId"
  | "repositoryId"
  | "prNumber"
  | "headSha"
  | "changeRequest"
  | "reviewConfig"
  | "mode"
  | "previousReview"
>;

/** A review job's state: its run's trigger context, or its legacy `review.run` payload. */
export function reviewJobState(job: Pick<Job, "payload" | "taskId">): ReviewJobState {
  return job.taskId === null
    ? ReviewJobPayload.parse(job.payload)
    : reviewTriggerContext(job.payload);
}

/**
 * Moves review run `reviewRunId` on (correlation or its end) if no review of
 * it is active any more, then posts it if it ended (`finishReviewRun`).
 */
async function settleAndFinishReviewRun(db: Database, reviewRunId: string): Promise<void> {
  await settleReviewRun(db, reviewRunId, startCorrelation);
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
  job: Pick<Job, "id">,
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
    await skipJob(db, job.id, { reason });
    await finishReview(db, state.reviewId, { status: "skipped", error: reason });
    if (review?.reviewRunId) await settleAndFinishReviewRun(db, review.reviewRunId);
    return { skip: true, reason: "already_reviewed" };
  }
  await markReviewRunning(db, state.reviewId, harnessId);
  if (review?.reviewRunId) await markReviewRunRunning(db, review.reviewRunId);
  return { skip: false };
}

/** Validates a review job's result before the job is completed. */
export function parseReviewResult(result: unknown): ReviewJobResult | null {
  const parsed = ReviewJobResult.safeParse(result);
  return parsed.success ? parsed.data : null;
}

/**
 * For a `completed` review job: persists the review and its findings (once),
 * with the earlier open findings it re-checked and found fixed. A review of
 * a review run then settles the run, which is posted once it ended
 * (`finishReviewRun`). A legacy review without a review run is posted to
 * the PR/MR itself (once); a `fresh` one then supersedes the earlier open
 * findings it raised again, and the earlier open findings it found fixed
 * are resolved. Safe to call again for a replayed result; that also retries
 * a post that failed before.
 */
async function onReviewCompleted(
  db: Database,
  state: ReviewJobState,
  result: ReviewJobResult & { summary?: string },
): Promise<void> {
  await saveReviewResult(db, state, result);
  const review = await getReview(db, state.reviewId);
  if (review?.reviewRunId) {
    await settleAndFinishReviewRun(db, review.reviewRunId);
    return;
  }
  await postReview(db, { reviewId: state.reviewId, payload: state, result });
  if (state.mode === "fresh") await supersedeEarlierFindings(db, { reviewId: state.reviewId });
  await resolveFixedFindings(db, { reviewId: state.reviewId });
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
 * or gets one failure note when every task run failed. A legacy review
 * without a review run gets a short failure note on the PR/MR (once).
 */
async function onReviewFailed(db: Database, state: ReviewJobState, error: string): Promise<void> {
  await finishReview(db, state.reviewId, { status: "failed", error });
  const review = await getReview(db, state.reviewId);
  if (review?.reviewRunId) {
    await settleAndFinishReviewRun(db, review.reviewRunId);
    return;
  }
  await postFailureNote(db, { reviewId: state.reviewId, payload: state, error });
}

// The hooks by job: the `review` sink's and the legacy `review.run` outcome handler's.

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
