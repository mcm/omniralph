import { getRepository, getRunAnalytics } from "@omniralph/db";
import { runAnalyticsData } from "@/lib/analytics/display";
import { runAnalyticsQuerySchema, type RunAnalyticsResponse } from "@/lib/api/analytics";
import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import { resolveOrganizationScope } from "@/lib/api/scope";
import { getDb } from "@/lib/db";

/**
 * Stories built, review runs, attempts (and their success rate) and tokens by run kind,
 * per UTC day or week over the last `days` (7, 30 or 90), with totals per repository and
 * per organization: the Analytics screen. Covers the active organization, one of the
 * user's (`organization=<id>`) or all of them (`organization=all`), optionally one
 * repository of those (`repository`; any other is not found). An unknown `days` or
 * `bucket` answers 400.
 */
export const GET = apiHandler(
  { query: runAnalyticsQuerySchema },
  async ({ user, query }): Promise<RunAnalyticsResponse> => {
    const organizations = await resolveOrganizationScope(user, query.organization);
    const organizationIds = organizations.map((o) => o.id);
    const db = getDb();
    if (query.repository) {
      const repository = await getRepository(db, query.repository);
      if (!repository || !organizationIds.includes(repository.organizationId)) {
        throw ApiRouteError.notFound("That repository doesn't exist.");
      }
    }
    const analytics = await getRunAnalytics(db, {
      organizationIds,
      days: query.days,
      bucket: query.bucket,
      repositoryId: query.repository,
    });
    return runAnalyticsData(analytics);
  },
);
