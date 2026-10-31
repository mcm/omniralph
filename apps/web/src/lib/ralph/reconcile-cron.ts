/**
 * The ralph reconcile cron's work (see the `ralph-reconcile` route): the runs
 * due by its schedule (`lib/ralph/due`), and the full pass over every
 * organization: runs, then cleanup, then CI.
 */
import {
  listChatRunOrganizationIds,
  listIntegratedOrganizationIds,
  listRunsByIds,
  type RalphRun,
  type RalphRunOrigin,
} from "@omniralph/db";
import {
  disconnectedLinearGateway,
  getLinearGateway,
  getLinearGatewayOrDisconnected,
  LinearNotConnectedError,
} from "@/lib/linear/client";
import type { LinearGateway } from "@/lib/linear/gateway";
import { reconcileCi } from "./ci";
import { reconcileCleanup } from "./cleanup";
import { scheduleRun } from "./due";
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
 * organization's Linear gateway, or a disconnected one for the chat runs of an
 * organization without Linear. Each advance reschedules its run (a failed one
 * keeps its safety check). A run that's gone, and a Linear run of an
 * organization that disconnected Linear (the full pass skips those too), leave
 * the schedule. Failures are logged and counted.
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
        await advanceRun(run.id, { ...deps, organizationId, linear: gateway.linear });
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
 * The Linear gateway for an organization's due runs, and the runs it can advance: the
 * connected workspace's for all of them, else a disconnected one for the chat runs (the
 * Linear runs leave the schedule).
 */
async function dueRunsGateway(
  deps: Pick<RalphDeps, "db">,
  organizationId: string,
  runs: RalphRun[],
): Promise<{ linear: LinearGateway; runs: RalphRun[] }> {
  if (runs.every((run) => run.origin === "chat")) {
    return { linear: await getLinearGatewayOrDisconnected({ db: deps.db, organizationId }), runs };
  }
  try {
    return { linear: await getLinearGateway({ db: deps.db, organizationId }), runs };
  } catch (error) {
    if (!(error instanceof LinearNotConnectedError)) throw error;
  }
  const linearRuns = runs.filter((run) => run.origin !== "chat");
  for (const run of linearRuns) await scheduleRun(run.id, null);
  return {
    linear: disconnectedLinearGateway(),
    runs: runs.filter((run) => run.origin === "chat"),
  };
}

/**
 * Reconciles every organization with a Linear workspace connected (all its
 * runs, with that workspace's gateway), then the chat runs of organizations
 * without one (with a disconnected gateway: chat runs don't need Linear).
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

  const withLinear = await listIntegratedOrganizationIds(db, "linear");
  for (const organizationId of withLinear) {
    let linear;
    try {
      linear = await getLinearGateway({ db, organizationId });
    } catch (error) {
      // Disconnected meanwhile.
      if (error instanceof LinearNotConnectedError) continue;
      console.error(`Reconciling the ralph runs of organization ${organizationId} failed`, error);
      totals.failed += 1;
      continue;
    }
    await reconcile({ ...deps, organizationId, linear });
  }

  const linearOrganizations = new Set(withLinear);
  for (const organizationId of await listChatRunOrganizationIds(db)) {
    if (linearOrganizations.has(organizationId)) continue;
    let linear;
    try {
      linear = await getLinearGatewayOrDisconnected({ db, organizationId });
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
