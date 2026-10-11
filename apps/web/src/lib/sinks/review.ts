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
 * The `review` sink: applies a review task's run (e.g. `builtin:review-pr`)
 * to its review, from the run's trigger context (`ReviewTriggerContext`),
 * through the hooks in `lib/review/jobs.ts`. The start skips a webhook review
 * of a head that already has a completed review, else marks the review
 * `running`; a result (a `ReviewTaskResult`) is saved and settles the review
 * run, which is posted once it ended; a retry queues the review again, a
 * final failure fails it, a cancel skips it.
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
