import { cronUnauthorized, isCronRequest } from "@/lib/cron";
import { getDb } from "@/lib/db";
import { getDispatcher } from "@/lib/dispatch";
import { checkRalphReconcile, finishRalphReconcile } from "@/lib/ralph/active";
import { reconcileAllOrganizations } from "@/lib/ralph/reconcile-cron";
import { scmAdapterFor } from "@/lib/scm/adapters";
import { liveRoute } from "@/lib/live/request";

/**
 * Vercel Cron (`vercel.json`, every 10 minutes): for every organization with a
 * Linear workspace connected (with that workspace's gateway), and for the chat
 * runs of organizations without one, advances waiting ralph runs, so a blocker
 * completed without a webhook (or one that was lost) still wakes them, and
 * picks up runs whose last job outcome was never applied or whose request was
 * never enqueued. Then cleans up merged ralph PRs/MRs (the fallback for merge
 * webhooks; it also deletes kept branches nobody answered about in time) and
 * checks the CI of every open one (the fallback for CI webhooks). The counts
 * are summed over the organizations. With Redis, it returns without querying
 * Postgres while nothing marked ralph work since a run that found none (and the
 * last full run is less than a day old), and while ralph work exists but passes
 * change nothing, backs off from every 10 minutes to every hour until something
 * changes: see `lib/ralph/active`.
 */
async function get(req: Request): Promise<Response> {
  if (!isCronRequest(req)) return cronUnauthorized();
  const db = getDb();
  const check = await checkRalphReconcile(db);
  if (!check.run) return Response.json({ skipped: true });
  const totals = await reconcileAllOrganizations({
    db,
    dispatcher: getDispatcher(),
    adapterFor: scmAdapterFor,
  });
  await finishRalphReconcile(db, check);
  return Response.json(totals);
}

export const GET = liveRoute(get);
