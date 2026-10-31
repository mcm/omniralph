import { apiHandler } from "@/lib/api/handler";
import { workItemQuerySchema, workItemTaskBodySchema } from "@/lib/api/work-items";
import { getDb } from "@/lib/db";
import { resolveWorkItem } from "@/lib/work-items/item";
import { setWorkItemTask } from "@/lib/work-items/tasks";

/**
 * Checks or unchecks one task of the description's task list (members), in the tracker's
 * current description (409 when the task is gone). Answers the saved description and the
 * new `updatedAt`.
 */
export const PUT = apiHandler<
  "member",
  typeof workItemTaskBodySchema,
  typeof workItemQuerySchema,
  { id: string }
>(
  { body: workItemTaskBodySchema, query: workItemQuerySchema },
  async ({ user, params, query, body }) => {
    const resolved = await resolveWorkItem({ db: getDb() }, user, params.id, query.organization);
    return setWorkItemTask(resolved, body);
  },
);
