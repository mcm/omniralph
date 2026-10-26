import { getScmConnection } from "@omniralph/db";
import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import {
  addRepositoriesSchema,
  LISTING_FAILED,
  selectableRepositoriesQuerySchema,
  type SelectableRepositories,
} from "@/lib/api/repositories";
import { requireUuid } from "@/lib/api/resource";
import { requireOrganizationAccess } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import {
  addGitHubRepositories,
  addGitLabProjects,
  listSelectableRepositories,
} from "@/lib/repositories/manage";
import { loadRepositoryList } from "@/lib/repositories/list";

type Params = { id: string };

/** Answered when the code host couldn't list them: the message is its error, which the picker explains. */
const BAD_GATEWAY = 502;

/**
 * The repositories (GitHub) or projects (GitLab) the connection can access, from the code
 * host, marked with the ones connected here: the picker's list. The connection belongs to
 * `organization` (the active one when left out), where the user must be an admin. Calls the
 * code host, so the picker loads it once and refreshes it on request.
 */
export const GET = apiHandler<
  "member",
  undefined,
  typeof selectableRepositoriesQuerySchema,
  Params
>(
  { query: selectableRepositoriesQuerySchema },
  async ({ user, params, query }): Promise<SelectableRepositories> => {
    const organization = await requireOrganizationAccess(
      user,
      query.organization ?? user.organization.id,
      { role: "admin" },
    );
    const db = getDb();
    const connection = await getScmConnection(db, organization.id, requireUuid(params.id));
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
 * Connects the given repositories of the connection (GitLab: each with a project webhook), or
 * reconnects disconnected ones, with Reviews and Ask on and Coding off. Add-only: a repository
 * not in `ids` is never changed. Admins of `organizationId` only. Answers the repos added
 * and their Repos rail rows.
 */
export const POST = apiHandler<"member", typeof addRepositoriesSchema, undefined, Params>(
  { body: addRepositoriesSchema },
  async ({ user, params, body }) => {
    const organization = await requireOrganizationAccess(user, body.organizationId, {
      role: "admin",
    });
    const db = getDb();
    const result = await (body.provider === "github" ? addGitHubRepositories : addGitLabProjects)(
      db,
      user,
      organization.id,
      requireUuid(params.id),
      body.ids,
    );
    if (!result.ok) return result;
    const { repositories } = await loadRepositoryList(db, [organization], new Date(), {
      repositoryIds: result.added.map((repo) => repo.id),
    });
    return { ...result, repositories };
  },
);
