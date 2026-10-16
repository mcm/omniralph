"use client";

import { notify } from "@iamthemcmaster/ui";
import {
  useMutation,
  useQueryClient,
  type QueryKey,
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

export interface ApiMutationOptions<TData, TVariables, TContext> {
  /**
   * Names the mutation, so a view can show it before the server answers (optimistic, with
   * `useMutationState`): the overlay goes away by itself when the mutation fails.
   */
  mutationKey?: QueryKey;
  /** Calls the `/api/ui` handler, sending `organizationId` with the request (`apiRequest`). */
  mutationFn: (variables: TVariables, meta: { organizationId: string }) => Promise<TData>;
  /**
   * Every list and detail the mutation can affect, by key prefix (from `keys`). They are
   * invalidated, and their refetch awaited, before `onSuccess` runs, so a navigation from
   * there never lands on stale data; after a failure too, so a rolled-back optimistic
   * update settles on the server's state.
   */
  invalidate: (keys: QueryKeys, variables: TVariables, data: TData | undefined) => Invalidation[];
  /** The success toast; `null` for none. A result's `warning` replaces it, as a warning toast. */
  success: string | ((data: TData, variables: TVariables) => string) | null;
  /** Optimistic update: runs first; its return value is `onError`'s `context` (to roll back). */
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
 * server's message on failure, and invalidation of every affected query. It refuses to run once another tab has switched organizations (the request would
 * act on the new one): `OrganizationGuard` blocks the tab instead, with no toast.
 */
export function useApiMutation<TData = unknown, TVariables = void, TContext = unknown>(
  options: ApiMutationOptions<TData, TVariables, TContext>,
): UseMutationResult<TData, Error, TVariables, TContext | undefined> {
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

  return useMutation<TData, Error, TVariables, TContext | undefined>({
    mutationKey: options.mutationKey,
    onMutate: async (variables) => {
      if (isOrganizationStale()) throw new OrganizationStaleError();
      return latest.current.onMutate?.(variables);
    },
    mutationFn: (variables) =>
      latest.current.mutationFn(variables, { organizationId: organization.id }),
    onSuccess: async (data, variables) => {
      const { success } = latest.current;
      const warning = warningOf(data);
      if (warning) notify(warning, { variant: "warning" });
      else if (success !== null) {
        notify(typeof success === "function" ? success(data, variables) : success);
      }
      await invalidate(variables, data);
      latest.current.onSuccess?.(data, variables);
    },
    onError: async (error, variables, context) => {
      if (error instanceof OrganizationStaleError) return;
      const apiError =
        error instanceof ApiError ? error : new ApiError(MUTATION_FAILED, 0, "client");
      notify(apiError.message, { variant: "danger" });
      latest.current.onError?.(apiError, variables, context);
      await invalidate(variables, undefined);
    },
  });
}
