import { apiHandler } from "@/lib/api/handler";
import { backlogQuerySchema, type Backlog } from "@/lib/api/backlog";
import { resolveOrganizationScope } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { loadBacklog } from "@/lib/work-items/backlog";

/**
 * The Backlog of the organization scope: work items that route to a repo with Coding on,
 * grouped into Ready to start and Needs refining, filtered by `source` and `repo`, with the
 * filters' options and the organizations whose tracker couldn't be read.
 */
export const GET = apiHandler(
  { query: backlogQuerySchema },
  async ({ user, query }): Promise<Backlog> => {
    const organizations = await resolveOrganizationScope(user, query.organization);
    return loadBacklog({ db: getDb() }, organizations, query);
  },
);
