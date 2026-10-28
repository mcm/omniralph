import { getRunAnalytics, listAnalyticsRepositories } from "@omniralph/db";
import { runAnalyticsData, type RunAnalyticsPayload } from "@/lib/analytics/display";
import { runAnalyticsQuerySchema } from "@/lib/api/analytics";
import { apiHandler } from "@/lib/api/handler";
import { resolveOrganizationScope } from "@/lib/api/scope";
import { getDb } from "@/lib/db";

/**
 * Stories built, review runs, attempts (and their success rate) and tokens by run kind,
 * per UTC day or week over the last `days` (7, 30 or 90), with totals per repository (and
 * its organization) and per organization: the Analytics screen. Covers the active
 * organization, one of the user's (`organization=<id>`) or all of them
 * (`organization=all`), optionally one repository of those (`repository`; any other is
 * ignored, as `params.repositoryId: null` tells). Also answers every repository of the
 * scope, for the screen's filter. An unknown `days` or `bucket` answers 400. Each token figure
 * carries its list price (`costUsd`, and `unpricedAttempts` when the sum leaves out
 * token-bearing attempts with no list price; see `RunCost`): the totals only when the window
 * has a priced attempt.
 */
export const GET = apiHandler(
  { query: runAnalyticsQuerySchema },
  async ({ user, query }): Promise<RunAnalyticsPayload> => {
    const organizations = await resolveOrganizationScope(user, query.organization);
    const organizationIds = organizations.map((o) => o.id);
    const db = getDb();
    const repositories = await listAnalyticsRepositories(db, organizationIds);
    const repositoryId =
      query.repository && repositories.some((r) => r.id === query.repository)
        ? query.repository
        : null;
    const analytics = await getRunAnalytics(db, {
      organizationIds,
      days: query.days,
      bucket: query.bucket,
      repositoryId: repositoryId ?? undefined,
    });
    return {
      ...runAnalyticsData(analytics),
      repositories,
      params: { days: query.days, bucket: query.bucket, repositoryId },
    };
  },
);
