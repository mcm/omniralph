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
      await cache.set<RepositoryDetail>(
        reposKeys(cache.keys).detail(repositoryId),
        (previous) =>
          previous
            ? {
                ...previous,
                status: { ...previous.status, problems: without(previous.status.problems) },
              }
            : previous,
        // Not the repo's sub-resources (its rules, a match check) cached under the detail.
        { exact: true },
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

/**
 * A card save's `applyResult`: writes the saved card into the repo's detail (`patchDetail`)
 * and, when the card has rail fields, the repo's row in every cached rail (`patchRow`), so
 * the view shows the saved state without a refetch.
 */
export async function applySavedCard(
  cache: MutationCache,
  repositoryId: string,
  patchDetail: (detail: RepositoryDetail) => RepositoryDetail,
  patchRow?: (row: RepositoryListItem) => RepositoryListItem,
) {
  await cache.set<RepositoryDetail>(
    reposKeys(cache.keys).detail(repositoryId),
    (previous) => (previous ? patchDetail(previous) : previous),
    // Not the repo's sub-resources (its rules, a match check) cached under the detail.
    { exact: true },
  );
  if (patchRow) {
    await updateListRows(cache, (rows) =>
      rows.map((row) => (row.id === repositoryId ? patchRow(row) : row)),
    );
  }
}

/** Rail order: organization name, then path (as `GET /api/ui/repositories` sorts). */
function railOrder(a: RepositoryListItem, b: RepositoryListItem): number {
  const key = (row: RepositoryListItem) => [
    row.organization.name,
    row.organization.id,
    row.fullPath,
  ];
  const [left, right] = [key(a), key(b)];
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]! < right[index]!) return -1;
    if (left[index]! > right[index]!) return 1;
  }
  return 0;
}

/**
 * Adds repos just connected (their rows from the add's response) to the rail of `scope`,
 * in rail order, so they show without a refetch; their change events then reconcile.
 */
export async function addListRows(
  cache: MutationCache,
  scope: string,
  added: readonly RepositoryListItem[],
) {
  const inScope = added.filter((row) => scope === "all" || row.organization.id === scope);
  if (inScope.length === 0) return;
  const ids = new Set(inScope.map((row) => row.id));
  await cache.set<RepositoryList>(
    reposKeys(cache.keys).list(scope),
    (previous) =>
      previous
        ? {
            ...previous,
            repositories: [
              ...previous.repositories.filter((row) => !ids.has(row.id)),
              ...inScope,
            ].sort(railOrder),
          }
        : previous,
    { exact: true },
  );
}

/** A repo's webhook was recreated: its webhook problem leaves its detail and rail row at once. */
export async function dropWebhookProblem(cache: MutationCache, repositoryId: string) {
  const without = (problems: RepositoryProblem[]) =>
    problems.filter((problem) => problem.code !== "webhook");
  await applySavedCard(
    cache,
    repositoryId,
    (detail) => ({
      ...detail,
      status: { ...detail.status, problems: without(detail.status.problems) },
    }),
    (row) => ({ ...row, status: { ...row.status, problems: without(row.status.problems) } }),
  );
}
