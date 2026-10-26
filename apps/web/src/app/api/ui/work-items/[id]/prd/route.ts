import { apiHandler } from "@/lib/api/handler";
import { workItemPrdBodySchema, workItemQuerySchema } from "@/lib/api/work-items";
import { getDb } from "@/lib/db";
import { userDisplayName } from "@/lib/user-display";
import { saveWorkItemPrd } from "@/lib/work-items/actions";
import { resolveWorkItem } from "@/lib/work-items/item";

/**
 * Edit PRD (members): saves the description to the tracker, unless it changed there since
 * `baseUpdatedAt` or Om is working on the item (409). Answers the new `updatedAt`.
 */
export const PUT = apiHandler<
  "member",
  typeof workItemPrdBodySchema,
  typeof workItemQuerySchema,
  { id: string }
>(
  { body: workItemPrdBodySchema, query: workItemQuerySchema },
  async ({ user, params, query, body }) => {
    const db = getDb();
    const resolved = await resolveWorkItem({ db }, user, params.id, query.organization);
    return saveWorkItemPrd(db, resolved, { userId: user.id, name: userDisplayName(user) }, body);
  },
);
