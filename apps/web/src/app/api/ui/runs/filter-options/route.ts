import { listRunFilterRepositories } from "@omniralph/db";
import { apiHandler } from "@/lib/api/handler";
import { runFilterOptionsQuerySchema, type RunFilterOptions } from "@/lib/api/runs";
import { resolveOrganizationScope } from "@/lib/api/scope";
import { getDb } from "@/lib/db";

/**
 * What the Runs screen's filters offer beyond the fixed kinds and statuses: the
 * repositories in scope (the active organization, one of the user's, or all of them with
 * `organization=all`), by full path. An organization outside the memberships is not found.
 */
export const GET = apiHandler(
  { access: "member", query: runFilterOptionsQuerySchema },
  async ({ user, query }): Promise<RunFilterOptions> => {
    const organizations = await resolveOrganizationScope(user, query.organization);
    const byId = new Map(organizations.map((o) => [o.id, o]));
    const repositories = await listRunFilterRepositories(getDb(), [...byId.keys()]);
    return {
      repositories: repositories.map(({ id, provider, fullPath, organizationId }) => {
        const { name, role } = byId.get(organizationId)!;
        return { id, provider, fullPath, organization: { id: organizationId, name, role } };
      }),
    };
  },
);
