"use client";

import { toast } from "@omniralph/ui";
import type { z } from "zod";
import { useApiMutation, type MutationCache } from "@/components/use-api-mutation";
import { api } from "@/lib/api/client";
import type {
  RepositoryDetail,
  RepositoryList,
  RepositoryListItem,
  RepositoryProblemItem as RepositoryProblem,
} from "@/lib/api/repositories";
import { mutationResultSchema } from "@/lib/api/schemas";
import { reposKeys } from "./queries";

/** Rewrites the repo's row in every cached rail (whatever the scope) with `update`. */
async function updateListRows(
  cache: MutationCache,
  update: (rows: RepositoryListItem[]) => RepositoryListItem[],
) {
  await cache.set<RepositoryList>(reposKeys(cache.keys).lists, (previous) =>
    previous && Array.isArray(previous.repositories)
      ? { ...previous, repositories: update(previous.repositories) }
      : previous,
  );
}

export interface RemovedRepository {
  id: string;
  name: string;
}

/**
 * `DELETE /api/ui/repositories/{id}` (admins of its organization). The row leaves every
 * cached rail at once (back if the removal fails); success toasts "Removed <name>", with
 * the API's warning when it has one, and calls `onRemoved`.
 */
export function useRemoveRepository(onRemoved?: () => void) {
  return useApiMutation<z.infer<typeof mutationResultSchema>, RemovedRepository>({
    mutationFn: (repository) =>
      api.delete(`/api/ui/repositories/${encodeURIComponent(repository.id)}`, mutationResultSchema),
    optimistic: (repository, cache) =>
      updateListRows(cache, (rows) => rows.filter((row) => row.id !== repository.id)),
    invalidate: (keys) => [reposKeys(keys).lists],
    success: null,
    onSuccess: (result, repository) => {
      if (result.warning) {
        toast(`Removed ${repository.name}. ${result.warning}`, { variant: "warning" });
      } else {
        toast(`Removed ${repository.name}`);
      }
      onRemoved?.();
    },
  });
}

/** What a problem's `post` action toasts when it succeeds. */
const PROBLEM_ACTION_DONE: Partial<Record<RepositoryProblem["code"], string>> = {
  webhook: "Webhook recreated",
  sync_failed: "Update retried",
};

const actionResultSchema = mutationResultSchema.passthrough();

/**
 * Runs a repo problem's `post` action ("Recreate webhook", "Retry"). On success the problem
 * leaves the repo's detail and rail row at once; the live events then confirm it.
 */
export function useProblemAction(repositoryId: string) {
  return useApiMutation<z.infer<typeof actionResultSchema>, RepositoryProblem>({
    mutationFn: (problem) => {
      if (problem.action?.type !== "post") throw new Error("This problem has no action to run.");
      return api.post(problem.action.path, actionResultSchema);
    },
    applyResult: async (_result, cache, problem) => {
      const without = (problems: RepositoryProblem[]) =>
        problems.filter((entry) => entry.code !== problem.code);
      await cache.set<RepositoryDetail>(reposKeys(cache.keys).detail(repositoryId), (previous) =>
        previous
          ? {
              ...previous,
              status: { ...previous.status, problems: without(previous.status.problems) },
            }
          : previous,
      );
      await updateListRows(cache, (rows) =>
        rows.map((row) =>
          row.id === repositoryId
            ? { ...row, status: { ...row.status, problems: without(row.status.problems) } }
            : row,
        ),
      );
    },
    invalidate: (keys) => [reposKeys(keys).lists, reposKeys(keys).detail(repositoryId)],
    success: (_result, problem) => PROBLEM_ACTION_DONE[problem.code] ?? "Done",
  });
}
