"use client";

import { useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { api } from "@/lib/api/client";
import { runFindingsSchema, type RunFindings } from "@/lib/api/runs";

/**
 * A review run's findings, per pass (`GET /api/ui/runs/{id}/findings`). It sits under the
 * run's detail key, so the run's change events (a pass finishing, a finding dismissed or
 * superseded) refetch it; it polls only while live updates are down.
 */
export function useRunFindings(runId: string) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: keys.runs.part(runId, "findings"),
    queryFn: ({ signal }): Promise<RunFindings> =>
      api.get(`/api/ui/runs/${encodeURIComponent(runId)}/findings`, runFindingsSchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}
