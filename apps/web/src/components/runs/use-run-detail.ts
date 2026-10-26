"use client";

import { useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { api } from "@/lib/api/client";
import { runDetailSchema, type RunDetail } from "@/lib/api/runs";

/**
 * A run's detail (`GET /api/ui/runs/{id}`), of any of the user's organizations. A live
 * query: the run's change events refetch it, and it polls only while live updates are down.
 */
export function useRunDetail(runId: string) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery<RunDetail>({
    queryKey: keys.runs.detail(runId),
    queryFn: ({ signal }) =>
      api.get(`/api/ui/runs/${encodeURIComponent(runId)}`, runDetailSchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}
