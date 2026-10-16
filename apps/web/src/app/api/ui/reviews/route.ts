import { getRepositoryWithConnection, listReviews, REVIEW_PAGE_SIZE } from "@omniralph/db";
import { z } from "zod";
import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import { requireResourceInActiveOrganization } from "@/lib/api/resource";
import type { ReviewList } from "@/lib/api/reviews";
import { getDb } from "@/lib/db";
import { repositoryWebUrl } from "@/lib/repositories/web-url";
import { parseReviewListParams } from "@/lib/reviews/display";
import { reviewRow } from "@/lib/reviews/history";

const listQuery = z.object({
  status: z.string().optional(),
  trigger: z.string().optional(),
  page: z.string().optional(),
  repository: z.string().optional(),
  next: z.string().max(2000).optional(),
});

/**
 * A page of the active organization's reviews, newest first, filtered by status and trigger
 * (unknown values are ignored): the Reviews page, polled. With `repository`, that
 * repository's reviews and the repository itself (Repository › Reviews; a disconnected one's
 * history stays browsable); `?next=` is the page asking, for the 409 that switches to the
 * repository's organization when it's another of the user's.
 */
export const GET = apiHandler(
  { query: listQuery },
  async ({ user, query }): Promise<ReviewList> => {
    const db = getDb();
    const organizationId = user.organization.id;
    const params = parseReviewListParams(query);
    const repositoryId = query.repository;
    let repository: ReviewList["repository"] = null;
    if (repositoryId !== undefined) {
      await requireResourceInActiveOrganization(user, "repository", repositoryId, {
        pathPrefix: `/repositories/${repositoryId}`,
        next: query.next,
      });
      const found = await getRepositoryWithConnection(db, repositoryId, organizationId);
      if (!found) throw ApiRouteError.notFound();
      const { repository: row, connection } = found;
      repository = {
        id: row.id,
        provider: row.provider,
        fullPath: row.fullPath,
        webUrl: repositoryWebUrl(row.provider, connection.baseUrl, row.fullPath),
        connected: row.disconnectedAt === null,
      };
    }
    const page = await listReviews(db, {
      organizationId,
      repositoryId,
      status: params.status ?? undefined,
      trigger: params.trigger ?? undefined,
      page: params.page,
      pageSize: REVIEW_PAGE_SIZE,
    });
    return {
      reviews: page.reviews.map(reviewRow),
      page: params.page,
      pageSize: page.pageSize,
      total: page.total,
      repository,
    };
  },
);
