import { defaultWakeDeps, processPendingRunEvents } from "@/lib/chat/agent/wake";
import { checkPendingRunEvents, finishPendingRunEvents } from "@/lib/chat/pending-run-events";
import { cronUnauthorized, isCronRequest } from "@/lib/cron";
import { getDb } from "@/lib/db";
import { liveRoute } from "@/lib/live/request";

/**
 * Vercel Cron (`vercel.json`, every minute): wakes the chat responder for
 * every thread with run events pending for over a minute, the fallback for a
 * wake-up `after()` missed, found the thread busy or rate-limited, or that
 * failed. Answers how many threads ended in each status. With Redis, it
 * returns without querying Postgres or initialising the chat bot while no run
 * event was recorded since a run that left none pending: see
 * `lib/chat/pending-run-events`.
 */
async function get(req: Request): Promise<Response> {
  if (!isCronRequest(req)) return cronUnauthorized();
  const db = getDb();
  const check = await checkPendingRunEvents(db);
  if (!check.run) return Response.json({ skipped: true });
  const totals = await processPendingRunEvents(await defaultWakeDeps());
  await finishPendingRunEvents(db, check);
  return Response.json(totals);
}

export const GET = liveRoute(get);
