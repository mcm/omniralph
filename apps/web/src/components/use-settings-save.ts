"use client";

import { notify } from "@iamthemcmaster/ui";
import { useMutation } from "@tanstack/react-query";
import * as React from "react";
import type { ActionResult } from "@/lib/action-result";
import { useIsOrganizationStale } from "./organization-guard";
import { MUTATION_FAILED } from "./use-api-mutation";

type Failure = Extract<ActionResult, { ok: false }>;

interface Save {
  action: () => Promise<ActionResult>;
  success: string;
  onSuccess?: () => void;
  onError?: (result: Failure) => void;
}

/**
 * Runs a settings form's save (`SettingsSection`, `SettingsCard`) as a TanStack mutation and
 * reports its result as a toast: the success message (or the result's `warning`, as a
 * warning toast), or the error as a danger toast. The save is an `/api/ui` request as an
 * `ActionResult` (`useApiAction`), which invalidates and refetches what it changed before
 * it resolves. Refuses to run once another tab has switched organizations: the request
 * would act on the new one.
 */
export function useSettingsSave() {
  const isOrganizationStale = useIsOrganizationStale();
  const { mutate, isPending } = useMutation<ActionResult, Error, Save>({
    mutationFn: (save) => save.action(),
    onSuccess: (result, save) => {
      if (result.ok) {
        if (result.warning) notify(result.warning, { variant: "warning" });
        else notify(save.success);
        save.onSuccess?.();
      } else {
        notify(result.error, { variant: "danger" });
        save.onError?.(result);
      }
    },
    onError: (_error, save) => {
      const result: Failure = { ok: false, error: MUTATION_FAILED };
      notify(result.error, { variant: "danger" });
      save.onError?.(result);
    },
  });
  const run = React.useCallback(
    (
      action: () => Promise<ActionResult>,
      success: string,
      onSuccess?: () => void,
      onError?: (result: Failure) => void,
    ) => {
      if (isOrganizationStale()) return;
      mutate({ action, success, onSuccess, onError });
    },
    [isOrganizationStale, mutate],
  );
  return { pending: isPending, run };
}
