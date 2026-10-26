import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import { requireRepositoryAccess } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { recreateGitLabWebhook } from "@/lib/repositories/manage";

/**
 * Recreates the GitLab project's webhook and clears its webhook problems from the connection's
 * health (admins of the repository's organization, whichever of theirs is active).
 */
export const POST = apiHandler<"member", undefined, undefined, { id: string }>(
  {},
  async ({ user, params }) => {
    const { repository, organization } = await requireRepositoryAccess(user, params.id, "admin");
    if (repository.disconnectedAt) throw ApiRouteError.notFound();
    return recreateGitLabWebhook(getDb(), user, organization.id, params.id);
  },
);
