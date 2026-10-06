import { cronUnauthorized, isCronRequest } from "@/lib/cron";
import { getDb } from "@/lib/db";
import { getDispatcher } from "@/lib/dispatch";
import { getLinearGateway, LinearNotConnectedError } from "@/lib/linear/client";
import { reconcileCi } from "@/lib/ralph/ci";
import { reconcileRuns } from "@/lib/ralph/reconcile";
import { scmAdapterFor } from "@/lib/scm/adapters";

/**
 * Vercel Cron (`vercel.json`, every 10 minutes): advances waiting ralph runs,
 * so a blocker completed without a webhook (or one that was lost) still wakes
 * them, and picks up runs whose last job outcome was never applied. Then
 * checks the CI of every open ralph PR/MR (the fallback for CI webhooks).
 */
export async function GET(req: Request): Promise<Response> {
  if (!isCronRequest(req)) return cronUnauthorized();
  const db = getDb();
  let linear;
  try {
    linear = await getLinearGateway({ db });
  } catch (error) {
    if (error instanceof LinearNotConnectedError) {
      return Response.json({ reconciled: 0, failed: 0, linear: "not_connected" });
    }
    throw error;
  }
  const deps = { db, linear, dispatcher: getDispatcher(), adapterFor: scmAdapterFor };
  const runs = await reconcileRuns(deps);
  const ci = await reconcileCi(deps);
  return Response.json({ ...runs, ci });
}
