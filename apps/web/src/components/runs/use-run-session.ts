"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { api } from "@/lib/api/client";
import { runSessionSchema, type RunSession } from "@/lib/api/runs";

/**
 * An epic's or request's Session (`GET /api/ui/runs/{id}/session`), its messages a page at
 * a time (`fetchNextPage` loads older ones). It sits under the run's detail key, so the
 * run's change events refetch it; it polls only while live updates are down. `enabled`:
 * false for runs without one.
 */
export function useRunSession(runId: string, { enabled = true }: { enabled?: boolean } = {}) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useInfiniteQuery({
    queryKey: keys.runs.part(runId, "session"),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }): Promise<RunSession> =>
      api.get(`/api/ui/runs/${encodeURIComponent(runId)}/session`, runSessionSchema, {
        params: { cursor: pageParam },
        organizationId: organization.id,
        signal,
      }),
    getNextPageParam: (last) => last.nextCursor,
    enabled,
  });
}
