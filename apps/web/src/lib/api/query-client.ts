import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./client";

/**
 * How often a mounted query refetches while live updates are down or off (the realtime
 * connection is lost, or Ably isn't configured). While connected, queries don't poll:
 * change events invalidate them (`src/lib/live`).
 */
export const FALLBACK_POLL_INTERVAL = 10_000;
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

/** Each client's switch between "live" (no polling) and fallback polling. */
const fallbackPolling = new WeakMap<QueryClient, { polling: boolean }>();

/**
 * Turns the default polling on (`FALLBACK_POLL_INTERVAL`) or off, for every mounted query
 * at once; the live data layer calls it as the realtime connection comes and goes.
 * Queries with their own `refetchInterval` keep it.
 */
export function setFallbackPolling(client: QueryClient, polling: boolean): void {
  const state = fallbackPolling.get(client);
  if (!state || state.polling === polling) return;
  state.polling = polling;
  // Observers compute their interval when their options are set or a fetch settles:
  // setting their own options again reschedules (or clears) the timer now.
  for (const query of client.getQueryCache().getAll()) {
    for (const observer of query.observers) observer.setOptions(observer.options);
  }
}

/** Whether the client's queries are polling at the fallback interval. */
export function isFallbackPolling(client: QueryClient): boolean {
  return fallbackPolling.get(client)?.polling ?? false;
}

/**
 * The panel's `QueryClient` (one per browser session, provided by `QueryProvider`): every
 * query is live by default. Change events invalidate the queries they affect while the
 * realtime connection is up; while it's down (or realtime is off) mounted queries poll at
 * `FALLBACK_POLL_INTERVAL`, which is the state a new client starts in. Queries refetch
 * when the tab regains focus or the network reconnects, and are always stale so a mount
 * refetches. Queries that call an external API (a tracker or code host) opt out with
 * `refetchInterval: false` and refresh explicitly. Mutations never retry (they may not be
 * idempotent).
 */
export function createQueryClient(): QueryClient {
  const state = { polling: true };
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        refetchInterval: () => (state.polling ? FALLBACK_POLL_INTERVAL : false),
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
  fallbackPolling.set(client, state);
  return client;
}
