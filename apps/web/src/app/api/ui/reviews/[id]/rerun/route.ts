import { RerunReviewInput } from "@omniralph/shared";
import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import { requireUuid } from "@/lib/api/resource";
import type { RerunResult } from "@/lib/api/reviews";
import { getDb } from "@/lib/db";
import { getDispatcher } from "@/lib/dispatch";
import { REVIEW_NOT_FOUND, rerunOrganizationReview } from "@/lib/reviews/manage";

/**
 * Re-runs the review on its PR's current head (admins; body `RerunReviewInput`) and answers
 * the review to open: the new one, or the one of the same head already queued or running
 * (`active`). A closed or merged PR, a disabled repository or a code-host failure is a 400
 * with the reason; another organization's review is a 404.
 */
export const POST = apiHandler<"admin", typeof RerunReviewInput, undefined, { id: string }>(
  { access: "admin", body: RerunReviewInput },
  async ({ user, params, body }): Promise<RerunResult | { ok: false; error: string }> => {
    const result = await rerunOrganizationReview(
      getDb(),
      getDispatcher(),
      user.organization.id,
      requireUuid(params.id),
      body,
    );
    if (result.ok) return { ok: true, reviewId: result.reviewId, active: false };
    if (result.activeReviewId) {
      return { ok: true, reviewId: result.activeReviewId, active: true, message: result.error };
    }
    if (result.notFound) throw ApiRouteError.notFound(REVIEW_NOT_FOUND);
    return { ok: false, error: result.error };
  },
);
