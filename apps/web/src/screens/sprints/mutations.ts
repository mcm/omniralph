"use client";

import { useApiMutation, type MutationCache } from "@/components/use-api-mutation";
import { api, type ApiError } from "@/lib/api/client";
import { mutationResultSchema, type MutationResult } from "@/lib/api/schemas";
import {
  savedSprintSchema,
  type CreateSprintBody,
  type SavedSprint,
  type SprintEpicRow,
  type SprintList,
  type SprintRow,
} from "@/lib/api/sprints";
import { sprintsKeys } from "./queries";

/** Writes `sprint` into its detail and every cached list (`remove`: takes it out of the lists). */
async function writeSprint(cache: MutationCache, sprint: SprintRow, remove = false) {
  const keys = sprintsKeys(cache.keys);
  if (!remove) await cache.set<SprintRow>(keys.detail(sprint.id), () => sprint, { exact: true });
  await cache.set<SprintList>(keys.lists, (previous) => {
    if (!previous || !Array.isArray(previous.sprints)) return previous;
    const others = previous.sprints.filter((row) => row.id !== sprint.id);
    if (remove) return { ...previous, sprints: others };
    const known = previous.sprints.some((row) => row.id === sprint.id);
    return {
      ...previous,
      sprints: known
        ? previous.sprints.map((row) => (row.id === sprint.id ? sprint : row))
        : [sprint, ...others],
    };
  });
}

/** `POST /api/ui/sprints`: a new draft, added to the list from the answer. */
export function useCreateSprint() {
  return useApiMutation<SavedSprint, CreateSprintBody>({
    mutationFn: (body, { organizationId }) =>
      api.post("/api/ui/sprints", savedSprintSchema, { body, organizationId }),
    applyResult: (result, cache) => writeSprint(cache, result.sprint),
    invalidate: (keys) => [sprintsKeys(keys).lists],
    success: (result) => `Created ${result.sprint.name}`,
  });
}

/**
 * A change to a draft: its name, merge together, or its whole order of epics (`epics`, each
 * with the row to show until the server answers). The sprint shows the change at once; a
 * refusal puts back exactly what was there before (the hook's rollback), and the caller shows
 * the message where the change was made.
 */
export interface SprintChange {
  name?: string;
  mergeTogether?: boolean;
  epics?: readonly Pick<SprintEpicRow, "workItemId" | "identifier" | "title" | "state">[];
}

export interface UpdateSprintCallbacks {
  onSuccess?: (change: SprintChange) => void;
  /** After the rollback and the danger toast: shows the refusal inline. */
  onError?: (error: ApiError, change: SprintChange) => void;
}

/**
 * `PATCH /api/ui/sprints/{id}` with a `SprintChange`, optimistic; quiet on success. The
 * callbacks run for every change, not only the latest one.
 */
export function useUpdateSprint(sprint: SprintRow, callbacks: UpdateSprintCallbacks = {}) {
  return useApiMutation<SavedSprint, SprintChange>({
    mutationFn: (change, { organizationId }) =>
      api.patch(`/api/ui/sprints/${encodeURIComponent(sprint.id)}`, savedSprintSchema, {
        body: {
          name: change.name,
          mergeTogether: change.mergeTogether,
          epics: change.epics?.map((epic) => epic.workItemId),
        },
        organizationId,
      }),
    optimistic: async (change, cache) => {
      const current = cache.get<SprintRow>(sprintsKeys(cache.keys).detail(sprint.id)) ?? sprint;
      await writeSprint(cache, {
        ...current,
        name: change.name ?? current.name,
        mergeTogether: change.mergeTogether ?? current.mergeTogether,
        epics: change.epics
          ? change.epics.map((epic, position) => ({ ...epic, position }))
          : current.epics,
      });
    },
    applyResult: (result, cache) => writeSprint(cache, result.sprint),
    invalidate: (keys) => [sprintsKeys(keys).lists, sprintsKeys(keys).detail(sprint.id)],
    success: null,
    onSuccess: (_result, change) => callbacks.onSuccess?.(change),
    onError: (error, change) => callbacks.onError?.(error, change),
  });
}

/** `DELETE /api/ui/sprints/{id}` (drafts): the sprint leaves the list at once. */
export function useDeleteSprint(sprint: SprintRow, onDeleted: () => void) {
  return useApiMutation<MutationResult, void>({
    mutationFn: (_variables, { organizationId }) =>
      api.delete(`/api/ui/sprints/${encodeURIComponent(sprint.id)}`, mutationResultSchema, {
        organizationId,
      }),
    optimistic: (_variables, cache) => writeSprint(cache, sprint, true),
    invalidate: (keys) => [sprintsKeys(keys).lists],
    success: `Deleted ${sprint.name}`,
    onSuccess: onDeleted,
  });
}
