/**
 * The ralph reconcile cron's passes over every organization (see the
 * `ralph-reconcile` route): runs, then cleanup, then CI.
 */
import {
  listChatRunOrganizationIds,
  listIntegratedOrganizationIds,
  type RalphRunOrigin,
} from "@omniralph/db";
import {
  getLinearGateway,
  getLinearGatewayOrDisconnected,
  LinearNotConnectedError,
} from "@/lib/linear/client";
import { reconcileCi } from "./ci";
import { reconcileCleanup } from "./cleanup";
import { reconcileRuns } from "./reconcile";
import type { RalphDeps } from "./run";

export interface ReconcileTotals {
  organizations: number;
  reconciled: number;
  failed: number;
  cleanup: { checked: number; started: number; expired: number; failed: number };
  ci: { checked: number; failed: number };
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
