import { apiHandler } from "@/lib/api/handler";
import { workItemQuerySchema } from "@/lib/api/work-items";
import { getDb } from "@/lib/db";
import { userDisplayName } from "@/lib/user-display";
import { startWorkItem } from "@/lib/work-items/actions";
import { resolveWorkItem } from "@/lib/work-items/item";

/** Start epic (members): delegates a Ready to start item to Om, which starts its run as a delegation in Linear does. 409 when it has a run, 400 unless it's Ready to start. */
export const POST = apiHandler<"member", undefined, typeof workItemQuerySchema, { id: string }>(
  { query: workItemQuerySchema },
  async ({ user, params, query }) => {
    const db = getDb();
    const resolved = await resolveWorkItem({ db }, user, params.id, query.organization);
    await startWorkItem(db, resolved, { userId: user.id, name: userDisplayName(user) });
    return { ok: true };
  },
);
