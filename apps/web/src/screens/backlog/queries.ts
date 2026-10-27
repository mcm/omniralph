"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import {
  backlogCountsSchema,
  backlogSchema,
  type Backlog,
  type BacklogCounts,
} from "@/lib/api/backlog";
import { api } from "@/lib/api/client";
import { backlogKeys } from "@/lib/api/keys";
import { useScopeParam } from "../scope";
import type { BacklogFilters } from "./url";

/**
 * The Backlog of the user's scope, filtered (`GET /api/ui/backlog`). A live query: a
 * `work_item`, `repository`, routing `settings` or `connection` change event refetches it;
 * it polls only while live updates are down. The previous filters' list stays shown while
 * the new one loads.
 */
export function useBacklog(filters: BacklogFilters) {
  const keys = useQueryKeys();
  const scope = useScopeParam();
  const { organization } = useCurrentUser();
  return useQuery<Backlog>({
    queryKey: backlogKeys(keys).list(filters, scope),
    queryFn: ({ signal }) =>
      api.get("/api/ui/backlog", backlogSchema, {
        params: {
          organization: scope,
          source: filters.source ?? undefined,
          repo: filters.repo ?? undefined,
        },
        organizationId: organization.id,
        signal,
      }),
    placeholderData: keepPreviousData,
  });
}

/** The Backlog's group sizes in the user's scope (`GET /api/ui/backlog/counts`): the nav count. */
export function useBacklogCounts() {
  const keys = useQueryKeys();
  const scope = useScopeParam();
  const { organization } = useCurrentUser();
  return useQuery<BacklogCounts>({
    queryKey: backlogKeys(keys).counts(scope),
    queryFn: ({ signal }) =>
      api.get("/api/ui/backlog/counts", backlogCountsSchema, {
        params: { organization: scope },
        organizationId: organization.id,
        signal,
      }),
  });
}
