"use client";

import { useQuery, type QueryKey } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { api } from "@/lib/api/client";
import type { QueryKeys } from "@/lib/api/keys";
import { legacyRepositoryDetailSchema } from "@/lib/api/repositories";
import { repositoryRulesSchema } from "@/lib/api/rules";

/** The page asking, so a repository of another organization switches to it and comes back here. */
function currentPage(): string | undefined {
  return typeof window === "undefined"
    ? undefined
    : `${window.location.pathname}${window.location.search}`;
}

/**
 * A repository with its Review settings and Agents tabs, live
 * (`GET /api/ui/repositories/{id}/overview`).
 */
export function useRepositoryDetail(repositoryId: string) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: keys.repositories.part(repositoryId, "overview"),
    queryFn: ({ signal }) =>
      api.get(`/api/ui/repositories/${repositoryId}/overview`, legacyRepositoryDetailSchema, {
        params: { next: currentPage() },
        organizationId: organization.id,
        signal,
      }),
  });
}

/** Repository › Rules: the repository with its custom and learned rules, live. */
export function useRepositoryRules(repositoryId: string) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: keys.repositories.part(repositoryId, "rules"),
    queryFn: ({ signal }) =>
      api.get(`/api/ui/repositories/${repositoryId}/rules`, repositoryRulesSchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}

/**
 * What a repository settings save can affect: the repository's pages and the repositories
 * list, and the agent pages (which show the pins).
 */
export function repositoryChanged(keys: QueryKeys): QueryKey[] {
  return [keys.repositories.all, keys.agents.all];
}
