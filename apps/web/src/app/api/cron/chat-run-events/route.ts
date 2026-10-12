import { defaultWakeDeps, processPendingRunEvents } from "@/lib/chat/agent/wake";
import { cronUnauthorized, isCronRequest } from "@/lib/cron";

/**
 * Vercel Cron (`vercel.json`, every minute): wakes the chat responder for
 * every thread with run events pending for over a minute, the fallback for a
 * wake-up `after()` missed, found the thread busy or rate-limited, or that
 * failed. Answers how many threads ended in each status.
 */
export async function GET(req: Request): Promise<Response> {
  if (!isCronRequest(req)) return cronUnauthorized();
  const totals = await processPendingRunEvents(await defaultWakeDeps());
  return Response.json(totals);
}
