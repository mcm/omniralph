"use client";

import * as React from "react";
import { notify } from "@iamthemcmaster/ui";
import type { ActionResult } from "@/lib/action-result";
import { useIsOrganizationStale } from "./organization-guard";

/**
 * Runs a server action in a transition and reports its result as a toast. Refuses to run
 * once another tab has switched organizations: the action would act on the new one.
 */
export function useAction() {
  const [pending, startTransition] = React.useTransition();
  const isOrganizationStale = useIsOrganizationStale();
  const run = React.useCallback(
    (
      action: () => Promise<ActionResult>,
      success: string,
      onSuccess?: () => void,
      onError?: (result: Extract<ActionResult, { ok: false }>) => void,
    ) => {
      if (isOrganizationStale()) return;
      startTransition(async () => {
        const result = await action();
        if (result.ok) {
          if (result.warning) notify(result.warning, { variant: "warning" });
          else notify(success);
          onSuccess?.();
        } else {
          notify(result.error, { variant: "danger" });
          onError?.(result);
        }
      });
    },
    [isOrganizationStale],
  );
  return { pending, run };
}
