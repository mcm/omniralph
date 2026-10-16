"use client";

import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import * as React from "react";
import type { ActionResult } from "@/lib/action-result";
import { ApiError } from "@/lib/api/client";
import type { QueryKeys } from "@/lib/api/keys";
import { useCurrentUser } from "./current-user";
import { useQueryKeys } from "./query-provider";
import { MUTATION_FAILED } from "./use-api-mutation";

function warningOf(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || !("warning" in data)) return undefined;
  return typeof data.warning === "string" ? data.warning : undefined;
}

/**
 * An `/api/ui` request as an `ActionResult`, for forms whose save runs through `useAction`
 * (`SettingsSection`, `SettingsCard`: they show the toast, the pending state and the
 * "Saved" status). It sends the request, then invalidates `invalidate`'s keys once, after
 * success or failure, and awaits their refetch before answering, so the form re-seeds
 * from saved data, never mid-save. `onData` gets the response first.
 */
export function useApiAction() {
  const client = useQueryClient();
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return React.useCallback(
    async <T>(
      request: (meta: { organizationId: string }) => Promise<T>,
      invalidate: (keys: QueryKeys) => QueryKey[],
      onData?: (data: T) => void,
    ): Promise<ActionResult> => {
      let result: ActionResult;
      try {
        const data = await request({ organizationId: organization.id });
        onData?.(data);
        const warning = warningOf(data);
        result = warning ? { ok: true, warning } : { ok: true };
      } catch (error) {
        result =
          error instanceof ApiError
            ? {
                ok: false,
                error: error.message,
                ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
              }
            : { ok: false, error: MUTATION_FAILED };
      }
      await Promise.all(invalidate(keys).map((queryKey) => client.invalidateQueries({ queryKey })));
      return result;
    },
    [client, keys, organization.id],
  );
}
