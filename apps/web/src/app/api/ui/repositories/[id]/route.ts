import { z } from "zod";
import { apiHandler } from "@/lib/api/handler";
import type { RepositoryDetail } from "@/lib/api/repositories";
import { requireResourceInActiveOrganization, requireUuid } from "@/lib/api/resource";
import { getDb } from "@/lib/db";
import { loadRepositoryDetail } from "@/lib/repositories/detail";
import { disconnectRepository } from "@/lib/repositories/manage";

type Params = { id: string };

const detailQuery = z.object({ next: z.string().max(2000).optional() });

/**
 * A connected repository of the active organization with what its Review settings and
 * Agents tabs show: polled by its settings pages. `?next=` is the page asking: when the
 * repository is another of the user's organizations', the 409 that switches to it comes
 * back there.
 */
export const GET = apiHandler<"member", undefined, typeof detailQuery, Params>(
  { query: detailQuery },
  async ({ user, params, query }): Promise<RepositoryDetail> => {
    await requireResourceInActiveOrganization(user, "repository", params.id, {
      pathPrefix: `/repositories/${params.id}`,
      next: query.next,
    });
    return loadRepositoryDetail(user.organization.id, params.id);
  },
);

/**
 * Disconnects the repository: reviews stop, its pins and (GitLab) webhook are removed, its
 * review history is kept.
 */
export const DELETE = apiHandler<"admin", undefined, undefined, Params>(
  { access: "admin" },
  async ({ user, params }) => disconnectRepository(getDb(), user, requireUuid(params.id)),
);
