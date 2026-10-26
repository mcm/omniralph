import { apiHandler } from "@/lib/api/handler";
import { workItemQuerySchema } from "@/lib/api/work-items";
import { getDb } from "@/lib/db";
import { userDisplayName } from "@/lib/user-display";
import { triageWorkItem } from "@/lib/work-items/actions";
import { resolveWorkItem } from "@/lib/work-items/item";

/** Triage now (members): starts Om's triage of the item. 409 while a triage is queued or running. */
export const POST = apiHandler<"member", undefined, typeof workItemQuerySchema, { id: string }>(
  { query: workItemQuerySchema },
  async ({ user, params, query }) => {
    const db = getDb();
    const resolved = await resolveWorkItem({ db }, user, params.id, query.organization);
    await triageWorkItem(db, resolved, { userId: user.id, name: userDisplayName(user) });
    return { ok: true };
  },
);
