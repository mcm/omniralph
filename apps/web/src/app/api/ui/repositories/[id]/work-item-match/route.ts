import { apiHandler } from "@/lib/api/handler";
import { requireUuid } from "@/lib/api/resource";
import {
  saveWorkItemMatchRequestSchema,
  type SavedWorkItemMatch,
} from "@/lib/api/work-item-matches";
import { getDb } from "@/lib/db";
import { saveRepositoryWorkItemMatch } from "@/lib/repositories/work-item-match";

/**
 * Saves the repository's work item match (`{ match }`), or clears it (`{ match: null }`).
 * Saving needs the tracker connected (409 otherwise) and a team; the answer's `warnings` name
 * each other repository whose match overlaps this one.
 */
export const PUT = apiHandler<
  "admin",
  typeof saveWorkItemMatchRequestSchema,
  undefined,
  { id: string }
>(
  { access: "admin", body: saveWorkItemMatchRequestSchema },
  async ({ user, params, body }): Promise<SavedWorkItemMatch> =>
    saveRepositoryWorkItemMatch(getDb(), {
      organizationId: user.organization.id,
      repositoryId: requireUuid(params.id),
      userId: user.id,
      match: body.match,
    }),
);
