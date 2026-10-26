"use client";

import { useQuery, type QueryKey } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { api } from "@/lib/api/client";
import type { QueryKeys } from "@/lib/api/keys";
import {
  repositoryDetailSchema,
  repositoryListSchema,
  type RepositoryDetail,
  type RepositoryList,
} from "@/lib/api/repositories";
import { repositoryRulesSchema, type RepositoryRules } from "@/lib/api/rules";
import { useScopeParam } from "../scope";

/**
 * Query keys of the Repos screen: the rail per organization scope, under
 * `keys.repositories.lists`, and a repo's detail at `keys.repositories.detail(id)`. The
 * live data layer invalidates both (`repository`, `run`, `agent` and `connection` events).
 */
export function reposKeys(keys: QueryKeys) {
  return {
    lists: keys.repositories.lists,
    list: (scope: string): QueryKey => keys.repositories.list({ organization: scope }),
    detail: (repositoryId: string): QueryKey => keys.repositories.detail(repositoryId),
    /** Under the detail, so the repo's change events (a rule learned from a PR) refetch it. */
    rules: (repositoryId: string): QueryKey => keys.repositories.part(repositoryId, "rules"),
  };
}

/**
 * The Repos rail: every connected repo of the user's scope with its switches and status
 * (`GET /api/ui/repositories?organization=`). A live query: it refetches on the change
 * events that touch a repo's row and polls only while live updates are down.
 */
export function useRepositoryList() {
  const keys = useQueryKeys();
  const scope = useScopeParam();
  const { organization } = useCurrentUser();
  return useQuery<RepositoryList>({
    queryKey: reposKeys(keys).list(scope),
    queryFn: ({ signal }) =>
      api.get("/api/ui/repositories", repositoryListSchema, {
        params: { organization: scope },
        organizationId: organization.id,
        signal,
      }),
  });
}

/**
 * A repo's detail (`GET /api/ui/repositories/{id}`), of any of the user's organizations. A
 * live query: the repo's change events (and run, agent and connection events) refetch it.
 */
export function useRepositoryDetail(repositoryId: string) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery<RepositoryDetail>({
    queryKey: reposKeys(keys).detail(repositoryId),
    queryFn: ({ signal }) =>
      api.get(`/api/ui/repositories/${encodeURIComponent(repositoryId)}`, repositoryDetailSchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}

/**
 * A repo's review rules (`GET /api/ui/repositories/{id}/rules`), of any of the user's
 * organizations. A live query: the repo's change events refetch it.
 */
export function useRepositoryRules(repositoryId: string) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery<RepositoryRules>({
    queryKey: reposKeys(keys).rules(repositoryId),
    queryFn: ({ signal }) =>
      api.get(
        `/api/ui/repositories/${encodeURIComponent(repositoryId)}/rules`,
        repositoryRulesSchema,
        { organizationId: organization.id, signal },
      ),
  });
}
