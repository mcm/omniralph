import { apiHandler } from "@/lib/api/handler";
import { workItemQuerySchema, type WorkItemDetail } from "@/lib/api/work-items";
import { getDb } from "@/lib/db";
import { loadWorkItemDetail } from "@/lib/work-items/detail";
import { resolveWorkItem } from "@/lib/work-items/item";

/**
 * A work item of any of the user's organizations (members): its row, PRD, route, stories,
 * activity, triage and run, and what the user can do with it now. 404 for an item outside
 * their organizations.
 */
export const GET = apiHandler<"member", undefined, typeof workItemQuerySchema, { id: string }>(
  { query: workItemQuerySchema },
  async ({ user, params, query }): Promise<WorkItemDetail> => {
    const db = getDb();
    const resolved = await resolveWorkItem({ db }, user, params.id, query.organization);
    return loadWorkItemDetail(db, resolved);
  },
);
