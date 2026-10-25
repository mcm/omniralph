"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { DEFAULT_ANALYTICS_RANGE, type AnalyticsParams } from "@/lib/analytics/display";
import { analyticsResponseSchema } from "@/lib/api/analytics";
import { api } from "@/lib/api/client";

/**
 * Analytics refetch on live run changes at most this often: aggregates over days don't
 * move in seconds, and each refetch scans them.
 */
export const ANALYTICS_LIVE_THROTTLE_MS = 10_000;

/**
 * The organization's analytics for the page's window and repository: refetched on live
 * run changes (throttled, `ANALYTICS_LIVE_THROTTLE_MS`), and when the tab regains focus.
 */
export function useAnalytics(params: AnalyticsParams) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: keys.analytics.list({ ...params }),
    queryFn: ({ signal }) =>
      api.get("/api/ui/analytics", analyticsResponseSchema, {
        params: {
          days: params.days === DEFAULT_ANALYTICS_RANGE ? undefined : params.days,
          repo: params.repositoryId ?? undefined,
        },
        organizationId: organization.id,
        signal,
      }),
    // The previous window or repository stays (dimmed) while the new one loads.
    placeholderData: keepPreviousData,
    meta: { liveThrottleMs: ANALYTICS_LIVE_THROTTLE_MS },
  });
}
