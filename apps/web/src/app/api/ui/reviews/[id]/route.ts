import { getReviewDetail } from "@omniralph/db";
import { z } from "zod";
import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import { requireResourceInActiveOrganization } from "@/lib/api/resource";
import type { ReviewDetail } from "@/lib/api/reviews";
import { getDb } from "@/lib/db";
import { reviewDetailView } from "@/lib/reviews/history";

type Params = { id: string };

const detailQuery = z.object({ next: z.string().max(2000).optional() });

/**
 * A review of the active organization with its findings (grouped by file, with their
 * feedback) and the newer review of its PR: polled by its page, so findings appear when the
 * review completes. `?next=` is the page asking: when the review is another of the user's
 * organizations', the 409 that switches to it comes back there.
 */
export const GET = apiHandler<"member", undefined, typeof detailQuery, Params>(
  { query: detailQuery },
  async ({ user, params, query }): Promise<ReviewDetail> => {
    await requireResourceInActiveOrganization(user, "review", params.id, {
      pathPrefix: `/reviews/${params.id}`,
      next: query.next,
    });
    const detail = await getReviewDetail(getDb(), user.organization.id, params.id);
    if (!detail) throw ApiRouteError.notFound();
    return { review: reviewDetailView(detail) };
  },
);
