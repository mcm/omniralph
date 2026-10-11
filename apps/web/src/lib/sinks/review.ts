import "server-only";
import { ReviewTaskResult } from "@omniralph/shared";
import {
  applyReviewResult,
  onReviewJobCanceled,
  onReviewJobFailed,
  onReviewJobRetry,
  onReviewJobStarted,
} from "@/lib/review/jobs";
import type { Sink } from "./index";

/**
 * The `review` sink: applies a review task's run (`builtin:review-pr`) as
 * the legacy `review.run` outcome handler did, from the run's trigger context
 * (`ReviewTriggerContext`). The start skips a webhook review of a head that
 * already has a completed review, else marks the review `running`; a result
 * (a `ReviewTaskResult`) is saved, posted, supersedes (`fresh`) and resolves
 * the open findings found fixed, then goes to a ralph run; a retry queues the
 * review again, a final failure fails it with a note on the PR, a cancel skips it.
 */
export const reviewSink: Sink<never, ReviewTaskResult> = {
  kind: "review",
  outputSchema: null,
  parseResult(result) {
    const parsed = ReviewTaskResult.safeParse(result);
    return parsed.success ? parsed.data : null;
  },
  onStarted: onReviewJobStarted,
  apply: applyReviewResult,
  onFailed: (db, job, error) => onReviewJobFailed(db, job, error ?? "Review failed"),
  onRetry: onReviewJobRetry,
  onCanceled: onReviewJobCanceled,
};
