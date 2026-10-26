import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import { requireRepositoryAccess } from "@/lib/api/scope";
import { createWorkItemBodySchema, type CreateWorkItemResponse } from "@/lib/api/work-items";
import { getDb } from "@/lib/db";
import { userDisplayName } from "@/lib/user-display";
import { REPOSITORY_NOT_FOUND_MESSAGE, createWorkItem } from "@/lib/work-items/create";

/** HTTP statuses of the create service's refusals. */
const STATUS = {
  invalid: 400,
  repository_not_found: 404,
  coding_off: 400,
  no_work_item_match: 400,
  tracker_not_connected: 400,
  tracker_failed: 502,
} as const;

/**
 * New work item (members): creates a work item for a repo of one of the user's organizations
 * (another organization's repo is not found) in the team, project and labels of its work item
 * match, optionally triaging it at once. Answers the new Backlog row.
 */
export const POST = apiHandler<"member", typeof createWorkItemBodySchema>(
  { body: createWorkItemBodySchema },
  async ({ user, body }): Promise<CreateWorkItemResponse> => {
    const { organization } = await requireRepositoryAccess(user, body.repositoryId, "member", {
      notFoundMessage: REPOSITORY_NOT_FOUND_MESSAGE,
    });
    const result = await createWorkItem(
      { db: getDb() },
      {
        organizationId: organization.id,
        repositoryId: body.repositoryId,
        title: body.title,
        description: body.description,
        triageNow: body.triageNow,
        actor: { userId: user.id, name: userDisplayName(user) },
        origin: "backlog",
      },
    );
    if (!result.ok) {
      throw new ApiRouteError(
        STATUS[result.code],
        result.message,
        result.code,
        result.code === "invalid" ? { title: result.message } : undefined,
      );
    }
    return {
      item: {
        ...result.item,
        organization: { ...result.item.organization, role: organization.role },
      },
      triage: result.triage,
      ...(result.triageError !== undefined && { triageError: result.triageError }),
    };
  },
);
