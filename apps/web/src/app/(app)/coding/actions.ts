"use server";

import { getRun } from "@omniralph/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionResult } from "@/lib/action-result";
import { runAdminAction } from "@/lib/auth/admin-action";
import { getDb } from "@/lib/db";
import { getDispatcher } from "@/lib/dispatch";
import { getLinearGatewayOrDisconnected } from "@/lib/linear/client";
import { stopRun } from "@/lib/ralph/reply";
import { scmAdapterFor } from "@/lib/scm/adapters";
import { userDisplayName } from "@/lib/user-display";

/**
 * Stops a ralph run of the active organization (admins only) the way the Linear stop reply does: the run
 * becomes `stopped`, its queued or running job is canceled and the agent
 * session is told who stopped it. Linear writes are best-effort, so this works
 * while the organization has no workspace connected. Guidance in Linear resumes the run.
 */
export async function stopRalphRun(runId: string): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    if (!z.uuid().safeParse(runId).success) return { ok: false, error: "That run doesn't exist." };
    const db = getDb();
    const run = await getRun(db, runId);
    if (!run || run.organizationId !== admin.organization.id) {
      return { ok: false, error: "That run doesn't exist." };
    }
    const result = await stopRun(
      {
        db,
        organizationId: run.organizationId,
        linear: await getLinearGatewayOrDisconnected({ db, organizationId: run.organizationId }),
        dispatcher: getDispatcher(),
        adapterFor: scmAdapterFor,
      },
      run,
      userDisplayName(admin),
    );
    revalidatePath("/coding");
    revalidatePath(`/coding/${runId}`);
    revalidatePath("/jobs");
    switch (result.status) {
      case "gone":
        return { ok: false, error: "That run doesn't exist." };
      case "already":
        return {
          ok: false,
          error:
            result.runStatus === "stopped"
              ? "This run is already stopped."
              : `This run is already over (${result.runStatus}).`,
        };
      case "stopped":
        return { ok: true };
    }
  });
}
