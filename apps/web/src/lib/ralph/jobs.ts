import "server-only";
import {
  findLaneByPullRequest,
  getReview,
  getRun,
  listLanes,
  lockRun,
  skipJob,
  updateRun,
  type Database,
  type Job,
} from "@omniralph/db";
import { getDispatcher } from "@/lib/dispatch";
import { getLinearGatewayOrDisconnected } from "@/lib/linear/client";
import { scmAdapterFor } from "@/lib/scm/adapters";
import { onCleanupJobFinished, startPendingCleanups } from "./cleanup";
import { respondToReview } from "./pull-request-requests";
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

/**
 * The orchestrator's dependencies for an organization's runs: its connected
 * Linear workspace (a disconnected gateway without one, so its chat runs
 * still move), the dispatcher and the SCM adapters.
 */
export async function defaultDeps(db: Database, organizationId: string): Promise<RalphDeps> {
  return {
    db,
    organizationId,
    linear: await getLinearGatewayOrDisconnected({ db, organizationId }),
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
    if (!run) return;
    const finished = FINISHED_RUN_STATUSES.has(run.status);
    // A merged lane's cleanup that waited for the run's jobs starts now.
    const pending = (await listLanes(db, run.id)).some((l) => l.cleanup?.status === "pending");
    if (finished && !pending) return;
    const ralph = deps ?? (await defaultDeps(db, run.organizationId));
    if (!finished) await advanceRun(run.id, ralph);
    if (pending) await startPendingCleanups(ralph, run.id);
  } catch (error) {
    console.error(`Advancing ralph run ${job.ralphRunId} after job ${job.id} failed`, error);
  }
}

/**
 * A `ralph.cleanup` job completed, failed for good or was canceled: its
 * outcome is applied (`onCleanupJobFinished`). Errors are logged.
 */
export async function onRalphCleanupJobFinished(
  db: Database,
  job: Job,
  deps?: RalphDeps,
): Promise<void> {
  if (!job.ralphRunId) return;
  try {
    let ralph = deps;
    if (!ralph) {
      const run = await getRun(db, job.ralphRunId);
      if (!run) return;
      ralph = await defaultDeps(db, run.organizationId);
    }
    await onCleanupJobFinished(ralph, job);
  } catch (error) {
    console.error(`Applying the outcome of cleanup job ${job.id} failed`, error);
  }
}

/**
 * A `review.run` job completed: when it reviewed a ralph PR/MR, its open
 * findings may become a request on that lane (`respondToReview`). Errors are
 * logged, not thrown: the review itself is saved and posted already.
 */
export async function onReviewForRalph(
  db: Database,
  reviewId: string,
  deps?: RalphDeps,
): Promise<void> {
  try {
    const review = await getReview(db, reviewId);
    const found = review && (await findLaneByPullRequest(db, review.repositoryId, review.prNumber));
    if (!found) return;
    await respondToReview(deps ?? (await defaultDeps(db, found.run.organizationId)), reviewId);
  } catch (error) {
    console.error(`Handing review ${reviewId} to its ralph run failed`, error);
  }
}
