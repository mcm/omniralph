import { apiHandler } from "@/lib/api/handler";
import { workItemQuerySchema } from "@/lib/api/work-items";
import { getDb } from "@/lib/db";
import { userDisplayName } from "@/lib/user-display";
import { cancelWorkItem } from "@/lib/work-items/actions";
import { resolveWorkItem } from "@/lib/work-items/item";

/** Remove from backlog (members): cancels the item in its tracker. */
export const POST = apiHandler<"member", undefined, typeof workItemQuerySchema, { id: string }>(
  { query: workItemQuerySchema },
  async ({ user, params, query }) => {
    const db = getDb();
    const resolved = await resolveWorkItem({ db }, user, params.id, query.organization);
    await cancelWorkItem(db, resolved, { userId: user.id, name: userDisplayName(user) });
    return { ok: true };
  },
);
