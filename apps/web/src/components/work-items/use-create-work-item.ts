"use client";

import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { useApiMutation, type MutationCache } from "@/components/use-api-mutation";
import type { Backlog, BacklogCounts, BacklogUpNext } from "@/lib/api/backlog";
import { api } from "@/lib/api/client";
import { backlogKeys } from "@/lib/api/keys";
import {
  createWorkItemResultSchema,
  workItemSourceValue,
  workItemTargetListSchema,
  type CreateWorkItemResponse,
  type WorkItemRow,
  type WorkItemTargetList,
} from "@/lib/api/work-items";
import { useScopeParam } from "@/screens/scope";

/** What New work item sends (`POST /api/ui/work-items`). */
export interface CreateWorkItemVariables {
  repositoryId: string;
  title: string;
  description: string;
  triageNow: boolean;
}

/** The create's answer, with the warning toast when triage couldn't start. */
export type CreateWorkItemData = CreateWorkItemResponse & { warning?: string };

/** "Added SOC-500 to the backlog. Om is triaging it.": the success toast. */
export function addedMessage(data: CreateWorkItemResponse): string {
  const added = `Added ${data.item.identifier} to the backlog.`;
  return data.triage === "started" ? `${added} Om is triaging it.` : added;
}

/** The warning toast when the item was created but its triage didn't start. */
export function triageFailedWarning(data: CreateWorkItemResponse): string {
  return `Added ${data.item.identifier} to the backlog, but Om couldn't triage it. ${
    data.triageError ?? "Use Triage now to try again."
  }`;
}

/**
 * New work item's repos in the user's scope (`GET /api/ui/work-items/targets`): repos with
 * Coding on and a work item match, each with the team and project the item is created in.
 * Under the Backlog's keys, so a `repository`, routing `settings` or `connection` change
 * refetches it.
 */
export function useWorkItemTargets() {
  const keys = useQueryKeys();
  const scope = useScopeParam();
  const { organization } = useCurrentUser();
  return useQuery<WorkItemTargetList>({
    queryKey: backlogKeys(keys).targets(scope),
    queryFn: ({ signal }) =>
      api.get("/api/ui/work-items/targets", workItemTargetListSchema, {
        params: { organization: scope },
        organizationId: organization.id,
        signal,
      }),
  });
}

/** The Backlog's filters, as its list query keys hold them. */
interface ListKeyFilters {
  source: string;
  repo: string;
  organization: string;
}

function listFiltersOf(queryKey: QueryKey): ListKeyFilters | null {
  const last = queryKey[queryKey.length - 1];
  if (typeof last !== "object" || last === null) return null;
  const { source, repo, organization } = last as Partial<ListKeyFilters>;
  if (typeof organization !== "string") return null;
  return { source: source ?? "", repo: repo ?? "", organization };
}

/** Whether a list of `filters` shows `row`: its scope covers the row's organization and its filters match. */
function listShows(filters: ListKeyFilters, row: WorkItemRow): boolean {
  return (
    (filters.organization === "all" || filters.organization === row.organization.id) &&
    (filters.source === "" || filters.source === workItemSourceValue(row)) &&
    (filters.repo === "" || filters.repo === row.repository?.id)
  );
}

/** `list` with `row` first in its group (the newest item), and its source and repo as filter options. */
function withRow(list: Backlog, row: WorkItemRow): Backlog {
  const group = row.group === "ready" ? "readyToStart" : "needsRefining";
  const source = workItemSourceValue(row);
  const { sources, repos } = list.filters;
  return {
    ...list,
    groups: {
      ...list.groups,
      [group]: [row, ...list.groups[group].filter((other) => other.id !== row.id)],
    },
    filters: {
      sources: sources.some((option) => option.value === source)
        ? sources
        : [...sources, { ...row.source, value: source, tracker: row.tracker }],
      repos:
        !row.repository || repos.some((option) => option.value === row.repository?.id)
          ? repos
          : [
              ...repos,
              {
                value: row.repository.id,
                provider: row.repository.provider,
                fullPath: row.repository.fullPath,
              },
            ],
    },
    setup: "ready",
  };
}

/** The scopes whose Up next and counts include `row`: All organizations and its own. */
const scopesOf = (row: WorkItemRow) => ["all", row.organization.id];

/**
 * New work item (`POST /api/ui/work-items`): creates the item through the create work item
 * service. On success the returned row goes straight into every cached Backlog list that
 * shows it (first in its group), Up next and the counts, without a refetch; lists that
 * aren't on screen are marked stale. A failure leaves the cache alone and toasts the
 * server's message; a triage that couldn't start is a warning toast (the item is added).
 */
export function useCreateWorkItem() {
  const client = useQueryClient();
  const keys = backlogKeys(useQueryKeys());
  return useApiMutation<CreateWorkItemData, CreateWorkItemVariables>({
    mutationFn: async (variables, { organizationId }) => {
      const data = await api.post("/api/ui/work-items", createWorkItemResultSchema, {
        organizationId,
        body: variables,
      });
      return data.triage === "failed" ? { ...data, warning: triageFailedWarning(data) } : data;
    },
    applyResult: async ({ item }, cache: MutationCache) => {
      const lists = client.getQueryCache().findAll({ queryKey: keys.lists });
      for (const query of lists) {
        const filters = listFiltersOf(query.queryKey);
        if (!filters || !listShows(filters, item)) continue;
        await cache.set<Backlog>(
          query.queryKey,
          (previous) => (previous?.groups ? withRow(previous, item) : previous),
          { exact: true },
        );
      }
      for (const scope of scopesOf(item)) {
        await cache.set<BacklogUpNext>(
          keys.upNext(scope),
          (previous) =>
            previous?.readyToStart
              ? item.group === "ready"
                ? { ...previous, readyToStart: [item, ...previous.readyToStart].slice(0, 3) }
                : { ...previous, needsRefining: [item, ...previous.needsRefining].slice(0, 2) }
              : previous,
          { exact: true },
        );
        await cache.set<BacklogCounts>(
          keys.counts(scope),
          (previous) =>
            previous
              ? {
                  readyToStart: previous.readyToStart + (item.group === "ready" ? 1 : 0),
                  needsRefining: previous.needsRefining + (item.group === "refine" ? 1 : 0),
                  total: previous.total + 1,
                }
              : previous,
          { exact: true },
        );
      }
    },
    // The view already shows the row: refetch nothing now. The server's `work_item` change
    // event reconciles every Backlog query; lists not on screen are marked stale (onSuccess).
    invalidate: () => [],
    success: addedMessage,
    onSuccess: () => {
      void client.invalidateQueries({
        queryKey: keys.lists,
        refetchType: "none",
        predicate: (query) => query.getObserversCount() === 0,
      });
    },
  });
}
