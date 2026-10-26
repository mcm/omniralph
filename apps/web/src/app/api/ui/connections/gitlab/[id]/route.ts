import { getScmConnectionById } from "@omniralph/db";
import { z } from "zod";
import { replaceGitLabTokenSchema, type GitLabTokenResult } from "@/lib/api/connections";
import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import { requireOrganizationAccess } from "@/lib/api/scope";
import { replaceGitLabConnectionToken } from "@/lib/connections/gitlab-token";
import { getDb } from "@/lib/db";

type Params = { id: string };

const NOT_FOUND = "That connection doesn't exist.";

/**
 * Replaces a GitLab connection's bot token with `{ token }`, which must belong to the same
 * GitLab user (else 400), and answers the re-checked health. The connection may belong to any
 * of the user's organizations, where they must be an admin.
 */
export const PUT = apiHandler<"member", typeof replaceGitLabTokenSchema, undefined, Params>(
  { body: replaceGitLabTokenSchema },
  async ({ user, params, body }): Promise<GitLabTokenResult> => {
    const db = getDb();
    if (!z.uuid().safeParse(params.id).success) throw ApiRouteError.notFound(NOT_FOUND);
    const connection = await getScmConnectionById(db, params.id);
    if (connection?.provider !== "gitlab") throw ApiRouteError.notFound(NOT_FOUND);
    await requireOrganizationAccess(user, connection.organizationId, {
      role: "admin",
      notFoundMessage: NOT_FOUND,
    });
    const outcome = await replaceGitLabConnectionToken(db, user, connection, body.token);
    if (!outcome.ok) throw new ApiRouteError(outcome.status, outcome.error, outcome.code);
    return { health: outcome.health };
  },
);
