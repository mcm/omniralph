"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { api } from "@/lib/api/client";
import { jobListSchema } from "@/lib/api/jobs";
import type { JobListParams } from "@/lib/jobs/list";

/** A page of the organization's jobs for the list's filter (or the `?job=` job's page), live. */
export function useJobList(params: JobListParams) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: keys.jobs.list({ ...params }),
    queryFn: ({ signal }) =>
      api.get("/api/ui/jobs", jobListSchema, {
        params: {
          status: params.status ?? undefined,
          page: params.page > 1 ? params.page : undefined,
          job: params.jobId ?? undefined,
        },
        organizationId: organization.id,
        signal,
      }),
    // The previous results stay (dimmed) while the new filter or page loads.
    placeholderData: keepPreviousData,
  });
}
