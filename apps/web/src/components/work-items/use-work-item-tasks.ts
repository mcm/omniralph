"use client";

import type { QueryKey } from "@tanstack/react-query";
import { useApiMutation, type MutationCache } from "@/components/use-api-mutation";
import { api } from "@/lib/api/client";
import { backlogKeys } from "@/lib/api/keys";
import { mutationResultSchema } from "@/lib/api/schemas";
import {
  workItemTaskResultSchema,
  type WorkItemDetail,
  type WorkItemTaskResult,
} from "@/lib/api/work-items";
import { setTaskChecked } from "@/lib/work-items/task-list";
import { isWorkItemDetail, workItemDetailPath } from "./use-work-item-detail";

/** The item a task list belongs to: its URL ID and organization. */
export interface TaskListTarget {
  id: string;
  organization: { id: string };
}

/** What a checkbox sends: the task as the list read it, and its new state. */
export interface ToggleTaskVariables {
  index: number;
  text: string;
  checked: boolean;
}

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
 * Checks or unchecks a task (`PUT /api/ui/work-items/{id}/tasks`): the cached detail's
 * description shows it at once, then takes the description Linear saved (others' edits
 * included) and its `updatedAt`. A failure puts the previous description back, with the
 * server's message in a toast.
 */
export function useToggleTask(target: TaskListTarget) {
  return useApiMutation<WorkItemTaskResult, ToggleTaskVariables>({
    mutationKey: ["work-item-task", target.id],
    mutationFn: (body, { organizationId }) =>
      api.put(`${workItemDetailPath(target.id)}/tasks`, workItemTaskResultSchema, {
        params: { organization: target.organization.id },
        organizationId,
        body,
      }),
    optimistic: async ({ index, checked }, cache) => {
      await updateDetail(cache, backlogKeys(cache.keys).detail(target.id), (detail) => ({
        ...detail,
        description: setTaskChecked(detail.description, index, checked),
      }));
    },
    applyResult: async ({ description, updatedAt }, cache) => {
      await updateDetail(cache, backlogKeys(cache.keys).detail(target.id), (detail) => ({
        ...detail,
        description,
        updatedAt,
      }));
    },
    invalidate: (keys) => [backlogKeys(keys).detail(target.id)],
    success: null,
  });
}

/** Mark done (`POST /api/ui/work-items/{id}/done`): the detail shows it Done at once. */
export function useMarkWorkItemDone(target: TaskListTarget) {
  return useApiMutation<unknown, void>({
    mutationFn: (_body, { organizationId }) =>
      api.post(`${workItemDetailPath(target.id)}/done`, mutationResultSchema, {
        params: { organization: target.organization.id },
        organizationId,
      }),
    optimistic: async (_body, cache) => {
      await updateDetail(cache, backlogKeys(cache.keys).detail(target.id), (detail) => ({
        ...detail,
        state: { category: "done", name: "Done" },
      }));
    },
    invalidate: (keys) => [backlogKeys(keys).all],
    success: "Marked done",
  });
}
