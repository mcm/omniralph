import { apiHandler } from "@/lib/api/handler";
import { backlogScopeQuerySchema, type BacklogUpNext } from "@/lib/api/backlog";
import { resolveOrganizationScope } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { loadBacklogUpNext } from "@/lib/work-items/backlog";

/** Up next in the empty Inbox: the Backlog's first three Ready and two Needs refining items. */
export const GET = apiHandler(
  { query: backlogScopeQuerySchema },
  async ({ user, query }): Promise<BacklogUpNext> => {
    const organizations = await resolveOrganizationScope(user, query.organization);
    return loadBacklogUpNext({ db: getDb() }, organizations);
  },
);
