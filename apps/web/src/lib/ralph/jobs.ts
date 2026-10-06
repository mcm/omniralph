import "server-only";
import { getRun, lockRun, skipJob, updateRun, type Database, type Job } from "@omniralph/db";
import { getDispatcher } from "@/lib/dispatch";
import { getLinearGateway } from "@/lib/linear/client";
import { scmAdapterFor } from "@/lib/scm/adapters";
import { advanceRun, FINISHED_RUN_STATUSES, type RalphDeps } from "./run";

/**
 * Outcome hooks of `ralph.*` jobs (registered in `lib/jobs/handlers.ts`). A
 * job's outcome itself is applied by `advanceRun`, which finds it through the
 * story's `last_job_id`; the hooks only make sure the run is advanced and
 * record the run's sticky agent.
 */

/**
 * A delivery started: the agent becomes the run's sticky agent (its later
 * jobs go to `ralph-jobs-agent-<id>`). A job of a run that is over is skipped.
 */
export async function onRalphJobStarted(
  db: Database,
  job: Job,
  agentId: string,
): Promise<{ skip: false } | { skip: true; reason: "skipped" }> {
  if (!job.ralphRunId) return { skip: false };
  const finished = await lockRun(db, job.ralphRunId, async (tx, run) => {
    if (FINISHED_RUN_STATUSES.has(run.status)) return true;
    if (run.agentId !== agentId) await updateRun(tx, run.id, { agentId });
    return false;
  });
  if (finished ?? true) {
    await skipJob(db, job.id, { reason: "The ralph run is over" });
    return { skip: true, reason: "skipped" };
  }
  return { skip: false };
}

async function defaultDeps(db: Database): Promise<RalphDeps> {
  return {
    db,
    linear: await getLinearGateway({ db }),
    dispatcher: getDispatcher(),
    adapterFor: scmAdapterFor,
  };
}

/**
 * The job completed, failed for good or was canceled: apply its outcome and
 * move the run on. Errors (e.g. Linear being down) are logged, not thrown: the
 * job's own state is already recorded and the reconcile cron retries the run.
 */
export async function onRalphJobFinished(db: Database, job: Job, deps?: RalphDeps): Promise<void> {
  if (!job.ralphRunId) return;
  try {
    const run = await getRun(db, job.ralphRunId);
    if (!run || FINISHED_RUN_STATUSES.has(run.status)) return;
    await advanceRun(run.id, deps ?? (await defaultDeps(db)));
  } catch (error) {
    console.error(`Advancing ralph run ${job.ralphRunId} after job ${job.id} failed`, error);
  }
}
