"use client";

import * as React from "react";
import { toast } from "@omniralph/ui";
import type { ActionResult } from "@/lib/action-result";
import { useIsOrganizationStale } from "@/components/organization-guard";

/**
 * Runs one of the sign-in pages' server actions (onboarding, chat account linking: they run
 * before or outside the signed-in panel, which writes through `/api/ui` instead) in a
 * transition and reports its result as a toast. Refuses to run once another tab has
 * switched organizations: the action would act on the new one.
 */
export function useServerAction() {
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
          if (result.warning) toast(result.warning, { variant: "warning" });
          else toast(success);
          onSuccess?.();
        } else {
          toast(result.error, { variant: "danger" });
          onError?.(result);
        }
      });
    },
    [isOrganizationStale],
  );
  return { pending, run };
}
