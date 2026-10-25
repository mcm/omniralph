import { cronUnauthorized, isCronRequest } from "@/lib/cron";
import { getDb } from "@/lib/db";
import { sweepAgentLiveness } from "@/lib/harnesses/liveness";
import { liveRoute } from "@/lib/live/request";

/**
 * Vercel Cron (`vercel.json`, every minute): announces offline (a live `agent` change)
 * every agent whose last heartbeat is older than the online window. Heartbeats announce
 * them online again.
 */
async function get(req: Request): Promise<Response> {
  if (!isCronRequest(req)) return cronUnauthorized();
  const offline = await sweepAgentLiveness(getDb());
  return Response.json({ offline: offline.length });
}

export const GET = liveRoute(get);
