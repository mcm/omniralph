import { getAnalytics, getRalphAnalytics, listAnalyticsRepositories } from "@omniralph/db";
import { z } from "zod";
import { analyticsData, parseAnalyticsParams, ralphAnalyticsData } from "@/lib/analytics/display";
import type { AnalyticsResponse } from "@/lib/api/analytics";
import { apiHandler } from "@/lib/api/handler";
import { getDb } from "@/lib/db";

const analyticsQuery = z.object({ days: z.string().optional(), repo: z.string().optional() });

/**
 * The active organization's analytics over the last `days` (7, 30 or 90; default 30), for
 * one of its repositories (`repo`) or all of them: the Analytics page, polled. A window or
 * repository it doesn't know is ignored.
 */
export const GET = apiHandler(
  { query: analyticsQuery },
  async ({ user, query }): Promise<AnalyticsResponse> => {
    const db = getDb();
    const repositories = await listAnalyticsRepositories(db, user.organization.id);
    const params = parseAnalyticsParams(
      query,
      repositories.map((r) => r.id),
    );
    const filter = {
      organizationId: user.organization.id,
      days: params.days,
      repositoryId: params.repositoryId ?? undefined,
    };
    const [analytics, ralph] = await Promise.all([
      getAnalytics(db, filter),
      getRalphAnalytics(db, filter),
    ]);
    return {
      analytics: analyticsData(analytics),
      ralph: ralphAnalyticsData(ralph),
      repositories,
      params,
    };
  },
);
