/**
 * The ralph reconcile cron's work (see the `ralph-reconcile` route): the runs
 * and lanes due by its schedule (`lib/ralph/due`), and the full pass over every
 * organization: runs, then cleanup, then CI.
 */
import {
  listChatRunOrganizationIds,
  listLanesByIds,
  listRunsByIds,
  type RalphRun,
  type RalphRunOrigin,
} from "@omniralph/db";
import type { TrackerGateway } from "@omniralph/tracker";
import {
  disconnectedTrackerGateway,
  getTrackerGateway,
  getTrackerGatewayOrDisconnected,
  lazyTrackerGateway,
  listTrackerOrganizationIds,
  TrackerNotConnectedError,
} from "@/lib/tracker/client";
import { reconcileCi } from "./ci";
import { reconcileCleanup, reconcileLane, startPendingCleanups } from "./cleanup";
import { scheduleLane, scheduleRun } from "./due";
import { reconcileRuns } from "./reconcile";
import { advanceRun, type RalphDeps } from "./run";

export interface ReconcileTotals {
  organizations: number;
  reconciled: number;
  failed: number;
  cleanup: { checked: number; started: number; expired: number; failed: number };
  ci: { checked: number; failed: number };
}

/**
 * Advances the due runs (`runIds`), organization by organization: with the
 * organization's tracker gateway, or a disconnected one for the chat runs of an
 * organization without a tracker. Each advance reschedules its run (a failed one
 * keeps its safety check), then the lanes' pending cleanups start if the run's
 * jobs are through (an outcome hook that never ran). A run that's gone, and a
 * tracker run of an organization that disconnected its tracker (the full pass skips
 * those too), leave the schedule. Failures are logged and counted.
 */
export async function reconcileDueRuns(
  deps: Omit<RalphDeps, "organizationId" | "linear">,
  runIds: readonly string[],
): Promise<{ reconciled: number; failed: number }> {
  const totals = { reconciled: 0, failed: 0 };
  if (runIds.length === 0) return totals;
  const runs = await listRunsByIds(deps.db, runIds);
  const found = new Set(runs.map((run) => run.id));
  for (const runId of runIds) if (!found.has(runId)) await scheduleRun(runId, null);

  const byOrganization = new Map<string, RalphRun[]>();
  for (const run of runs) {
    byOrganization.set(run.organizationId, [
      ...(byOrganization.get(run.organizationId) ?? []),
      run,
    ]);
  }
  for (const [organizationId, organizationRuns] of byOrganization) {
    let gateway;
    try {
      gateway = await dueRunsGateway(deps, organizationId, organizationRuns);
    } catch (error) {
      console.error(
        `Reconciling the due ralph runs of organization ${organizationId} failed`,
        error,
      );
      totals.failed += organizationRuns.length;
      continue;
    }
    for (const run of gateway.runs) {
      try {
        const ralph = { ...deps, organizationId, linear: gateway.linear };
        await advanceRun(run.id, ralph);
        await startPendingCleanups(ralph, run.id);
        totals.reconciled += 1;
      } catch (error) {
        totals.failed += 1;
        console.error(`Reconciling ralph run ${run.id} failed`, error);
      }
    }
  }
  return totals;
}

/**
 * Checks the due lanes' cleanup (`reconcileLane`: retries a failed one, deletes a kept
 * branch at its deadline, applies a cleanup job's outcome that was missed) and reschedules
 * each, with its organization's tracker gateway (loaded on its first use; a disconnected one
 * without a tracker). A lane that's gone leaves the schedule; one that failed keeps its entry,
 * so the next invocation tries again. Failures are logged and counted.
 */
export async function reconcileDueLanes(
  deps: Omit<RalphDeps, "organizationId" | "linear">,
  laneIds: readonly string[],
  now = new Date(),
): Promise<{ checked: number; started: number; expired: number; failed: number }> {
  const totals = { checked: 0, started: 0, expired: 0, failed: 0 };
  if (laneIds.length === 0) return totals;
  const lanes = await listLanesByIds(deps.db, laneIds);
  const found = new Set(lanes.map(({ lane }) => lane.id));
  for (const laneId of laneIds) if (!found.has(laneId)) await scheduleLane(laneId, null);

  const gateways = new Map<string, TrackerGateway>();
  for (const { lane, run } of lanes) {
    const { organizationId } = run;
    let linear = gateways.get(organizationId);
    if (!linear) {
      linear = lazyTrackerGateway({ db: deps.db, organizationId });
      gateways.set(organizationId, linear);
    }
    try {
      const done = await reconcileLane({ ...deps, organizationId, linear }, lane, now);
      totals.checked += 1;
      if (done === "started") totals.started += 1;
      if (done === "expired") totals.expired += 1;
    } catch (error) {
      totals.failed += 1;
      console.error(`Checking the cleanup of ralph lane ${lane.id} failed`, error);
    }
  }
  return totals;
}

/**
 * The tracker gateway for an organization's due runs, and the runs it can advance: the
 * connected workspace's for all of them, else a disconnected one for the chat runs (the
 * tracker runs leave the schedule).
 */
async function dueRunsGateway(
  deps: Pick<RalphDeps, "db">,
  organizationId: string,
  runs: RalphRun[],
): Promise<{ linear: TrackerGateway; runs: RalphRun[] }> {
  if (runs.every((run) => run.origin === "chat")) {
    return { linear: await getTrackerGatewayOrDisconnected({ db: deps.db, organizationId }), runs };
  }
  try {
    return { linear: await getTrackerGateway({ db: deps.db, organizationId }), runs };
  } catch (error) {
    if (!(error instanceof TrackerNotConnectedError)) throw error;
  }
  const trackerRuns = runs.filter((run) => run.origin !== "chat");
  for (const run of trackerRuns) await scheduleRun(run.id, null);
  return {
    linear: disconnectedTrackerGateway(),
    runs: runs.filter((run) => run.origin === "chat"),
  };
}

/**
 * Reconciles every organization with a tracker connected (all its
 * runs, with that workspace's gateway), then the chat runs of organizations
 * without one (with a disconnected gateway: chat runs don't need a tracker).
 * The counts are summed over the organizations.
 */
export async function reconcileAllOrganizations(
  deps: Omit<RalphDeps, "organizationId" | "linear">,
  now = new Date(),
): Promise<ReconcileTotals> {
  const { db } = deps;
  const totals: ReconcileTotals = {
    organizations: 0,
    reconciled: 0,
    failed: 0,
    cleanup: { checked: 0, started: 0, expired: 0, failed: 0 },
    ci: { checked: 0, failed: 0 },
  };
  const reconcile = async (ralph: RalphDeps, origin?: RalphRunOrigin) => {
    totals.organizations += 1;
    const runs = await reconcileRuns(ralph, now, origin);
    // Before CI: PRs/MRs found merged here aren't checked for CI again.
    const cleanup = await reconcileCleanup(ralph, now, origin);
    const ci = await reconcileCi(ralph, origin);
    totals.reconciled += runs.reconciled;
    totals.failed += runs.failed;
    for (const k of Object.keys(totals.cleanup) as (keyof typeof cleanup)[]) {
      totals.cleanup[k] += cleanup[k];
    }
    totals.ci.checked += ci.checked;
    totals.ci.failed += ci.failed;
  };

  const withTracker = await listTrackerOrganizationIds(db);
  for (const organizationId of withTracker) {
    let linear;
    try {
      linear = await getTrackerGateway({ db, organizationId });
    } catch (error) {
      // Disconnected meanwhile.
      if (error instanceof TrackerNotConnectedError) continue;
      console.error(`Reconciling the ralph runs of organization ${organizationId} failed`, error);
      totals.failed += 1;
      continue;
    }
    await reconcile({ ...deps, organizationId, linear });
  }

  const trackerOrganizations = new Set(withTracker);
  for (const organizationId of await listChatRunOrganizationIds(db)) {
    if (trackerOrganizations.has(organizationId)) continue;
    let linear;
    try {
      linear = await getTrackerGatewayOrDisconnected({ db, organizationId });
    } catch (error) {
      console.error(
        `Reconciling the chat ralph runs of organization ${organizationId} failed`,
        error,
      );
      totals.failed += 1;
      continue;
    }
    await reconcile({ ...deps, organizationId, linear }, "chat");
  }
  return totals;
}
