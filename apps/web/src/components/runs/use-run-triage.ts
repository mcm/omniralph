"use client";

import { useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { api } from "@/lib/api/client";
import { runTriageSummarySchema, type RunTriageSummary } from "@/lib/api/runs";

/**
 * A triage run's summary (`GET /api/ui/runs/{id}/triage`). It sits under the run's detail
 * key, so the run's change events (a triage job finishing) refetch it.
 */
export function useRunTriage(runId: string) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: keys.runs.part(runId, "triage"),
    queryFn: ({ signal }): Promise<RunTriageSummary> =>
      api.get(`/api/ui/runs/${encodeURIComponent(runId)}/triage`, runTriageSummarySchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}
