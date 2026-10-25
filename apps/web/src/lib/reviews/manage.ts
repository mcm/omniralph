import "server-only";
import type { Database } from "@omniralph/db";
import type { JobDispatcher } from "@/lib/dispatch";
import { rerunReview as rerun, type RerunReviewOptions } from "@/lib/review/rerun";

export const REVIEW_NOT_FOUND = "That review doesn't exist.";

export type RerunOutcome =
  | {
      ok: true;
      /** The new review. */
      reviewId: string;
      /** Its review run. */
      reviewRunId: string;
    }
  | {
      ok: false;
      error: string;
      /** The queued or running review of the same head, when that's why nothing was enqueued. */
      activeReviewId?: string;
      /** Its review run. */
      activeReviewRunId?: string;
      /** The review isn't one of the organization's. */
      notFound?: boolean;
    };

/**
 * Re-runs a review of `organizationId` on its PR's current head (admins: the caller checks):
 * Incremental reviews the whole diff for new issues, Fresh from scratch; the depth is the
 * repository's or the one asked for (a review run's retry passes the run's own mode and
 * depth). Closed or merged PRs and heads with an active review get an error and no job.
 */
export async function rerunOrganizationReview(
  db: Database,
  dispatcher: JobDispatcher,
  organizationId: string,
  reviewId: string,
  input: RerunReviewOptions,
): Promise<RerunOutcome> {
  const result = await rerun(db, dispatcher, { organizationId, reviewId, ...input });
  switch (result.status) {
    case "enqueued":
      return { ok: true, reviewId: result.reviewId, reviewRunId: result.reviewRunId };
    case "duplicate":
      return {
        ok: false,
        error: `A review of ${result.headSha.slice(0, 12)} is already queued or running.`,
        activeReviewId: result.reviewId,
        activeReviewRunId: result.reviewRunId,
      };
    case "not_open":
      return {
        ok: false,
        error: `This change request is ${result.state}, so it can't be reviewed again.`,
      };
    case "not_found":
      return { ok: false, error: REVIEW_NOT_FOUND, notFound: true };
    case "repository_unavailable":
      return { ok: false, error: "Reviews are disabled or the repository is disconnected." };
    case "no_review_tasks":
      return { ok: false, error: "None of the repository's review tasks can be re-run." };
    case "scm_error":
      return {
        ok: false,
        error: "Couldn't look up the change request on the code host. Try again later.",
      };
  }
}
