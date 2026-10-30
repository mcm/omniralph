import { cronUnauthorized, isCronRequest } from "@/lib/cron";
import { getDb } from "@/lib/db";
import { sweepAgentLiveness } from "@/lib/agents/liveness";
import { liveRoute } from "@/lib/live/request";

/**
 * Vercel Cron (`vercel.json`, every minute): announces offline (a live `agent` change)
 * every agent whose last heartbeat is older than the online window, which refreshes what
 * its organization's queued jobs wait for. Heartbeats announce them online again. With
 * Redis, it returns without querying Postgres while every agent announced online has a
 * recent heartbeat: see `lib/agents/liveness`.
 */
async function get(req: Request): Promise<Response> {
  if (!isCronRequest(req)) return cronUnauthorized();
  const offline = await sweepAgentLiveness(getDb());
  return Response.json({ offline: offline.length });
}

export const GET = liveRoute(get);
