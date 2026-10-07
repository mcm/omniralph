"use server";

import { getJob } from "@omniralph/db";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import { runAdminAction } from "@/lib/auth/admin-action";
import { getDb } from "@/lib/db";
import { getDispatcher } from "@/lib/dispatch";
import { jobOutcomeHandler } from "@/lib/jobs/handlers";

/**
 * Cancels a job: a queued job is canceled at once (its message is skipped at
 * start), a running one is stopped by its agent after the next heartbeat.
 */
export async function cancelJob(jobId: string): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const db = getDb();
    const existing = await getJob(db, jobId);
    if (existing?.organizationId !== admin.organization.id) {
      return { ok: false, error: "That job doesn't exist." };
    }
    const result = await getDispatcher().cancel(jobId);
    if (result === "not_found") return { ok: false, error: "That job doesn't exist." };
    if (result === "not_cancelable") return { ok: false, error: "That job has already finished." };
    if (result === "canceled") {
      const job = await getJob(db, jobId);
      if (job) await jobOutcomeHandler(job)?.onCanceled?.(db, job);
    }
    revalidatePath("/jobs");
    revalidatePath("/agents");
    if (result === "cancel_requested") {
      return {
        ok: true,
        warning: "Cancel requested: the agent stops the job with its next heartbeat.",
      };
    }
  });
}
