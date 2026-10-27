import { listWorkItemTargets } from "@omniralph/db";
import { apiHandler } from "@/lib/api/handler";
import { resolveOrganizationScope } from "@/lib/api/scope";
import {
  workItemTargetsQuerySchema,
  type WorkItemTarget,
  type WorkItemTargetList,
} from "@/lib/api/work-items";
import { getDb } from "@/lib/db";

/**
 * New work item's repos (members): the scope's connected repos with Coding on and a work
 * item match, each with the team and project its match creates work items in. By
 * organization name, then path.
 */
export const GET = apiHandler(
  { query: workItemTargetsQuerySchema },
  async ({ user, query }): Promise<WorkItemTargetList> => {
    const organizations = await resolveOrganizationScope(user, query.organization);
    const sorted = [...organizations].sort((a, b) => a.name.localeCompare(b.name));
    const targets: WorkItemTarget[] = [];
    for (const organization of sorted) {
      for (const { repository, match } of await listWorkItemTargets(getDb(), organization.id)) {
        if (match.tracker !== "linear") continue;
        targets.push({
          repository: {
            ...repository,
            name: repository.fullPath.split("/").pop() ?? repository.fullPath,
          },
          organization,
          tracker: match.tracker,
          team: match.team,
          project: match.withoutProject ? null : match.project,
        });
      }
    }
    return { targets };
  },
);
