"use client";

import type { QueryKey } from "@tanstack/react-query";
import { useApiMutation, type MutationCache } from "@/components/use-api-mutation";
import type { Backlog, BacklogCounts, BacklogUpNext } from "@/lib/api/backlog";
import { api } from "@/lib/api/client";
import { backlogKeys } from "@/lib/api/keys";
import { mutationResultSchema, type MutationResult } from "@/lib/api/schemas";
import type { WorkItemDetail, WorkItemRow } from "@/lib/api/work-items";
import { isWorkItemDetail, workItemDetailPath } from "./use-work-item-detail";

/** The item an action acts on: a Backlog or Up next row, or the open detail. */
export type WorkItemActionTarget = Pick<WorkItemRow, "id" | "identifier" | "group"> & {
  organization: { id: string };
};

/** "Om is triaging SOC-412": Triage now's tooltip while Om triages the item. */
export function triagingTooltip(identifier: string): string {
  return `Om is triaging ${identifier}`;
}

/** Calls an item action, naming the item's organization (`?organization=`). */
function postAction(
  target: WorkItemActionTarget,
  action: "start" | "triage",
  organizationId: string,
) {
  return api.post(`${workItemDetailPath(target.id)}/${action}`, mutationResultSchema, {
    params: { organization: target.organization.id },
    organizationId,
  });
}

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
 * its run as a delegation in Linear does. Before the server answers, the item leaves the
 * Backlog list, Up next and the counts, and the detail stops offering Start; a failure (409
 * when a run exists, 400 unless Ready to start) puts everything back with the server's
 * message. Shared by Up next and the work item detail.
 */
export function useStartWorkItem() {
  return useApiMutation<MutationResult, WorkItemActionTarget>({
    mutationFn: (target, { organizationId }) => postAction(target, "start", organizationId),
    optimistic: async (target, cache) => {
      await updateBacklogRows(cache, (row) => (row.id === target.id ? null : row));
      // Only a Ready to start item starts (the server refuses any other).
      await cache.set<BacklogCounts>(
        [...backlogKeys(cache.keys).all, "counts"] as QueryKey,
        (previous) =>
          previous && previous.readyToStart > 0
            ? { ...previous, readyToStart: previous.readyToStart - 1, total: previous.total - 1 }
            : previous,
      );
      await updateDetail(cache, target.id, (detail) => ({
        ...detail,
        actions: { ...detail.actions, start: false, triage: false, move: false, changeRepo: false },
      }));
    },
    invalidate: (keys, target) => [backlogKeys(keys).all, backlogKeys(keys).detail(target.id)],
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
