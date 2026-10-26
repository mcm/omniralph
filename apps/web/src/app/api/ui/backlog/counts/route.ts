import { apiHandler } from "@/lib/api/handler";
import { backlogScopeQuerySchema, type BacklogCounts } from "@/lib/api/backlog";
import { resolveOrganizationScope } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { loadBacklogCounts } from "@/lib/work-items/backlog";

/** How many work items each Backlog group has (the nav count), from the same cached list. */
export const GET = apiHandler(
  { query: backlogScopeQuerySchema },
  async ({ user, query }): Promise<BacklogCounts> => {
    const organizations = await resolveOrganizationScope(user, query.organization);
    return loadBacklogCounts({ db: getDb() }, organizations);
  },
);
