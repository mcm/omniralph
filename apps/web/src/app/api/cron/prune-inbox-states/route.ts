import { pruneInboxItemStates } from "@omniralph/db";
import { cronUnauthorized, isCronRequest } from "@/lib/cron";
import { getDb } from "@/lib/db";
import { liveRoute } from "@/lib/live/request";

/**
 * Vercel Cron (`vercel.json`): deletes users' Done and Snooze states of Inbox items
 * (`inbox_item_states`) not updated for `INBOX_ITEM_STATE_RETENTION_DAYS` (60). Their items
 * are older than the Inbox's 14-day window by then, so none shows up again.
 */
async function get(req: Request): Promise<Response> {
  if (!isCronRequest(req)) return cronUnauthorized();
  const pruned = await pruneInboxItemStates(getDb());
  return Response.json({ pruned });
}

export const GET = liveRoute(get);
