"use client";

import { useQueries, useQuery, type QueryKey } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { api } from "@/lib/api/client";
import type { QueryKeys } from "@/lib/api/keys";
import {
  repositoryDetailSchema,
  repositoryListSchema,
  repositorySetupSchema,
  scmConnectionListSchema,
  selectableRepositoriesSchema,
  type RepositoryDetail,
  type RepositoryList,
  type RepositorySetup,
  type ScmConnectionList,
  type SelectableRepositories,
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

/**
 * Query keys of the add-repo sheet, in the `connections` area (scope-wide, so another
 * organization's connection events reach them): an organization's connections, what its
 * Connect buttons need, and what a connection's picker lists.
 */
export function addRepoKeys(keys: QueryKeys) {
  return {
    connections: (organizationId: string): QueryKey =>
      keys.connections.list({ organization: organizationId }),
    setup: (organizationId: string): QueryKey => keys.connections.part(organizationId, "setup"),
    listing: (connectionId: string, organizationId: string): QueryKey =>
      keys.connections.part(connectionId, "selectable", { organization: organizationId }),
  };
}

/** `GET /api/ui/scm-connections?organization=`: the organization's connections and their health. */
function fetchConnections(organizationId: string, signal?: AbortSignal) {
  // No organization header: the sheet may list another organization's connections.
  return api.get("/api/ui/scm-connections", scmConnectionListSchema, {
    params: { organization: organizationId },
    signal,
  });
}

/**
 * An organization's GitHub and GitLab connections with their health (admins). A live
 * query: connection events (health checks, new connections) and repository events refetch it.
 */
export function useScmConnections(organizationId: string, enabled = true) {
  const keys = useQueryKeys();
  return useQuery<ScmConnectionList>({
    queryKey: addRepoKeys(keys).connections(organizationId),
    queryFn: ({ signal }) => fetchConnections(organizationId, signal),
    enabled,
  });
}

/** Each organization's connections (`useScmConnections`), to find which one has a connection. */
export function useScmConnectionsOf(organizationIds: readonly string[], enabled: boolean) {
  const keys = useQueryKeys();
  return useQueries({
    queries: organizationIds.map((organizationId) => ({
      queryKey: addRepoKeys(keys).connections(organizationId),
      queryFn: ({ signal }: { signal?: AbortSignal }) => fetchConnections(organizationId, signal),
      enabled,
    })),
  });
}

/**
 * What the Connect buttons need for the organization (`GET /api/ui/repositories/setup`). It
 * may ask GitHub for the app's slug: loaded once per organization, never polled.
 */
export function useRepositorySetup(organizationId: string) {
  const keys = useQueryKeys();
  return useQuery<RepositorySetup>({
    queryKey: addRepoKeys(keys).setup(organizationId),
    queryFn: ({ signal }) =>
      api.get("/api/ui/repositories/setup", repositorySetupSchema, {
        params: { organization: organizationId },
        signal,
      }),
    staleTime: Infinity,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });
}

/**
 * What a connection's picker lists, from the code host
 * (`GET /api/ui/scm-connections/{id}/repositories`). An external call: it loads once per
 * opening and on Refresh (and when a change event says which repos are connected), never
 * on an interval or focus, and isn't retried (Retry is).
 */
export function useSelectableRepositories(
  connection: { id: string; provider: "github" | "gitlab" },
  organizationId: string,
) {
  const keys = useQueryKeys();
  return useQuery<SelectableRepositories>({
    queryKey: addRepoKeys(keys).listing(connection.id, organizationId),
    queryFn: ({ signal }) =>
      api.get(
        `/api/ui/scm-connections/${encodeURIComponent(connection.id)}/repositories`,
        selectableRepositoriesSchema,
        { params: { provider: connection.provider, organization: organizationId }, signal },
      ),
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
}
