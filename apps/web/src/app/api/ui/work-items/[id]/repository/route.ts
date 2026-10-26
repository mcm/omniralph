import { apiHandler } from "@/lib/api/handler";
import { workItemQuerySchema, workItemRepositoryBodySchema } from "@/lib/api/work-items";
import { getDb } from "@/lib/db";
import { userDisplayName } from "@/lib/user-display";
import { setWorkItemRepositoryChoice } from "@/lib/work-items/actions";
import { resolveWorkItem } from "@/lib/work-items/item";

/**
 * Change repo… (members): the repo Om builds the item in when it starts (one of its
 * organization's repos with Coding on), or null to route it by the rules again.
 */
export const PUT = apiHandler<
  "member",
  typeof workItemRepositoryBodySchema,
  typeof workItemQuerySchema,
  { id: string }
>(
  { body: workItemRepositoryBodySchema, query: workItemQuerySchema },
  async ({ user, params, query, body }) => {
    const db = getDb();
    const resolved = await resolveWorkItem({ db }, user, params.id, query.organization);
    return setWorkItemRepositoryChoice(
      db,
      resolved,
      { userId: user.id, name: userDisplayName(user) },
      body.repositoryId,
    );
  },
);
