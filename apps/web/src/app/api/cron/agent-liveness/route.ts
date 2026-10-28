import { refreshAllHostToolWaits } from "@omniralph/db";
import { cronUnauthorized, isCronRequest } from "@/lib/cron";
import { getDb } from "@/lib/db";
import { sweepAgentLiveness } from "@/lib/agents/liveness";
import { liveRoute } from "@/lib/live/request";

/**
 * Vercel Cron (`vercel.json`, every minute): announces offline (a live `agent` change)
 * every agent whose last heartbeat is older than the online window. Heartbeats announce
 * them online again. Then refreshes what queued jobs wait for (`refreshAllHostToolWaits`): an
 * agent gone offline or revoked no longer counts for the host tools it reports.
 */
async function get(req: Request): Promise<Response> {
  if (!isCronRequest(req)) return cronUnauthorized();
  const db = getDb();
  const offline = await sweepAgentLiveness(db);
  const waits = await refreshAllHostToolWaits(db);
  return Response.json({ offline: offline.length, waits });
}

export const GET = liveRoute(get);
