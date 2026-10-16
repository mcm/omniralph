"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { api } from "@/lib/api/client";
import { runDetailSchema, runListSchema } from "@/lib/api/runs";
import type { RalphRunListParams } from "@/lib/ralph/display";

/** A page of the organization's coding runs for the list's filters, live. */
export function useRunList(params: RalphRunListParams) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: keys.runs.list({ ...params }),
    queryFn: ({ signal }) =>
      api.get("/api/ui/runs", runListSchema, {
        params: {
          status: params.status ?? undefined,
          repository: params.repositoryId ?? undefined,
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

/** A run and everything its page shows, live (`GET /api/ui/runs/{id}`). */
export function useRunDetail(runId: string) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: keys.runs.detail(runId),
    queryFn: ({ signal }) =>
      api.get(`/api/ui/runs/${runId}`, runDetailSchema, {
        params: { next: currentPage() },
        organizationId: organization.id,
        signal,
      }),
  });
}
