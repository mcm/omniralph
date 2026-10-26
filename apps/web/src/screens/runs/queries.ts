"use client";

import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { api } from "@/lib/api/client";
import { runsKeys } from "@/lib/api/keys";
import {
  runFilterOptionsSchema,
  runListSchema,
  type RunFilterOptions,
  type RunList,
} from "@/lib/api/runs";
import { useScopeParam } from "../scope";
import type { RunFilters } from "./filters";

/**
 * Runs of every kind in the user's scope, newest first, filtered (`GET /api/ui/runs`), a
 * page at a time ("Show more" fetches the next with `nextCursor`). A live query: a `run`
 * change event refetches every loaded page; it polls only while live updates are down.
 * The previous filters' runs stay shown while the new ones load.
 */
export function useRunList(filters: RunFilters) {
  const keys = useQueryKeys();
  const scope = useScopeParam();
  const { organization } = useCurrentUser();
  return useInfiniteQuery({
    queryKey: runsKeys(keys).list(filters, scope),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }): Promise<RunList> =>
      api.get("/api/ui/runs", runListSchema, {
        params: {
          kind: filters.kind,
          status: filters.status,
          repository: filters.repository,
          organization: scope,
          cursor: pageParam,
        },
        organizationId: organization.id,
        signal,
      }),
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
  });
}

/** The Repo filter's repositories in the user's scope (`GET /api/ui/runs/filter-options`). */
export function useRunFilterOptions() {
  const keys = useQueryKeys();
  const scope = useScopeParam();
  const { organization } = useCurrentUser();
  return useQuery<RunFilterOptions>({
    queryKey: runsKeys(keys).filterOptions(scope),
    queryFn: ({ signal }) =>
      api.get("/api/ui/runs/filter-options", runFilterOptionsSchema, {
        params: { organization: scope },
        organizationId: organization.id,
        signal,
      }),
  });
}
