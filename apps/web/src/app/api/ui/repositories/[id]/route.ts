import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import type { RepositoryDetail } from "@/lib/api/repositories";
import { requireRepositoryAccess } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { loadRepositoryDetail } from "@/lib/repositories/detail";
import { disconnectRepository } from "@/lib/repositories/manage";

type Params = { id: string };

/**
 * The Repos page's repo: a connected repository of any of the user's organizations with
 * its header, status and every card (`repositoryDetailSchema`). Another organization's
 * repository, or a disconnected one, is not found.
 */
export const GET = apiHandler<"member", undefined, undefined, Params>(
  {},
  async ({ user, params }): Promise<RepositoryDetail> => {
    const { organization } = await requireRepositoryAccess(user, params.id);
    return loadRepositoryDetail(getDb(), organization, params.id);
  },
);

/**
 * Removes the repository (admins of its organization): Reviews, Coding and Ask stop, its work
 * item match, pins and (GitLab) webhook are removed, its review history is kept. Publishes the
 * `repository` change (the repo and its organization's list).
 */
export const DELETE = apiHandler<"member", undefined, undefined, Params>(
  {},
  async ({ user, params }) => {
    const { repository, organization } = await requireRepositoryAccess(user, params.id, "admin");
    if (repository.disconnectedAt) throw ApiRouteError.notFound();
    return disconnectRepository(getDb(), user, organization.id, repository.id);
  },
);
