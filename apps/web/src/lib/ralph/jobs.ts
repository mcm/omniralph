import "server-only";
import {
  findLaneByPullRequest,
  getReviewRun,
  getLaneByRepository,
  getRun,
  lockRun,
  updateLane,
  updateRun,
  type Database,
  type Job,
} from "@omniralph/db";
import { skipJobAndClearDue } from "@/lib/dispatch/due";
import { getDispatcher } from "@/lib/dispatch";
import { lazyTrackerGateway } from "@/lib/tracker/client";
import { scmAdapterFor } from "@/lib/scm/adapters";
import { checkRunCi } from "./ci";
import { applyCleanupJob, startPendingCleanups } from "./cleanup";
import { cleanupJobLaneId, rescheduleLane, scheduleRun } from "./due";
import { applyHiddenRefsJob } from "./hidden-refs";
import { respondToReview } from "./pull-request-requests";
import { advanceRun, FINISHED_RUN_STATUSES, type RalphDeps } from "./run";

/**
 * Outcome hooks of `ralph.*` jobs (registered in `lib/jobs/handlers.ts`). A
 * job's outcome itself is applied by `advanceRun`, which finds it through the
 * story's `last_job_id`; the hooks only make sure the run is advanced and
 * record the lanes' sticky agents.
 */

/**
 * A delivery started: the agent becomes the sticky agent of the job's lane
 * (the run's lane in the job's repository; its later jobs are targeted at
 * it), and of the run when that is the main lane. A job of a run that is
 * over is skipped.
 */
export async function onRalphJobStarted(
  db: Database,
  job: Job,
  agentId: string,
): Promise<{ skip: false } | { skip: true; reason: "skipped" }> {
  if (!job.ralphRunId) return { skip: false };
  const finished = await lockRun(db, job.ralphRunId, async (tx, run) => {
    if (FINISHED_RUN_STATUSES.has(run.status)) return true;
    const repositoryId = job.repositoryId ?? run.repositoryId;
    const lane = repositoryId ? await getLaneByRepository(tx, run.id, repositoryId) : null;
    if (lane && lane.agentId !== agentId) await updateLane(tx, lane.id, { agentId });
    const main = !repositoryId || repositoryId === run.repositoryId;
    if (main && run.agentId !== agentId) await updateRun(tx, run.id, { agentId });
    return false;
  });
  if (finished ?? true) {
    await skipJobAndClearDue(db, job, { reason: "The coding task is over" });
    return { skip: true, reason: "skipped" };
  }
  return { skip: false };
}

/**
 * The orchestrator's dependencies for an organization's runs: its connected
 * tracker workspace (a disconnected gateway without one, so its chat runs
 * still move; loaded on its first call, so chat runs never touch the tracker),
 * the dispatcher and the SCM adapters.
 */
export async function defaultDeps(db: Database, organizationId: string): Promise<RalphDeps> {
  return {
    db,
    organizationId,
    tracker: lazyTrackerGateway({ db, organizationId }),
    dispatcher: getDispatcher(),
    adapterFor: scmAdapterFor,
  };
}

/**
 * One of the run's jobs finished: an unfinished run moves on (`advanceRun` applies the job's
 * outcome), then what waited for the run's jobs catches up: the CI of its open PRs/MRs
 * (`checkRunCi`) and the lanes' pending cleanups (`startPendingCleanups`). Each does nothing
 * while another of the run's jobs is active (that job's outcome catches up instead).
 */
export async function catchUpRun(deps: RalphDeps, runId: string): Promise<void> {
  const run = await getRun(deps.db, runId);
  if (!run) {
    await scheduleRun(runId, null);
    return;
  }
  const finished = FINISHED_RUN_STATUSES.has(run.status);
  if (!finished) await advanceRun(run.id, deps);
  await checkRunCi(deps, run.id);
  await startPendingCleanups(deps, run.id);
  // A finished run's job (a cleanup) left the outcome's safety check: nothing to advance.
  if (finished) await scheduleRun(run.id, null);
}

/**
 * The job completed, failed for good or was canceled: apply its outcome, move
 * the run on and catch up its CI and pending cleanups (`catchUpRun`). Errors
 * (e.g. the tracker being down) are logged, not thrown: the job's own state is
 * already recorded and the reconcile cron retries the run.
 */
export async function onRalphJobFinished(db: Database, job: Job, deps?: RalphDeps): Promise<void> {
  if (!job.ralphRunId) return;
  try {
    const run = await getRun(db, job.ralphRunId);
    if (!run) return;
    await catchUpRun(deps ?? (await defaultDeps(db, run.organizationId)), run.id);
  } catch (error) {
    console.error(`Advancing ralph run ${job.ralphRunId} after job ${job.id} failed`, error);
  }
}

/**
 * A cleanup job (`worktree.cleanup`, or a legacy `ralph.cleanup`) completed,
 * failed for good or was canceled: its outcome is applied (`applyCleanupJob`)
 * and its lane rescheduled from it (replacing the safety check its completion
 * scheduled), then the run catches up as after any of its jobs (`catchUpRun`).
 * Errors are logged; the reconcile cron catches up (the lane's safety check).
 */
export async function onRalphCleanupJobFinished(
  db: Database,
  job: Job,
  deps?: RalphDeps,
): Promise<void> {
  try {
    await applyHiddenRefsJob(db, job);
  } catch (error) {
    console.error(`Marking the hidden refs of cleanup job ${job.id} deleted failed`, error);
  }
  if (!job.ralphRunId) return;
  try {
    let ralph = deps;
    if (!ralph) {
      const run = await getRun(db, job.ralphRunId);
      if (!run) return;
      ralph = await defaultDeps(db, run.organizationId);
    }
    await applyCleanupJob(ralph, job.id);
    const laneId = cleanupJobLaneId(job);
    if (laneId) await rescheduleLane(db, laneId);
    await catchUpRun(ralph, job.ralphRunId);
  } catch (error) {
    console.error(`Applying the outcome of cleanup job ${job.id} failed`, error);
  }
}

/**
 * A review run completed and was posted: when it reviewed a ralph PR/MR, its
 * open findings may become a request on that lane (`respondToReview`).
 * Errors are logged, not thrown: the review run itself is saved and posted
 * already.
 */
export async function onReviewForRalph(
  db: Database,
  reviewRunId: string,
  deps?: RalphDeps,
): Promise<void> {
  try {
    const run = await getReviewRun(db, reviewRunId);
    const found = run && (await findLaneByPullRequest(db, run.repositoryId, run.prNumber));
    if (!found) return;
    await respondToReview(deps ?? (await defaultDeps(db, found.run.organizationId)), reviewRunId);
  } catch (error) {
    console.error(`Handing review run ${reviewRunId} to its ralph run failed`, error);
  }
}
