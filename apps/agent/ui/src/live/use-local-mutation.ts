/**
 * Every change the page makes through the local API: the same contract as the control
 * panel's `useApiMutation` (apps/web), without its organization and fetch layer.
 *
 * - `optimistic` writes what the change will do into the cache before the request, so it
 *   shows at once; on failure every query it wrote goes back to its exact previous state,
 *   with a danger toast.
 * - `applyResult` writes the agent's answer into the cache before `onSuccess`.
 * - `invalidate` names what the change can affect. With `optimistic` or `applyResult` the
 *   page already shows the change, so they are refetched in the background (reconcile);
 *   without, the refetch is awaited before `onSuccess`.
 */
import { toast } from "@omniralph/ui";
import {
  hashKey,
  useMutation,
  useQueryClient,
  type Query,
  type QueryClient,
  type QueryKey,
  type QueryState,
  type UseMutationResult,
} from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { LocalApiError, REQUEST_FAILED } from "../api.js";
import { agentKeys, type AgentKeys } from "./keys.js";

/** The cache, for `optimistic` and `applyResult`. */
export interface LocalMutationCache {
  keys: AgentKeys;
  get<T>(queryKey: QueryKey): T | undefined;
  /**
   * Writes every cached query under the `queryKey` prefix (or creates the exact query when
   * none is cached), after cancelling their in-flight fetches so an older answer can't
   * overwrite the change. With `exact`, only the query at `queryKey`.
   */
  set<T>(
    queryKey: QueryKey,
    updater: (previous: T | undefined) => T | undefined,
    options?: { exact?: boolean },
  ): Promise<void>;
}

/** A cached query before the mutation changed it (`state` undefined: it wasn't cached). */
interface CacheSnapshot {
  queryKey: QueryKey;
  hash: string;
  state: QueryState | undefined;
}

export interface LocalMutationContext {
  snapshots: CacheSnapshot[];
}

function mutationCache(client: QueryClient, snapshots: CacheSnapshot[] | null): LocalMutationCache {
  const snapshot = (queryKey: QueryKey, query: Query | undefined) => {
    const hash = query?.queryHash ?? hashKey(queryKey);
    if (!snapshots || snapshots.some((entry) => entry.hash === hash)) return;
    snapshots.push({ queryKey, hash, state: query ? { ...query.state } : undefined });
  };
  return {
    keys: agentKeys,
    get: <T>(queryKey: QueryKey) => client.getQueryData<T>(queryKey),
    set: async <T>(
      queryKey: QueryKey,
      updater: (previous: T | undefined) => T | undefined,
      { exact = false }: { exact?: boolean } = {},
    ) => {
      await client.cancelQueries({ queryKey, exact });
      const queries = client.getQueryCache().findAll({ queryKey, exact });
      if (queries.length === 0) {
        const next = updater(undefined);
        if (next === undefined) return;
        snapshot(queryKey, undefined);
        client.setQueryData(queryKey, next);
        return;
      }
      for (const query of queries) {
        snapshot(query.queryKey, query);
        client.setQueryData(query.queryKey, (previous: T | undefined) => updater(previous));
      }
    },
  };
}

/** Puts every snapshotted query back exactly as it was (or drops one that wasn't cached). */
function restore(client: QueryClient, snapshots: readonly CacheSnapshot[]): void {
  for (const { queryKey, state } of [...snapshots].reverse()) {
    const query = client.getQueryCache().find({ queryKey, exact: true });
    if (!state) client.removeQueries({ queryKey, exact: true });
    else query?.setState(state);
  }
}

export interface LocalMutationOptions<TData, TVariables> {
  /** Calls the local API (`localRequest`). */
  mutationFn: (variables: TVariables) => Promise<TData>;
  /** The queries the change can affect, by key prefix. */
  invalidate: (variables: TVariables, data: TData | undefined) => QueryKey[];
  /** The success toast; `null` for none. */
  success: string | ((data: TData, variables: TVariables) => string) | null;
  optimistic?: (variables: TVariables, cache: LocalMutationCache) => Promise<void> | void;
  applyResult?: (
    data: TData,
    cache: LocalMutationCache,
    variables: TVariables,
  ) => Promise<void> | void;
  onSuccess?: (data: TData, variables: TVariables) => void;
  /** After the danger toast, e.g. to show `error.fieldErrors` inline. */
  onError?: (error: LocalApiError, variables: TVariables) => void;
}

export function useLocalMutation<TData = unknown, TVariables = void>(
  options: LocalMutationOptions<TData, TVariables>,
): UseMutationResult<TData, Error, TVariables, LocalMutationContext | undefined> {
  const client = useQueryClient();
  // The latest options, so callers can pass inline callbacks.
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  const invalidate = useCallback(
    (variables: TVariables, data: TData | undefined) =>
      Promise.all(
        latest.current
          .invalidate(variables, data)
          .map((queryKey) => client.invalidateQueries({ queryKey })),
      ),
    [client],
  );

  // With an optimistic or applied result the page is already right: reconcile in the background.
  const settle = async (variables: TVariables, data: TData | undefined) => {
    const { optimistic, applyResult } = latest.current;
    if (!optimistic && !applyResult) {
      await invalidate(variables, data);
      return;
    }
    void invalidate(variables, data);
  };

  return useMutation<TData, Error, TVariables, LocalMutationContext>({
    onMutate: async (variables) => {
      const snapshots: CacheSnapshot[] = [];
      try {
        await latest.current.optimistic?.(variables, mutationCache(client, snapshots));
        return { snapshots };
      } catch (error) {
        // `onError` gets no context when `onMutate` throws, so roll back here.
        restore(client, snapshots);
        throw error;
      }
    },
    mutationFn: (variables) => latest.current.mutationFn(variables),
    onSuccess: async (data, variables) => {
      const { success, applyResult } = latest.current;
      if (applyResult) await applyResult(data, mutationCache(client, null), variables);
      if (success !== null) {
        toast(typeof success === "function" ? success(data, variables) : success);
      }
      await settle(variables, data);
      latest.current.onSuccess?.(data, variables);
    },
    onError: async (error, variables, context) => {
      if (context) restore(client, context.snapshots);
      const localError =
        error instanceof LocalApiError ? error : new LocalApiError(REQUEST_FAILED, 0);
      // A 401 replaces the whole page ("Open this page again"): no toast on top.
      if (localError.status !== 401) toast(localError.message, { variant: "danger" });
      latest.current.onError?.(localError, variables);
      await settle(variables, undefined);
    },
  });
}
