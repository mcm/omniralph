import "server-only";
import { getHarness, getJob, type Database } from "@omniralph/db";
import type { ActionResult } from "@/lib/action-result";
import type { JobDispatcher } from "@/lib/dispatch";
import { reviewIdOfJob } from "@/lib/review/job-review";
import { rerunOrganizationReview } from "@/lib/reviews/manage";
import { jobRerunKind, RERUNNABLE_JOB_STATUSES } from "./rerun-kind";

export const JOB_NOT_FOUND = "That job doesn't exist.";

/** The warning a rerun answers with when the same work is already queued or running. */
export const ALREADY_ACTIVE_WARNING = "The same job is already queued or running.";

/**
 * Reruns a failed, canceled or expired job of `organizationId` (the logic behind
 * `POST /api/ui/jobs/{id}/rerun`; members: the caller checks), as `jobRerunKind` says: a review task's job re-runs its review
 * on the PR's current head (incremental, the repository's default profile), a system RPC is
 * dispatched again to the harness it targeted. The failed job stays as it is; the rerun is a
 * new job. A job that is still queued or running or completed, or of a kind that can't be
 * rerun, gets an error.
 */
export async function rerunJob(
  db: Database,
  dispatcher: JobDispatcher,
  organizationId: string,
  jobId: string,
): Promise<ActionResult & { jobId?: string }> {
  const job = await getJob(db, jobId);
  if (job?.organizationId !== organizationId) return { ok: false, error: JOB_NOT_FOUND };
  if (!RERUNNABLE_JOB_STATUSES.includes(job.status)) {
    return { ok: false, error: "Only failed, canceled or expired jobs can be rerun." };
  }
  const kind = jobRerunKind(job);
  if (kind === null) {
    return {
      ok: false,
      error: "This job can't be rerun from here: retry it from its run.",
    };
  }

  if (kind === "review") {
    const result = await rerunOrganizationReview(
      db,
      dispatcher,
      organizationId,
      reviewIdOfJob(job.payload)!,
      { mode: "incremental", profileId: null },
    );
    if (result.ok) return { ok: true };
    if (result.activeReviewId) return { ok: true, warning: result.error };
    return { ok: false, error: result.error };
  }

  // A system RPC runs on the harness it targeted, which must still be there.
  const target = job.targetHarnessId ? await getHarness(db, job.targetHarnessId) : null;
  if (!target || target.revokedAt || target.organizationId !== organizationId) {
    return { ok: false, error: "The agent this job ran on is gone, so it can't be rerun." };
  }
  const { job: rerun, created } = await dispatcher.createAndPublish({
    organizationId,
    type: job.type,
    taskType: job.taskType,
    pool: job.pool,
    taskId: job.taskId,
    minHarnessVersion: job.minHarnessVersion,
    requiredInstallables: job.requiredInstallables,
    requiredHostTools: job.requiredHostTools,
    payload: job.payload,
    repositoryId: job.repositoryId,
    dedupeKey: job.dedupeKey,
    targetHarnessId: target.id,
  });
  return created
    ? { ok: true, jobId: rerun.id }
    : { ok: true, jobId: rerun.id, warning: ALREADY_ACTIVE_WARNING };
}
