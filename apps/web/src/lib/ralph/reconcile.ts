/**
 * What wakes ralph runs besides their own jobs: `Issue` webhooks (a blocker,
 * manual story or story changed state) and the reconcile cron (re-checks
 * waiting runs' blockers and picks up runs whose last job outcome was never
 * applied).
 */
import { listRunsAffectedByIssue, listRunsToReconcile } from "@omniralph/db";
import { advanceRun, type AdvanceResult, type RalphDeps } from "./run";

/** How long a pending or running run without a job may sit before the cron advances it. */
export const RECONCILE_STALE_MS = 10 * 60 * 1000;

/**
 * Advances every unfinished run of the organization an issue's state change may move: waiting runs
 * whose `waiting_on` lists it and runs that have it as a story. Throws (after
 * trying them all) if one failed, so the webhook delivery is retried.
 */
export async function wakeRunsForIssue(issueId: string, deps: RalphDeps): Promise<AdvanceResult[]> {
  const results: AdvanceResult[] = [];
  let failure: unknown;
  for (const run of await listRunsAffectedByIssue(deps.db, deps.organizationId, issueId)) {
    try {
      results.push(await advanceRun(run.id, deps));
    } catch (error) {
      console.error(
        `Advancing ralph run ${run.id} after a change to issue ${issueId} failed`,
        error,
      );
      failure ??= error;
    }
  }
  if (failure) throw failure;
  return results;
}

/**
 * Advances the organization's waiting runs and stale runs without an active
 * job. Failures are logged and counted.
 */
export async function reconcileRuns(
  deps: RalphDeps,
  now = new Date(),
): Promise<{ reconciled: number; failed: number }> {
  const runs = await listRunsToReconcile(
    deps.db,
    deps.organizationId,
    new Date(now.getTime() - RECONCILE_STALE_MS),
  );
  let failed = 0;
  for (const run of runs) {
    try {
      await advanceRun(run.id, deps);
    } catch (error) {
      failed += 1;
      console.error(`Reconciling ralph run ${run.id} failed`, error);
    }
  }
  return { reconciled: runs.length - failed, failed };
}
