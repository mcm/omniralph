"use client";

import * as React from "react";
import { toast } from "sonner";
import type { ActionResult } from "@/lib/action-result";

/** Runs a server action in a transition and reports its result as a toast. */
export function useAction() {
  const [pending, startTransition] = React.useTransition();
  const run = React.useCallback(
    (action: () => Promise<ActionResult>, success: string, onSuccess?: () => void) => {
      startTransition(async () => {
        const result = await action();
        if (result.ok) {
          if (result.warning) toast.warning(result.warning);
          else toast.success(success);
          onSuccess?.();
        } else {
          toast.error(result.error);
        }
      });
    },
    [],
  );
  return { pending, run };
}
