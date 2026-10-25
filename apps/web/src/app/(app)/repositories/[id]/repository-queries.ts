"use client";

import { useQuery, type QueryKey } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { api } from "@/lib/api/client";
import type { QueryKeys } from "@/lib/api/keys";
import {
  codingLinearSchema,
  repositoryCodingSchema,
  repositoryDetailSchema,
} from "@/lib/api/repositories";
import { repositoryRulesSchema } from "@/lib/api/rules";

/** The page asking, so a repository of another organization switches to it and comes back here. */
function currentPage(): string | undefined {
  return typeof window === "undefined"
    ? undefined
    : `${window.location.pathname}${window.location.search}`;
}

/** A repository with its Review settings and Harnesses tabs, live (`GET /api/ui/repositories/{id}`). */
export function useRepositoryDetail(repositoryId: string) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: keys.repositories.detail(repositoryId),
    queryFn: ({ signal }) =>
      api.get(`/api/ui/repositories/${repositoryId}`, repositoryDetailSchema, {
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
        params: { next: currentPage() },
        organizationId: organization.id,
        signal,
      }),
  });
}

/**
 * The Coding tab's settings and its database choices (admins), live through the repository's
 * settings changes (the tab's live parts, the task types, come with the repository).
 */
export function useRepositoryCoding(repositoryId: string, enabled: boolean) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: keys.repositories.part(repositoryId, "coding"),
    queryFn: ({ signal }) =>
      api.get(`/api/ui/repositories/${repositoryId}/coding`, repositoryCodingSchema, {
        params: { next: currentPage() },
        organizationId: organization.id,
        signal,
      }),
    enabled,
  });
}

/**
 * The Linear workspace the Coding tab picks from. It calls Linear, so it isn't polled nor
 * refetched on focus; it lives in the `connections` area so a repository save doesn't ask
 * Linear again. The tab offers a retry when Linear couldn't be read.
 */
export function useCodingLinear(repositoryId: string, enabled: boolean) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: keys.connections.part("linear", "settings-options"),
    queryFn: ({ signal }) =>
      api.get(`/api/ui/repositories/${repositoryId}/coding/linear`, codingLinearSchema, {
        organizationId: organization.id,
        signal,
      }),
    enabled,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    staleTime: 5 * 60_000,
  });
}

/**
 * What a repository settings save can affect: the repository's pages and the repositories
 * list, and the harness pages (which show the pins).
 */
export function repositoryChanged(keys: QueryKeys): QueryKey[] {
  return [keys.repositories.all, keys.harnesses.all];
}
