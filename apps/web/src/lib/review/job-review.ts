import { ReviewTriggerContext, RunSpecJobPayload } from "@omniralph/shared";

/** The review row a review task's job is for (in its trigger context); null for none. */
export function reviewIdOfJob(payload: unknown): string | null {
  const run = RunSpecJobPayload.safeParse(payload);
  if (!run.success) return null;
  const reviewId = ReviewTriggerContext.shape.reviewId.safeParse(run.data.trigger.context.reviewId);
  return reviewId.success ? reviewId.data : null;
}
