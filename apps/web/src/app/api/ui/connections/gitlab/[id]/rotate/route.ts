import { getScmConnectionById } from "@omniralph/db";
import { z } from "zod";
import type { GitLabTokenResult } from "@/lib/api/connections";
import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import { requireOrganizationAccess } from "@/lib/api/scope";
import { rotateGitLabConnectionToken } from "@/lib/connections/gitlab-token";
import { getDb } from "@/lib/db";

type Params = { id: string };

const NOT_FOUND = "That connection doesn't exist.";

/**
 * Rotates a GitLab connection's bot token now and re-checks its health with the daily cron's
 * code, answering the new health; refuses (400) when the token can't be rotated. The
 * connection may belong to any of the user's organizations, where they must be an admin.
 */
export const POST = apiHandler<"member", undefined, undefined, Params>(
  {},
  async ({ user, params }): Promise<GitLabTokenResult> => {
    const db = getDb();
    if (!z.uuid().safeParse(params.id).success) throw ApiRouteError.notFound(NOT_FOUND);
    const connection = await getScmConnectionById(db, params.id);
    if (connection?.provider !== "gitlab") throw ApiRouteError.notFound(NOT_FOUND);
    await requireOrganizationAccess(user, connection.organizationId, {
      role: "admin",
      notFoundMessage: NOT_FOUND,
    });
    const outcome = await rotateGitLabConnectionToken(db, user, connection);
    if (!outcome.ok) throw new ApiRouteError(outcome.status, outcome.error, outcome.code);
    return { health: outcome.health };
  },
);
