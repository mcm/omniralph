"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { bucketFor, type AnalyticsParams } from "@/lib/analytics/display";
import { runAnalyticsResponseSchema } from "@/lib/api/analytics";
import { api } from "@/lib/api/client";
import { analyticsKeys } from "@/lib/api/keys";
import type { ScopeParam } from "@/screens/scope";

/**
 * Analytics refetch on live run changes at most this often: aggregates over days don't
 * move in seconds, and each refetch scans them.
 */
export const ANALYTICS_LIVE_THROTTLE_MS = 10_000;

/**
 * The scope's run analytics for the window and repository (`GET /api/ui/analytics/runs`),
 * by day for 7 and 30 days and by week for 90. A live query: `run` change events of the
 * organizations it covers refetch it, at most once per `ANALYTICS_LIVE_THROTTLE_MS` with a
 * trailing refetch; it polls only through the live layer's fallback while realtime is down.
 * The previous window or repository stays while the next one loads.
 */
export function useRunAnalytics(params: AnalyticsParams, scope: ScopeParam) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: analyticsKeys(keys).list({
      days: params.days,
      repositoryId: params.repositoryId,
      organization: scope,
    }),
    queryFn: ({ signal }) =>
      api.get("/api/ui/analytics/runs", runAnalyticsResponseSchema, {
        params: {
          days: params.days,
          bucket: bucketFor(params.days),
          repository: params.repositoryId ?? undefined,
          organization: scope,
        },
        organizationId: organization.id,
        signal,
      }),
    placeholderData: keepPreviousData,
    meta: { liveThrottleMs: ANALYTICS_LIVE_THROTTLE_MS },
  });
}
