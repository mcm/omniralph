"use client";

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
import * as React from "react";
import { ApiError } from "@/lib/api/client";
import type { QueryKeys } from "@/lib/api/keys";
import { useCurrentUser } from "./current-user";
import { useIsOrganizationStale } from "./organization-guard";
import { useQueryKeys } from "./query-provider";

/** Shown when a mutation fails without a message from the server. */
export const MUTATION_FAILED = "Something went wrong. Try again.";

/** Thrown (and not reported) when another tab has switched organizations: see `OrganizationGuard`. */
export class OrganizationStaleError extends Error {
  constructor() {
    super("This tab's organization is no longer the active one.");
    this.name = "OrganizationStaleError";
  }
}

/**
 * A query key prefix to invalidate. Active queries under it refetch; with `refetchType:
 * "all"`, inactive (cached) ones too: for the page a mutation navigates to, so it renders
 * fresh data on arrival instead of its cached copy.
 */
export type Invalidation = QueryKey | { queryKey: QueryKey; refetchType: "all" };

function isQueryKey(target: Invalidation): target is QueryKey {
  return Array.isArray(target);
}

/**
 * The cache, for a mutation's `optimistic` and `applyResult`: changes made through `set`
 * show at once, and an `optimistic` change is rolled back to the exact previous state if
 * the mutation fails.
 */
export interface MutationCache {
  /** The active organization's query keys. */
  keys: QueryKeys;
  /** A query's cached data (exact key). */
  get<T>(queryKey: QueryKey): T | undefined;
  /**
   * Writes every cached query under the `queryKey` prefix (or creates the exact query
   * when none is cached): cancels their in-flight fetches first, so a fetch that started
   * before the change can't overwrite it, and snapshots them for a rollback. With `exact`,
   * only the query at `queryKey` itself (not the sub-resources under it).
   */
  set<T>(
    queryKey: QueryKey,
    updater: (previous: T | undefined) => T | undefined,
    options?: { exact?: boolean },
  ): Promise<void>;
}

/** A cached query before a mutation changed it (`state` undefined: it wasn't cached). */
interface CacheSnapshot {
  queryKey: QueryKey;
  hash: string;
  state: QueryState | undefined;
}

/** The mutation's context: the caller's `onMutate` result and the optimistic snapshots. */
export interface ApiMutationContext<TContext> {
  context: TContext | undefined;
  snapshots: CacheSnapshot[];
}

function mutationCache(
  client: QueryClient,
  keys: QueryKeys,
  snapshots: CacheSnapshot[] | null,
): MutationCache {
  const snapshot = (queryKey: QueryKey, query: Query | undefined) => {
    const hash = query?.queryHash ?? hashKey(queryKey);
    if (!snapshots || snapshots.some((entry) => entry.hash === hash)) return;
    snapshots.push({ queryKey, hash, state: query ? { ...query.state } : undefined });
  };
  return {
    keys,
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

export interface ApiMutationOptions<TData, TVariables, TContext> {
  /**
   * Names the mutation, so a view can show it before the server answers (optimistic, with
   * `useMutationState`): the overlay goes away by itself when the mutation fails.
   */
  mutationKey?: QueryKey;
  /** Calls the `/api/ui` handler, sending `organizationId` with the request (`apiRequest`). */
  mutationFn: (variables: TVariables, meta: { organizationId: string }) => Promise<TData>;
  /**
   * Every list and detail the mutation can affect, by key prefix (from `keys`). Without
   * `optimistic` or `applyResult` they are invalidated, and their refetch awaited, before
   * `onSuccess` runs, so a navigation from there never lands on stale data; after a failure
   * too. With either, the view already shows the change: they are invalidated in the
   * background once the mutation settles (reconcile), and nothing waits on the refetch.
   */
  invalidate: (keys: QueryKeys, variables: TVariables, data: TData | undefined) => Invalidation[];
  /** The success toast; `null` for none. A result's `warning` replaces it, as a warning toast. */
  success: string | ((data: TData, variables: TVariables) => string) | null;
  /**
   * The optimistic update: before the request, writes what the mutation will do into the
   * cache (`cache.set`), so the view shows it at once. On failure every query it wrote is
   * restored to its exact previous state, with the danger toast.
   */
  optimistic?: (variables: TVariables, cache: MutationCache) => Promise<void> | void;
  /**
   * Writes the server's response into the cache (`cache.set`) before `onSuccess`, for
   * changes the view can't predict (a created ID, a computed field).
   */
  applyResult?: (data: TData, cache: MutationCache, variables: TVariables) => Promise<void> | void;
  /** Runs first (after `optimistic`); its return value is `onError`'s `context`. */
  onMutate?: (variables: TVariables) => Promise<TContext> | TContext;
  onSuccess?: (data: TData, variables: TVariables) => void;
  /** After the danger toast, e.g. to show `error.fieldErrors` inline or roll back. */
  onError?: (error: ApiError, variables: TVariables, context: TContext | undefined) => void;
}

function warningOf(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || !("warning" in data)) return undefined;
  return typeof data.warning === "string" ? data.warning : undefined;
}

/**
 * A TanStack mutation with the panel's toasts, for every change made through `/api/ui`: a
 * success toast (or the result's `warning`, as a warning toast), a danger toast with the
 * server's message on failure, and invalidation of every affected query. New mutations
 * declare `optimistic` or `applyResult` so the view never waits on a refetch (README
 * "Data fetching"). It refuses to run once another tab has switched organizations (the
 * request would act on the new one): `OrganizationGuard` blocks the tab instead, with no
 * toast.
 */
export function useApiMutation<TData = unknown, TVariables = void, TContext = unknown>(
  options: ApiMutationOptions<TData, TVariables, TContext>,
): UseMutationResult<TData, Error, TVariables, ApiMutationContext<TContext> | undefined> {
  const client = useQueryClient();
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  const isOrganizationStale = useIsOrganizationStale();
  // The latest options, so callers can pass inline callbacks.
  const latest = React.useRef(options);
  React.useEffect(() => {
    latest.current = options;
  });

  const invalidate = React.useCallback(
    (variables: TVariables, data: TData | undefined) =>
      Promise.all(
        latest.current
          .invalidate(keys, variables, data)
          .map((target) =>
            client.invalidateQueries(isQueryKey(target) ? { queryKey: target } : target),
          ),
      ),
    [client, keys],
  );

  // With an optimistic or applied result the view is already right: reconcile in the background.
  const settle = (variables: TVariables, data: TData | undefined) => {
    const { optimistic, applyResult } = latest.current;
    if (!optimistic && !applyResult) return invalidate(variables, data);
    void invalidate(variables, data);
  };

  return useMutation<TData, Error, TVariables, ApiMutationContext<TContext>>({
    mutationKey: options.mutationKey,
    onMutate: async (variables) => {
      if (isOrganizationStale()) throw new OrganizationStaleError();
      const snapshots: CacheSnapshot[] = [];
      try {
        await latest.current.optimistic?.(variables, mutationCache(client, keys, snapshots));
        return { context: await latest.current.onMutate?.(variables), snapshots };
      } catch (error) {
        // `onError` gets no context when `onMutate` throws, so roll back here.
        restore(client, snapshots);
        throw error;
      }
    },
    mutationFn: (variables) =>
      latest.current.mutationFn(variables, { organizationId: organization.id }),
    onSuccess: async (data, variables) => {
      const { success, applyResult } = latest.current;
      if (applyResult) await applyResult(data, mutationCache(client, keys, null), variables);
      const warning = warningOf(data);
      if (warning) toast(warning, { variant: "warning" });
      else if (success !== null) {
        toast(typeof success === "function" ? success(data, variables) : success);
      }
      await settle(variables, data);
      latest.current.onSuccess?.(data, variables);
    },
    onError: async (error, variables, context) => {
      if (error instanceof OrganizationStaleError) return;
      if (context) restore(client, context.snapshots);
      const apiError =
        error instanceof ApiError ? error : new ApiError(MUTATION_FAILED, 0, "client");
      toast(apiError.message, { variant: "danger" });
      latest.current.onError?.(apiError, variables, context?.context);
      await settle(variables, undefined);
    },
  });
}
