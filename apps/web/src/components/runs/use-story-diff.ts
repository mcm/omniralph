"use client";

import { useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { api } from "@/lib/api/client";
import { runsKeys } from "@/lib/api/keys";
import { storyDiffSchema, type StoryDiff } from "@/lib/api/runs";

/**
 * An epic story's diff (`GET /api/ui/runs/{id}/steps/{stepId}/diff`), cached per commit: a
 * commit's diff never changes, so it is never stale, no change event reaches its key
 * (`runsKeys(keys).diff`, in the `diffs` area) and, as it reads the code host, it doesn't
 * poll or refetch on focus. A new commit is a new key.
 */
export function useStoryDiff(runId: string, stepId: string, commit: string) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: runsKeys(keys).diff(runId, stepId, commit),
    queryFn: ({ signal }): Promise<StoryDiff> =>
      api.get(
        `/api/ui/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/diff`,
        storyDiffSchema,
        { organizationId: organization.id, signal },
      ),
    staleTime: Infinity,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
