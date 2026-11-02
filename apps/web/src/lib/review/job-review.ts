import { ReviewTriggerContext, RunSpecJobPayload } from "@omniralph/shared";

/** The review row a review task's job is for (in its trigger context); null for none. */
export function reviewIdOfJob(payload: unknown): string | null {
  const run = RunSpecJobPayload.safeParse(payload);
  if (!run.success) return null;
  const reviewId = ReviewTriggerContext.shape.reviewId.safeParse(run.data.trigger.context.reviewId);
  return reviewId.success ? reviewId.data : null;
}

/**
 * Dedupe key prefix of a PR's review jobs; the full key adds the head SHA and
 * the review task ID (`review.run:<repositoryId>:<pr>:<headSha>:<taskId>`).
 * It keeps the name of the removed `review.run` job type, so the keys of jobs
 * enqueued before review task jobs became `review.task` still match.
 */
export function reviewJobKeyPrefix(repositoryId: string, prNumber: number): string {
  return `review.run:${repositoryId}:${prNumber}:`;
}

/** Dedupe key of the job of review task `taskId` of a PR head. */
export function reviewJobKey(
  repositoryId: string,
  prNumber: number,
  headSha: string,
  taskId: string,
): string {
  return `${reviewJobKeyPrefix(repositoryId, prNumber)}${headSha}:${taskId}`;
}

/**
 * Dedupe key of pass `pass` of check type `checkType` of review task `taskId`
 * of a PR head (`reviewJobKey` with the check type and pass), so a newer push
 * supersedes it with the head's other review jobs.
 */
export function reviewPassJobKey(
  repositoryId: string,
  prNumber: number,
  headSha: string,
  taskId: string,
  checkType: string,
  pass: number,
): string {
  return reviewJobKey(repositoryId, prNumber, headSha, `${taskId}:${checkType}:pass-${pass}`);
}

/**
 * Dedupe key of the verifier job of pass `pass` of review `reviewId` (one
 * check type of a review task) of a PR head, under the PR's review job
 * prefix so a newer push supersedes it too.
 */
export function reviewVerifierJobKey(
  repositoryId: string,
  prNumber: number,
  headSha: string,
  reviewId: string,
  pass: number,
): string {
  return `${reviewJobKeyPrefix(repositoryId, prNumber)}${headSha}:verify:${reviewId}:pass-${pass}`;
}
