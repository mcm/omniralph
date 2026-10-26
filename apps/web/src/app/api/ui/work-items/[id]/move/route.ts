import { apiHandler } from "@/lib/api/handler";
import { workItemMoveBodySchema, workItemQuerySchema } from "@/lib/api/work-items";
import { getDb } from "@/lib/db";
import { userDisplayName } from "@/lib/user-display";
import { moveWorkItemToNeedsRefining } from "@/lib/work-items/actions";
import { resolveWorkItem } from "@/lib/work-items/item";

/** Move to Needs refining (members): the tracker integration's mapped Needs-refining state. */
export const POST = apiHandler<
  "member",
  typeof workItemMoveBodySchema,
  typeof workItemQuerySchema,
  { id: string }
>({ body: workItemMoveBodySchema, query: workItemQuerySchema }, async ({ user, params, query }) => {
  const db = getDb();
  const resolved = await resolveWorkItem({ db }, user, params.id, query.organization);
  await moveWorkItemToNeedsRefining(db, resolved, { userId: user.id, name: userDisplayName(user) });
  return { ok: true };
});
