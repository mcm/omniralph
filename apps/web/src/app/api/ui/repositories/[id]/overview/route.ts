import { z } from "zod";
import { apiHandler } from "@/lib/api/handler";
import type { LegacyRepositoryDetail } from "@/lib/api/repositories";
import { requireResourceInActiveOrganization } from "@/lib/api/resource";
import { loadLegacyRepositoryDetail } from "@/lib/repositories/detail";

type Params = { id: string };

const detailQuery = z.object({ next: z.string().max(2000).optional() });

/**
 * The old repository settings pages' repository, until they're removed: a connected
 * repository of the active organization with what its Review settings and Agents tabs show.
 * `?next=` is the page asking: when the repository is another of the user's organizations',
 * the 409 that switches to it comes back there.
 */
export const GET = apiHandler<"member", undefined, typeof detailQuery, Params>(
  { query: detailQuery },
  async ({ user, params, query }): Promise<LegacyRepositoryDetail> => {
    await requireResourceInActiveOrganization(user, "repository", params.id, {
      pathPrefix: `/repositories/${params.id}`,
      next: query.next,
    });
    return loadLegacyRepositoryDetail(user.organization.id, params.id);
  },
);
