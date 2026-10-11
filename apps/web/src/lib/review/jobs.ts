import "server-only";
import {
  findCompletedReview,
  finishReview,
  getReview,
  markReviewQueued,
  markReviewRunning,
  saveReviewOutcome,
  skipJob,
  type Database,
  type Job,
} from "@omniralph/db";
import { ReviewJobPayload, ReviewJobResult } from "@omniralph/shared";
import { onReviewForRalph } from "@/lib/ralph/jobs";
import { postFailureNote, postReview } from "./post";
import { resolveFixedFindings } from "./resolve";
import { supersedeEarlierFindings } from "./supersede";

/**
 * The review side of the job lifecycle: the agent API routes call these
 * hooks for `review.run` jobs so that the `reviews` row follows its job, the
 * result is persisted and posted, and final failures get a note on the PR/MR.
 */

function reviewPayload(job: Job): ReviewJobPayload {
  return ReviewJobPayload.parse(job.payload);
}

/**
 * After a delivery started: a webhook review of a head SHA that already has a
 * `completed` review isn't reviewed again (job and review become `skipped`);
 * otherwise (and always for an explicit `@bot review` or Re-run) the review is marked
 * `running` on the agent.
 */
export async function onReviewJobStarted(
  db: Database,
  job: Job,
  harnessId: string,
): Promise<{ skip: false } | { skip: true; reason: "already_reviewed" }> {
  const payload = reviewPayload(job);
  const review = await getReview(db, payload.reviewId);
  const completed =
    (review?.trigger ?? "webhook") === "webhook" &&
    (await findCompletedReview(db, {
      repositoryId: payload.repositoryId,
      prNumber: payload.prNumber,
      headSha: payload.headSha,
      exceptReviewId: payload.reviewId,
    }));
  if (completed) {
    const reason = `Head ${payload.headSha.slice(0, 12)} was already reviewed (review ${completed.id})`;
    await skipJob(db, job.id, { reason });
    await finishReview(db, payload.reviewId, { status: "skipped", error: reason });
    return { skip: true, reason: "already_reviewed" };
  }
  await markReviewRunning(db, payload.reviewId, harnessId);
  return { skip: false };
}

/** Validates a review job's result before the job is completed. */
export function parseReviewResult(result: unknown): ReviewJobResult | null {
  const parsed = ReviewJobResult.safeParse(result);
  return parsed.success ? parsed.data : null;
}

/**
 * For a `completed` review job: persists the review and its findings (once),
 * then posts it to the PR/MR (once). A `fresh` review then supersedes the
 * earlier open findings it raised again, and the earlier open findings the
 * review re-checked and found fixed are resolved. Then a ralph PR/MR's open
 * findings go back to its run (`onReviewForRalph`, at most once per review).
 * Safe to call again for a replayed result; that also retries a post that
 * failed before.
 */
export async function onReviewJobCompleted(db: Database, job: Job): Promise<void> {
  const payload = reviewPayload(job);
  const result = ReviewJobResult.parse(job.result);
  await saveReviewOutcome(db, payload.reviewId, {
    status: result.stopReason === "budget_exhausted" ? "budget_exhausted" : "completed",
    tokensIn: result.usage.inputTokens,
    tokensOut: result.usage.outputTokens,
    durationMs: result.durationMs,
    skippedFiles: result.skipped,
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
  await postReview(db, { reviewId: payload.reviewId, payload, result });
  if (payload.mode === "fresh") await supersedeEarlierFindings(db, payload.reviewId);
  await resolveFixedFindings(db, { reviewId: payload.reviewId, payload, result });
  // A ralph PR/MR: the open findings may go back to its run as a request.
  await onReviewForRalph(db, payload.reviewId);
}

/** A review job that ended `canceled` (e.g. superseded by a newer push). */
export async function onReviewJobCanceled(db: Database, job: Job): Promise<void> {
  await finishReview(db, reviewPayload(job).reviewId, { status: "skipped", error: "Canceled" });
}

/** A retryable failure: the review waits for the job's redelivery. */
export async function onReviewJobRetry(db: Database, job: Job, error: string | null) {
  await markReviewQueued(db, reviewPayload(job).reviewId, error);
}

/**
 * A final failure: the review becomes `failed` with the error and a short
 * failure note is posted on the PR/MR (once).
 */
export async function onReviewJobFailed(db: Database, job: Job, error: string): Promise<void> {
  const payload = reviewPayload(job);
  await finishReview(db, payload.reviewId, { status: "failed", error });
  await postFailureNote(db, { reviewId: payload.reviewId, payload, error });
}
