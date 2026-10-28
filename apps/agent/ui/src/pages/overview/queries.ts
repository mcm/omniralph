/**
 * The attempts' queries: the list (`GET /api/attempts`), one attempt with its transcript and
 * log (`GET /api/attempts/{id}`), and the live log lines `logs` events deliver.
 */
import { skipToken, useQuery } from "@tanstack/react-query";
import type { LogEntry } from "../../../../src/logs/entries.js";
import type { AttemptPageState, AttemptsState } from "../../../../src/ui/attempt-routes.js";
import { localRequest } from "../../api.js";
import { agentKeys } from "../../live/keys.js";

export type { AttemptPageState, AttemptsState };

export function useAttempts() {
  return useQuery({
    queryKey: agentKeys.attempts.list,
    queryFn: ({ signal }) => localRequest<AttemptsState>("/api/attempts", { signal }),
  });
}

export function useAttempt(id: string) {
  return useQuery({
    queryKey: agentKeys.attempts.detail(id),
    queryFn: ({ signal }) =>
      localRequest<AttemptPageState>(`/api/attempts/${encodeURIComponent(id)}`, { signal }),
  });
}

/**
 * The log lines logged since the page opened (`logs` events append them to the cache, see
 * `live/invalidations.ts`); never fetched.
 */
export function useLiveLogTail(): readonly LogEntry[] {
  return useQuery<LogEntry[]>({ queryKey: agentKeys.logs.tail, queryFn: skipToken }).data ?? [];
}
