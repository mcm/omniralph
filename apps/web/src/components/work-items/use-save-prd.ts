"use client";

import type { QueryKey } from "@tanstack/react-query";
import { useApiMutation, type MutationCache } from "@/components/use-api-mutation";
import { backlogKeys } from "@/lib/api/keys";
import { api } from "@/lib/api/client";
import { workItemPrdResultSchema, type WorkItemDetail } from "@/lib/api/work-items";
import { isWorkItemDetail, workItemDetailPath } from "./use-work-item-detail";

/** What Save sends: the new PRD and the `updatedAt` the edit started from. */
export interface SavePrdVariables {
  markdown: string;
  baseUpdatedAt: string;
}

/** Writes `update` into the item's cached detail (exactly: not its share links). */
function updateDetail(
  cache: MutationCache,
  key: QueryKey,
  update: (detail: WorkItemDetail) => WorkItemDetail,
): Promise<void> {
  return cache.set<unknown>(
    key,
    (previous) => (isWorkItemDetail(previous) ? update(previous) : previous),
    { exact: true },
  );
}

/**
 * Edit PRD's Save (`PUT /api/ui/work-items/{id}/prd` with `{ markdown, baseUpdatedAt }`):
 * the cached detail shows the new description at once, then takes the tracker's new
 * `updatedAt` from the response. A failure (a 409 when the item changed in the tracker or
 * Om is working on it) puts the previous description back with the server's message.
 */
export function useSavePrd(workItemId: string) {
  return useApiMutation<{ updatedAt: string }, SavePrdVariables>({
    mutationFn: (body, { organizationId }) =>
      api.put(`${workItemDetailPath(workItemId)}/prd`, workItemPrdResultSchema, {
        body,
        organizationId,
      }),
    optimistic: async ({ markdown }, cache) => {
      await updateDetail(cache, backlogKeys(cache.keys).detail(workItemId), (detail) => ({
        ...detail,
        description: markdown,
      }));
    },
    applyResult: async ({ updatedAt }, cache, { markdown }) => {
      await updateDetail(cache, backlogKeys(cache.keys).detail(workItemId), (detail) => ({
        ...detail,
        description: markdown,
        updatedAt,
      }));
    },
    invalidate: (keys) => [backlogKeys(keys).detail(workItemId)],
    success: "PRD saved",
  });
}
