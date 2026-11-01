"use client";

import type { QueryKey } from "@tanstack/react-query";
import {
  useApiMutation,
  type Invalidation,
  type MutationCache,
} from "@/components/use-api-mutation";
import type { Backlog, BacklogCounts, BacklogUpNext } from "@/lib/api/backlog";
import { api } from "@/lib/api/client";
import { backlogKeys } from "@/lib/api/keys";
import { mutationResultSchema, type MutationResult } from "@/lib/api/schemas";
import {
  workItemRepositoryResultSchema,
  type WorkItemDetail,
  type WorkItemGroup,
  type WorkItemRow,
} from "@/lib/api/work-items";
import { isWorkItemDetail, workItemDetailPath } from "./use-work-item-detail";

/** The item an action acts on: a Backlog or Up next row, or the open detail. */
export type WorkItemActionTarget = Pick<WorkItemRow, "id" | "identifier"> & {
  /** Its Backlog group; null (the detail of an item in neither group) counts in none. */
  group: WorkItemGroup | null;
  organization: { id: string };
};

/** A repo the item can be sent to (Change repo…). */
export type WorkItemRepository = NonNullable<WorkItemRow["repository"]>;

/** "Om is triaging SOC-412": Triage now's tooltip while Om triages the item. */
export function triagingTooltip(identifier: string): string {
  return `Om is triaging ${identifier}`;
}

/** Calls an item action, naming the item's organization (`?organization=`). */
function postAction(
  target: WorkItemActionTarget,
  action: "start" | "triage" | "move" | "cancel",
  organizationId: string,
  body?: unknown,
) {
  return api.post(`${workItemDetailPath(target.id)}/${action}`, mutationResultSchema, {
    params: { organization: target.organization.id },
    organizationId,
    body,
  });
}

/** The counts key prefix: every scope's cached counts. */
const countsPrefix = (cache: MutationCache) =>
  [...backlogKeys(cache.keys).all, "counts"] as QueryKey;

/** Rewrites every cached Backlog row: `update` returns the new row, or null to drop it. */
async function updateBacklogRows(
  cache: MutationCache,
  update: (row: WorkItemRow) => WorkItemRow | null,
): Promise<void> {
  const rows = (list: readonly WorkItemRow[]) =>
    list.flatMap((row) => {
      const next = update(row);
      return next ? [next] : [];
    });
  const keys = backlogKeys(cache.keys);
  await cache.set<Backlog>(keys.lists, (previous) =>
    previous?.groups
      ? {
          ...previous,
          groups: {
            readyToStart: rows(previous.groups.readyToStart),
            needsRefining: rows(previous.groups.needsRefining),
          },
        }
      : previous,
  );
  await cache.set<BacklogUpNext>([...keys.all, "up-next"] as QueryKey, (previous) =>
    previous?.readyToStart
      ? {
          readyToStart: rows(previous.readyToStart),
          needsRefining: rows(previous.needsRefining),
        }
      : previous,
  );
}

/** Writes `update` into the item's cached detail (exactly: not its share links). */
function updateDetail(
  cache: MutationCache,
  workItemId: string,
  update: (detail: WorkItemDetail) => WorkItemDetail,
): Promise<void> {
  return cache.set<unknown>(
    backlogKeys(cache.keys).detail(workItemId),
    (previous) => (isWorkItemDetail(previous) ? update(previous) : previous),
    { exact: true },
  );
}

/**
 * Start epic (`POST /api/ui/work-items/{id}/start`): delegates the item to Om, which starts
 * its run as a delegation in the tracker does. Before the server answers, the item leaves the
 * Backlog list, Up next and the counts, and the detail stops offering Start; a failure (409
 * when a run exists, 400 unless Ready to start) puts everything back with the server's
 * message. Shared by Up next, the work item detail and the Inbox, which passes `also`: its
 * own mutation key, optimistic change (the item leaves its feed) and keys to invalidate.
 */
export function useStartWorkItem(also?: {
  mutationKey: QueryKey;
  optimistic: (cache: MutationCache) => Promise<void>;
  invalidate: (keys: MutationCache["keys"]) => Invalidation[];
}) {
  return useApiMutation<MutationResult, WorkItemActionTarget>({
    mutationKey: also?.mutationKey,
    mutationFn: (target, { organizationId }) => postAction(target, "start", organizationId),
    optimistic: async (target, cache) => {
      await also?.optimistic(cache);
      await updateBacklogRows(cache, (row) => (row.id === target.id ? null : row));
      // Only a Ready to start item starts (the server refuses any other).
      await cache.set<BacklogCounts>(countsPrefix(cache), (previous) =>
        previous && previous.readyToStart > 0
          ? { ...previous, readyToStart: previous.readyToStart - 1, total: previous.total - 1 }
          : previous,
      );
      await updateDetail(cache, target.id, (detail) => ({
        ...detail,
        actions: { ...detail.actions, start: false, triage: false, move: false, changeRepo: false },
      }));
    },
    invalidate: (keys, target) => [
      backlogKeys(keys).all,
      backlogKeys(keys).detail(target.id),
      ...(also?.invalidate(keys) ?? []),
    ],
    success: (_data, target) => `Om is starting ${target.identifier}`,
  });
}

/**
 * Triage now (`POST /api/ui/work-items/{id}/triage`): starts Om's triage of the item. Before
 * the server answers, its Triage now buttons (Backlog, Up next, the detail) disable with
 * "Om is triaging SOC-412"; a failure (409 while a triage runs) enables them again with the
 * server's message. When triage finishes, the item moves group by itself (a live change).
 */
export function useTriageWorkItem() {
  return useApiMutation<MutationResult, WorkItemActionTarget>({
    mutationFn: (target, { organizationId }) => postAction(target, "triage", organizationId),
    optimistic: async (target, cache) => {
      await updateBacklogRows(cache, (row) =>
        row.id === target.id ? { ...row, triageRunning: true } : row,
      );
      await updateDetail(cache, target.id, (detail) => ({
        ...detail,
        triageRunning: true,
        actions: { ...detail.actions, triage: false },
      }));
    },
    invalidate: (keys, target) => [backlogKeys(keys).all, backlogKeys(keys).detail(target.id)],
    success: (_data, target) => triagingTooltip(target.identifier),
  });
}

/** Removes the item from every cached group, and returns nothing to put back. */
function withoutItem(
  groups: { readyToStart: WorkItemRow[]; needsRefining: WorkItemRow[] },
  id: string,
) {
  return {
    readyToStart: groups.readyToStart.filter((row) => row.id !== id),
    needsRefining: groups.needsRefining.filter((row) => row.id !== id),
  };
}

/** Moves a Ready to start row to Needs refining (first, until the refetch orders it). */
function movedToRefine<
  Groups extends { readyToStart: WorkItemRow[]; needsRefining: WorkItemRow[] },
>(groups: Groups, id: string, limit?: number): Groups {
  const row = groups.readyToStart.find((entry) => entry.id === id);
  if (!row) return groups;
  const needsRefining = [{ ...row, group: "refine" as const }, ...groups.needsRefining];
  return {
    ...groups,
    readyToStart: groups.readyToStart.filter((entry) => entry.id !== id),
    needsRefining: limit === undefined ? needsRefining : needsRefining.slice(0, limit),
  };
}

/** Up next shows at most two Needs refining items. */
const UP_NEXT_REFINE_LIMIT = 2;

/**
 * Move to Needs refining (`POST /api/ui/work-items/{id}/move`): sets the item's tracker state
 * to the one mapped to Needs refining. Before the server answers, it moves from Ready to
 * start to Needs refining in every cached Backlog list, Up next and the counts, and the
 * detail stops offering Start and Move; a failure puts everything back.
 */
export function useMoveWorkItem() {
  return useApiMutation<MutationResult, WorkItemActionTarget>({
    mutationFn: (target, { organizationId }) =>
      postAction(target, "move", organizationId, { to: "needs_refining" }),
    optimistic: async (target, cache) => {
      const keys = backlogKeys(cache.keys);
      await cache.set<Backlog>(keys.lists, (previous) =>
        previous?.groups
          ? { ...previous, groups: movedToRefine(previous.groups, target.id) }
          : previous,
      );
      await cache.set<BacklogUpNext>([...keys.all, "up-next"] as QueryKey, (previous) =>
        previous?.readyToStart
          ? movedToRefine(previous, target.id, UP_NEXT_REFINE_LIMIT)
          : previous,
      );
      if (target.group === "ready") {
        await cache.set<BacklogCounts>(countsPrefix(cache), (previous) =>
          previous && previous.readyToStart > 0
            ? {
                ...previous,
                readyToStart: previous.readyToStart - 1,
                needsRefining: previous.needsRefining + 1,
              }
            : previous,
        );
      }
      await updateDetail(cache, target.id, (detail) => ({
        ...detail,
        group: "refine",
        actions: { ...detail.actions, start: false, move: false },
      }));
    },
    invalidate: (keys, target) => [backlogKeys(keys).all, backlogKeys(keys).detail(target.id)],
    success: (_data, target) => `Moved ${target.identifier} to Needs refining`,
  });
}

/**
 * Remove from backlog (`POST /api/ui/work-items/{id}/cancel`): cancels the item in its
 * tracker. Before the server answers, it leaves every cached Backlog list, Up next and the
 * counts, and the detail offers no more actions; a failure puts everything back.
 */
export function useCancelWorkItem() {
  return useApiMutation<MutationResult, WorkItemActionTarget>({
    mutationFn: (target, { organizationId }) => postAction(target, "cancel", organizationId),
    optimistic: async (target, cache) => {
      const keys = backlogKeys(cache.keys);
      await cache.set<Backlog>(keys.lists, (previous) =>
        previous?.groups
          ? { ...previous, groups: withoutItem(previous.groups, target.id) }
          : previous,
      );
      await cache.set<BacklogUpNext>([...keys.all, "up-next"] as QueryKey, (previous) =>
        previous?.readyToStart ? withoutItem(previous, target.id) : previous,
      );
      const group =
        target.group === "ready"
          ? "readyToStart"
          : target.group === "refine"
            ? "needsRefining"
            : null;
      if (group) {
        await cache.set<BacklogCounts>(countsPrefix(cache), (previous) =>
          previous && previous[group] > 0
            ? { ...previous, [group]: previous[group] - 1, total: previous.total - 1 }
            : previous,
        );
      }
      await updateDetail(cache, target.id, (detail) => ({
        ...detail,
        actions: {
          start: false,
          triage: false,
          editPrd: false,
          changeRepo: false,
          move: false,
          cancel: false,
        },
      }));
    },
    invalidate: (keys, target) => [backlogKeys(keys).all, backlogKeys(keys).detail(target.id)],
    success: (_data, target) => `Removed ${target.identifier} from the backlog`,
  });
}

/** "your choice in Omniralph (customer-portal)": a chosen route's `by`, as the router says it. */
function chosenBy(repository: WorkItemRepository): string {
  return `your choice in Omniralph (${repository.fullPath.split("/").at(-1)})`;
}

/** What Change repo… sends: a repo with Coding on, or null for the routing rules again. */
export interface ChangeRepositoryVariables {
  target: WorkItemActionTarget;
  repository: WorkItemRepository | null;
}

/**
 * Change repo… (`PUT /api/ui/work-items/{id}/repository`): the repo the item builds in when it
 * starts, or the routing rules again (null). A chosen repo shows at once on its Backlog rows
 * and in the detail's routes line ("Routes to … via your choice"); going back to the rules
 * shows once the server has routed it again. A failure puts everything back.
 */
export function useChangeWorkItemRepository() {
  return useApiMutation<{ repository: WorkItemRepository | null }, ChangeRepositoryVariables>({
    mutationFn: ({ target, repository }, { organizationId }) =>
      api.put(`${workItemDetailPath(target.id)}/repository`, workItemRepositoryResultSchema, {
        params: { organization: target.organization.id },
        organizationId,
        body: { repositoryId: repository?.id ?? null },
      }),
    optimistic: async ({ target, repository }, cache) => {
      if (!repository) return;
      await updateBacklogRows(cache, (row) =>
        row.id === target.id ? { ...row, repository } : row,
      );
      await updateDetail(cache, target.id, (detail) => ({
        ...detail,
        repository,
        route: {
          outcome: "repository",
          repository,
          via: { kind: "choice", label: "your choice" },
          by: chosenBy(repository),
        },
      }));
    },
    invalidate: (keys, { target }) => [backlogKeys(keys).all, backlogKeys(keys).detail(target.id)],
    success: (_data, { target, repository }) =>
      repository
        ? `${target.identifier} will build in ${repository.fullPath}`
        : `${target.identifier} follows the routing rules again`,
  });
}
