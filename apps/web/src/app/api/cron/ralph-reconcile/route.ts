import { cronUnauthorized, isCronRequest } from "@/lib/cron";
import { getDb } from "@/lib/db";
import { getDispatcher } from "@/lib/dispatch";
import { reconcileAllOrganizations } from "@/lib/ralph/reconcile-cron";
import { scmAdapterFor } from "@/lib/scm/adapters";

/**
 * Vercel Cron (`vercel.json`, every 10 minutes): for every organization with a
 * Linear workspace connected (with that workspace's gateway), and for the chat
 * runs of organizations without one, advances waiting ralph runs, so a blocker
 * completed without a webhook (or one that was lost) still wakes them, and
 * picks up runs whose last job outcome was never applied or whose request was
 * never enqueued. Then cleans up merged ralph PRs/MRs (the fallback for merge
 * webhooks; it also deletes kept branches nobody answered about in time) and
 * checks the CI of every open one (the fallback for CI webhooks). The counts
 * are summed over the organizations.
 */
export async function GET(req: Request): Promise<Response> {
  if (!isCronRequest(req)) return cronUnauthorized();
  const totals = await reconcileAllOrganizations({
    db: getDb(),
    dispatcher: getDispatcher(),
    adapterFor: scmAdapterFor,
  });
  return Response.json(totals);
}
