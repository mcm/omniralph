"use client";

import { useQuery, type QueryKey } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { backlogSchema, type Backlog } from "@/lib/api/backlog";
import { api } from "@/lib/api/client";
import { backlogKeys, type QueryKeys } from "@/lib/api/keys";
import {
  sprintListSchema,
  sprintRowSchema,
  type SprintList,
  type SprintRow,
} from "@/lib/api/sprints";

/**
 * Query keys of the Sprints screen: the active organization's list under
 * `keys.sprints.lists` and a sprint at `keys.sprints.detail(id)`. A `sprint` change event
 * refetches both.
 */
export function sprintsKeys(keys: QueryKeys) {
  return {
    all: keys.sprints.all,
    lists: keys.sprints.lists,
    list: (): QueryKey => keys.sprints.list(),
    detail: (sprintId: string): QueryKey => keys.sprints.detail(sprintId),
  };
}

/** The active organization's sprints, newest first (`GET /api/ui/sprints`). A live query. */
export function useSprintList() {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery<SprintList>({
    queryKey: sprintsKeys(keys).list(),
    queryFn: ({ signal }) =>
      api.get("/api/ui/sprints", sprintListSchema, { organizationId: organization.id, signal }),
  });
}

/** One sprint with its epics in order (`GET /api/ui/sprints/{id}`). A live query. */
export function useSprint(sprintId: string) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery<SprintRow>({
    queryKey: sprintsKeys(keys).detail(sprintId),
    queryFn: ({ signal }) =>
      api.get(`/api/ui/sprints/${encodeURIComponent(sprintId)}`, sprintRowSchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}

/**
 * The backlog of one repo of the active organization (`GET /api/ui/backlog?repo=`): what the
 * sprint editor offers to add. Only while `enabled` (an admin editing a draft). A live query.
 */
export function useRepoBacklog(repositoryId: string, enabled: boolean) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery<Backlog>({
    queryKey: backlogKeys(keys).list({ repo: repositoryId }, organization.id),
    queryFn: ({ signal }) =>
      api.get("/api/ui/backlog", backlogSchema, {
        params: { organization: organization.id, repo: repositoryId },
        organizationId: organization.id,
        signal,
      }),
    enabled,
  });
}
