import "server-only";
import { getJob, type Database } from "@omniralph/db";
import type { ActionResult } from "@/lib/action-result";
import { getDispatcher } from "@/lib/dispatch";
import { organizationPlaybooks } from "@/lib/definitions";
import { jobHooks } from "@/lib/sinks";

/** The warning a running job's cancel answers with: it stops with its harness's next heartbeat. */
export const CANCEL_REQUESTED_WARNING =
  "Cancel requested: the agent stops the job with its next heartbeat.";

/**
 * Cancels a job of `organizationId` (the logic behind `POST /api/ui/jobs/{id}/cancel`): a
 * queued job is canceled at once (its message is skipped at start), a running one is marked
 * cancel-requested and stopped by its agent after the next heartbeat, which confirms it.
 */
export async function cancelJob(
  db: Database,
  organizationId: string,
  jobId: string,
): Promise<ActionResult> {
  const existing = await getJob(db, jobId);
  if (existing?.organizationId !== organizationId) {
    return { ok: false, error: "That job doesn't exist." };
  }
  const result = await getDispatcher().cancel(jobId);
  if (result === "not_found") return { ok: false, error: "That job doesn't exist." };
  if (result === "not_cancelable") return { ok: false, error: "That job has already finished." };
  if (result === "canceled") {
    const job = await getJob(db, jobId);
    const hooks = job && (await jobHooks(job, organizationPlaybooks(db, job.organizationId)));
    if (job) await hooks?.onCanceled?.(db, job);
  }
  if (result === "cancel_requested") return { ok: true, warning: CANCEL_REQUESTED_WARNING };
  return { ok: true };
}
