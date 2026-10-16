import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./client";

/** How often a mounted query refetches while its tab is visible. */
export const LIVE_REFETCH_INTERVAL = 3_000;
/** For settings and definitions, which change rarely and only through the panel. */
export const SETTINGS_REFETCH_INTERVAL = 30_000;
/** For analytics: aggregates over days don't move in seconds, and each poll scans them. */
export const ANALYTICS_REFETCH_INTERVAL = 60_000;
/** Attempts after the first before a query shows its error. */
const QUERY_RETRIES = 3;

/**
 * Retries a failed query unless the server answered for good: a 4xx other than a timeout
 * or rate limit (signed out, forbidden, not found, invalid, organization switched) won't
 * change by asking again.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= QUERY_RETRIES) return false;
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
    return error.status === 408 || error.status === 429;
  }
  return true;
}

/**
 * The panel's `QueryClient` (one per browser session, provided by `QueryProvider`): every
 * query is live by default, polling every 3s while the tab is visible, refetching when the
 * tab regains focus or the network reconnects, and always stale so a mount refetches.
 * Queries that call an external API (Linear, GitHub, GitLab) opt out with
 * `refetchInterval: false` and refresh explicitly; settings may poll at
 * `SETTINGS_REFETCH_INTERVAL`. Mutations never retry (they may not be idempotent).
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchInterval: LIVE_REFETCH_INTERVAL,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        staleTime: 0,
        retry: shouldRetryQuery,
        retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 10_000),
      },
      mutations: { retry: false },
    },
  });
}
