"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { api } from "@/lib/api/client";
import { triageRunDetailResponseSchema, triageRunListSchema } from "@/lib/api/triage";
import type { TriageRunListParams } from "@/lib/triage/display";

/** A page of the organization's triage runs for the list's filter, live. */
export function useTriageRunList(params: TriageRunListParams) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: keys.triage.list({ ...params }),
    queryFn: ({ signal }) =>
      api.get("/api/ui/triage", triageRunListSchema, {
        params: {
          status: params.status ?? undefined,
          page: params.page > 1 ? params.page : undefined,
        },
        organizationId: organization.id,
        signal,
      }),
    // The previous results stay (dimmed) while the new filter or page loads.
    placeholderData: keepPreviousData,
  });
}

/** The page asking, so a run of another organization switches to it and comes back here. */
function currentPage(): string | undefined {
  return typeof window === "undefined"
    ? undefined
    : `${window.location.pathname}${window.location.search}`;
}

/** A triage run and everything its page shows, live (`GET /api/ui/triage/{id}`). */
export function useTriageRunDetail(runId: string) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: keys.triage.detail(runId),
    queryFn: ({ signal }) =>
      api.get(`/api/ui/triage/${runId}`, triageRunDetailResponseSchema, {
        params: { next: currentPage() },
        organizationId: organization.id,
        signal,
      }),
  });
}
