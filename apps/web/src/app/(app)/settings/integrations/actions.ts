"use server";

import { deleteIntegration } from "@omniralph/db";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import { runAdminAction } from "@/lib/auth/admin-action";
import { getDb } from "@/lib/db";
import { revokeToken, type LinearCredentials } from "@/lib/linear/oauth";

/**
 * Disconnects the Linear workspace: forgets its tokens and revokes them at
 * Linear (best effort). Linear webhooks are ignored from then on.
 */
export async function disconnectLinear(): Promise<ActionResult> {
  return runAdminAction(async () => {
    const removed = await deleteIntegration<LinearCredentials>(getDb(), "linear");
    if (!removed) return { ok: false, error: "No Linear workspace is connected." };
    revalidatePath("/settings/integrations");
    try {
      await revokeToken(removed.credentials.accessToken);
    } catch (error) {
      console.error("Revoking the Linear token failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return {
        ok: true,
        warning: `Disconnected ${removed.name}, but Linear didn't confirm revoking the token. Remove the app in Linear's settings if it's still listed.`,
      };
    }
  });
}
