"use client";

import * as React from "react";
import type { QueryKeys } from "@/lib/api/keys";
import { ApiError } from "@/lib/api/client";
import { useUnsavedChanges } from "./unsaved-changes";
import {
  MUTATION_FAILED,
  OrganizationStaleError,
  useApiMutation,
  type Invalidation,
  type MutationCache,
} from "./use-api-mutation";

// The panel's side of `@omniralph/ui`'s `useStagedCard`: `useStagedSave` is its `save` (one
// `/api/ui` request through `useApiMutation`, the answer written into the cache), and
// `useUnsavedCard` its `onDirtyChange` (registers the card with `UnsavedChangesProvider`).

/** How a card saves: one request with the whole draft, its answer written into the cache. */
export interface StagedSaveOptions<T, R> {
  /** Sends the whole card (`useApiMutation`'s `mutationFn`). */
  request: (draft: T, meta: { organizationId: string }) => Promise<R>;
  /**
   * Writes the saved card from the answer into every cached query that shows it, so the view
   * shows the saved state without a refetch (`useApiMutation`'s `applyResult`).
   */
  applyResult: (result: R, cache: MutationCache, draft: T) => Promise<void> | void;
  /**
   * Queries to refetch in the background once saved. Defaults to none: the save's change
   * event reconciles every view showing the card, and the view never waits for it.
   */
  invalidate?: (keys: QueryKeys) => Invalidation[];
  /** The success toast. Defaults to "Saved". */
  success?: string;
}

/**
 * A staged card's `save`: resolves once the answer is in the cache (with the success toast),
 * and rejects with the `ApiError` (after the danger toast), whose message, code and field
 * errors the card shows.
 */
export function useStagedSave<T, R>(options: StagedSaveOptions<T, R>): (draft: T) => Promise<R> {
  const mutation = useApiMutation<R, T>({
    mutationFn: (values, meta) => options.request(values, meta),
    applyResult: (result, cache, values) => options.applyResult(result, cache, values),
    invalidate: (keys) => options.invalidate?.(keys) ?? [],
    success: options.success ?? "Saved",
  });
  const { mutateAsync } = mutation;
  return React.useCallback(
    (draft: T) =>
      mutateAsync(draft).catch((error: unknown) => {
        if (error instanceof ApiError || error instanceof OrganizationStaleError) throw error;
        throw new ApiError(MUTATION_FAILED, 0, "client");
      }),
    [mutateAsync],
  );
}

/**
 * A staged card's `onDirtyChange`: while the card is dirty it is registered with
 * `UnsavedChangesProvider` under `label`, so leaving the page asks first.
 */
export function useUnsavedCard(label: string): (dirty: boolean) => void {
  const [dirty, setDirty] = React.useState(false);
  useUnsavedChanges(label, dirty);
  return setDirty;
}
