import { cronUnauthorized, isCronRequest } from "@/lib/cron";
import { getDb } from "@/lib/db";
import { getDispatcher } from "@/lib/dispatch";
import { getLinearGateway, LinearNotConnectedError } from "@/lib/linear/client";
import { reconcileRuns } from "@/lib/ralph/reconcile";
import { scmAdapterFor } from "@/lib/scm/adapters";

/**
 * Vercel Cron (`vercel.json`, every 10 minutes): advances waiting ralph runs,
 * so a blocker completed without a webhook (or one that was lost) still wakes
 * them, and picks up runs whose last job outcome was never applied.
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
  return Response.json(
    await reconcileRuns({ db, linear, dispatcher: getDispatcher(), adapterFor: scmAdapterFor }),
  );
}
