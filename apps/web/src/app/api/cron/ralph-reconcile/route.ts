import { listIntegratedOrganizationIds } from "@omniralph/db";
import { cronUnauthorized, isCronRequest } from "@/lib/cron";
import { getDb } from "@/lib/db";
import { getDispatcher } from "@/lib/dispatch";
import { getLinearGateway, LinearNotConnectedError } from "@/lib/linear/client";
import { reconcileCi } from "@/lib/ralph/ci";
import { reconcileCleanup } from "@/lib/ralph/cleanup";
import { reconcileRuns } from "@/lib/ralph/reconcile";
import { scmAdapterFor } from "@/lib/scm/adapters";

/**
 * Vercel Cron (`vercel.json`, every 10 minutes): for every organization with a
 * Linear workspace connected (with that workspace's gateway), advances waiting
 * ralph runs, so a blocker completed without a webhook (or one that was lost)
 * still wakes them, and picks up runs whose last job outcome was never
 * applied. Then cleans up merged ralph PRs/MRs (the fallback for merge
 * webhooks; it also deletes kept branches nobody answered about in time) and
 * checks the CI of every open one (the fallback for CI webhooks). The counts
 * are summed over the organizations.
 */
export async function GET(req: Request): Promise<Response> {
  if (!isCronRequest(req)) return cronUnauthorized();
  const db = getDb();
  const totals = {
    organizations: 0,
    reconciled: 0,
    failed: 0,
    cleanup: { checked: 0, started: 0, expired: 0, failed: 0 },
    ci: { checked: 0, failed: 0 },
  };
  for (const organizationId of await listIntegratedOrganizationIds(db, "linear")) {
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
    const deps = {
      db,
      organizationId,
      linear,
      dispatcher: getDispatcher(),
      adapterFor: scmAdapterFor,
    };
    totals.organizations += 1;
    const runs = await reconcileRuns(deps);
    // Before CI: PRs/MRs found merged here aren't checked for CI again.
    const cleanup = await reconcileCleanup(deps);
    const ci = await reconcileCi(deps);
    totals.reconciled += runs.reconciled;
    totals.failed += runs.failed;
    for (const k of Object.keys(totals.cleanup) as (keyof typeof cleanup)[]) {
      totals.cleanup[k] += cleanup[k];
    }
    totals.ci.checked += ci.checked;
    totals.ci.failed += ci.failed;
  }
  return Response.json(totals);
}
