import { cronUnauthorized, isCronRequest } from "@/lib/cron";
import { getDb } from "@/lib/db";
import { getDispatcher } from "@/lib/dispatch";
import { checkRalphReconcile, finishRalphFullPass } from "@/lib/ralph/due";
import { reconcileAllOrganizations, reconcileDueRuns } from "@/lib/ralph/reconcile-cron";
import { scmAdapterFor } from "@/lib/scm/adapters";
import { liveRoute } from "@/lib/live/request";

/**
 * Vercel Cron (`vercel.json`, every 10 minutes): advances the ralph runs due
 * by the cron's schedule (`ralph:due`, see `lib/ralph/due`): a failed advance
 * or a job outcome that was never applied (their safety checks), a waiting run's
 * hourly re-check (a blocker completed without a webhook, or one that was lost),
 * a pending or running run without a job. Each is rescheduled from its result.
 * With none due, it returns `{ skipped: true }` without querying Postgres.
 *
 * Once a day (`ralph:reconciled`), and on every invocation without Redis, it does
 * the full pass instead: for every organization with a Linear workspace connected
 * (with that workspace's gateway), and for the chat runs of organizations without
 * one, advances waiting and stale runs, cleans up merged ralph PRs/MRs (the
 * fallback for merge webhooks; it also deletes kept branches nobody answered
 * about in time) and checks the CI of every open one (the fallback for CI
 * webhooks). The counts are summed over the organizations.
 */
async function get(req: Request): Promise<Response> {
  if (!isCronRequest(req)) return cronUnauthorized();
  const db = getDb();
  const deps = { db, dispatcher: getDispatcher(), adapterFor: scmAdapterFor };
  const check = await checkRalphReconcile(db);
  if (!check.fullPass && check.dueRunIds.length === 0) return Response.json({ skipped: true });

  let dueRunIds = check.dueRunIds;
  let totals;
  if (check.fullPass) {
    totals = await reconcileAllOrganizations(deps);
    await finishRalphFullPass();
    // The runs the full pass advanced were rescheduled: only the others are still due.
    dueRunIds = (await checkRalphReconcile(db)).dueRunIds;
  }
  const due = await reconcileDueRuns(deps, dueRunIds);
  return Response.json({ ...totals, due });
}

export const GET = liveRoute(get);
