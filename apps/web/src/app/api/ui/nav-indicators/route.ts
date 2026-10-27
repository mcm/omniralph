import { apiHandler } from "@/lib/api/handler";
import { navIndicatorsQuerySchema, type NavIndicators } from "@/lib/api/nav-indicators";
import { resolveOrganizationScope } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { loadNavIndicators } from "@/lib/nav/indicators";

/**
 * What the Fleet and Settings nav dots count, for any member: Fleet's agents offline or
 * failing to update in the scope (`organization=all`, an organization's ID, or the active
 * one; another organization is not found), and the active organization's failed deliveries
 * not yet replayed, per connection. A fixed number of queries per organization.
 */
export const GET = apiHandler(
  { query: navIndicatorsQuerySchema },
  async ({ user, query }): Promise<NavIndicators> => {
    const organizations = await resolveOrganizationScope(user, query.organization);
    return loadNavIndicators(getDb(), { organizations, active: user.organization.id });
  },
);
