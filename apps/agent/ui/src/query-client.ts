/**
 * The page's `QueryClient`. While the live stream is up, queries never poll: change events
 * invalidate them (`./live`). While it is down they poll every `FALLBACK_POLL_INTERVAL`
 * (`setFallbackPolling`); a new client starts not polling, because the stream is connecting
 * and every query fetches on mount anyway.
 */
import { QueryClient } from "@tanstack/react-query";
import { LocalApiError } from "./api.js";

export const FALLBACK_POLL_INTERVAL = 10_000;
/** Attempts after the first before a query shows its error. */
const QUERY_RETRIES = 2;

/** Retries a failed query unless the agent answered for good (a 4xx). */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= QUERY_RETRIES) return false;
  return !(error instanceof LocalApiError && error.status >= 400 && error.status < 500);
}

const fallbackPolling = new WeakMap<QueryClient, { polling: boolean }>();

/** Turns polling on or off for every mounted query at once. */
export function setFallbackPolling(client: QueryClient, polling: boolean): void {
  const state = fallbackPolling.get(client);
  if (!state || state.polling === polling) return;
  state.polling = polling;
  // An observer computes its interval when its options are set: setting them again
  // reschedules (or clears) the timer now.
  for (const query of client.getQueryCache().getAll()) {
    for (const observer of query.observers) observer.setOptions(observer.options);
  }
}

export function isFallbackPolling(client: QueryClient): boolean {
  return fallbackPolling.get(client)?.polling ?? false;
}

export function createAgentQueryClient(): QueryClient {
  const state = { polling: false };
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        refetchInterval: () => (state.polling ? FALLBACK_POLL_INTERVAL : false),
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: true,
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
