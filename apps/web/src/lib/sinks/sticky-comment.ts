import "server-only";
import {
  getReview,
  getReviewRun,
  writeStickyComment,
  type Database,
  type Job,
} from "@omniralph/db";
import { ReviewTaskResult } from "@omniralph/shared";
import {
  onReviewJobCanceled,
  onReviewJobFailed,
  onReviewJobRetry,
  onReviewJobStarted,
  reviewJobState,
  saveReviewResult,
  settleReviewRunOf,
} from "@/lib/review/jobs";
import { organizationDefinitions } from "@/lib/definitions";
import { repositoryTarget, reviewTaskNames, reviewUrl } from "@/lib/review/post";
import { inlineCode, MAX_SUMMARY_CHARS, sanitizeCapped } from "@/lib/review/sanitize";
import type { Sink } from "./index";

/**
 * The `sticky-comment` sink: applies a summary-only review task's run
 * (`builtin:summarize-pr`). The run's review is saved without findings (a
 * summary-only task posts none; any it returned are dropped and logged), its
 * summary goes to the PR/MR's one comment for the task, edited in place by
 * every later run (`postStickyComment`), and its review run settles as for
 * the `review` sink, which leaves it out of the correlation and the posted
 * review. Start, retry, failure and cancel are the `review` sink's.
 */
export const stickyCommentSink: Sink<never, ReviewTaskResult> = {
  kind: "sticky-comment",
  taskType: "review",
  outputSchema: null,
  parseResult(result) {
    const parsed = ReviewTaskResult.safeParse(result);
    return parsed.success ? parsed.data : null;
  },
  onStarted: onReviewJobStarted,
  async apply(db, job, result) {
    const state = reviewJobState(job);
    if (result.findings.length > 0) {
      console.warn("dropping the findings of a summary-only review task", {
        jobId: job.id,
        taskId: job.taskId,
        reviewId: state.reviewId,
        findings: result.findings.length,
      });
    }
    await saveReviewResult(db, state, { ...result, findings: [], fixedOpenFindings: [] });
    await postStickyComment(db, job, state.reviewId);
    await settleReviewRunOf(db, state.reviewId);
  },
  onFailed: (db, job, error) => onReviewJobFailed(db, job, error ?? "Review failed"),
  onRetry: onReviewJobRetry,
  onCanceled: onReviewJobCanceled,
};

/**
 * Writes the summary of finished review `reviewId` to its task's sticky
 * comment on the PR/MR: the stored comment is edited in place (created
 * when there is none yet, or it was deleted), under a row lock on its
 * `sticky_comments` row, so a replay edits the same comment again. A review
 * whose run was superseded by a newer push is left alone.
 */
export async function postStickyComment(
  db: Database,
  job: Pick<Job, "taskId" | "organizationId">,
  reviewId: string,
): Promise<boolean> {
  const review = await getReview(db, reviewId);
  if (!review || (review.status !== "completed" && review.status !== "budget_exhausted"))
    return false;
  const run = review.reviewRunId ? await getReviewRun(db, review.reviewRunId) : null;
  if (run?.status === "skipped") return false;
  const taskId = review.taskId ?? job.taskId;
  if (!taskId) return false;
  const { adapter, repo, sanitize } = await repositoryTarget(db, review, run?.prAuthor ?? null);
  const taskName = await reviewTaskNames(organizationDefinitions(db, job.organizationId), [taskId]);
  const body = [
    `## ${taskName(taskId)}`,
    "",
    review.summary
      ? sanitizeCapped(review.summary, sanitize, MAX_SUMMARY_CHARS)
      : "_No summary was written for this change._",
    "",
    `_Updated for ${inlineCode(review.headSha.slice(0, 12))} · [View the run](${reviewUrl(review.id)})_`,
    "",
  ].join("\n");
  await writeStickyComment(
    db,
    { repositoryId: review.repositoryId, prNumber: review.prNumber, taskId },
    (commentId) => adapter.upsertComment(repo, review.prNumber, body, commentId),
  );
  return true;
}
