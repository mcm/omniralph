import { apiHandler } from "@/lib/api/handler";
import { workItemQuerySchema } from "@/lib/api/work-items";
import { getDb } from "@/lib/db";
import { resolveWorkItem } from "@/lib/work-items/item";
import { markWorkItemDone } from "@/lib/work-items/tasks";

/** Mark done (members): moves a manual work item to its team's Done state in the tracker. */
export const POST = apiHandler<"member", undefined, typeof workItemQuerySchema, { id: string }>(
  { query: workItemQuerySchema },
  async ({ user, params, query }) => {
    const resolved = await resolveWorkItem({ db: getDb() }, user, params.id, query.organization);
    await markWorkItemDone(resolved);
    return { ok: true };
  },
);
