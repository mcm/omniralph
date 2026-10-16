import { getScmConnection } from "@omniralph/db";
import { z } from "zod";
import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import {
  LISTING_FAILED,
  saveSelectionSchema,
  type SelectableRepositories,
} from "@/lib/api/repositories";
import { requireUuid } from "@/lib/api/resource";
import { getDb } from "@/lib/db";
import {
  listSelectableRepositories,
  saveGitHubRepositories,
  saveGitLabProjects,
} from "@/lib/repositories/manage";

type Params = { id: string };

/** Answered when the code host couldn't list them: the message is its error, which the picker explains. */
const BAD_GATEWAY = 502;

const listQuery = z.object({ provider: z.enum(["github", "gitlab"]) });

/**
 * The repositories (GitHub) or projects (GitLab) the connection can access, from the code
 * host, marked with the ones reviewed here: the picker's list. Calls the code host, so the
 * picker loads it once and refreshes it on request.
 */
export const GET = apiHandler<"admin", undefined, typeof listQuery, Params>(
  { access: "admin", query: listQuery },
  async ({ user, params, query }): Promise<SelectableRepositories> => {
    const db = getDb();
    const connection = await getScmConnection(db, user.organization.id, requireUuid(params.id));
    if (
      !connection ||
      connection.provider !== query.provider ||
      (connection.provider === "github" && !connection.externalId)
    ) {
      throw ApiRouteError.notFound();
    }
    try {
      return await listSelectableRepositories(db, connection);
    } catch (cause) {
      throw new ApiRouteError(
        BAD_GATEWAY,
        cause instanceof Error ? cause.message : String(cause),
        LISTING_FAILED,
      );
    }
  },
);

/**
 * Saves which of the listed repositories are reviewed: selected ones are connected (GitLab:
 * with a project webhook) or re-enabled, the other listed ones are disabled.
 */
export const PUT = apiHandler<"admin", typeof saveSelectionSchema, undefined, Params>(
  { access: "admin", body: saveSelectionSchema },
  async ({ user, params, body }) =>
    (body.provider === "github" ? saveGitHubRepositories : saveGitLabProjects)(
      getDb(),
      user.organization.id,
      requireUuid(params.id),
      body.selectedIds,
    ),
);
