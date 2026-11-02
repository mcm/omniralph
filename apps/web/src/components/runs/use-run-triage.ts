"use client";

import { useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { api } from "@/lib/api/client";
import { runTriageSummarySchema, type RunTriageSummary } from "@/lib/api/runs";

/**
 * A triage run's summary (`GET /api/ui/runs/{id}/triage`). It sits under the run's detail
 * key, so the run's change events (a triage job finishing) refetch it. With `enabled`
 * false (not a triage run, or not yet known), nothing is fetched.
 */
export function useRunTriage(runId: string, { enabled = true }: { enabled?: boolean } = {}) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    enabled,
    queryKey: keys.runs.part(runId, "triage"),
    queryFn: ({ signal }): Promise<RunTriageSummary> =>
      api.get(`/api/ui/runs/${encodeURIComponent(runId)}/triage`, runTriageSummarySchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}
