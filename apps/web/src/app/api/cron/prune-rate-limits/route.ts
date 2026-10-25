import { cronUnauthorized, isCronRequest } from "@/lib/cron";
import { getDb } from "@/lib/db";
import { pruneRateLimitCounters } from "@/lib/rate-limit";
import { liveRoute } from "@/lib/live/request";

/**
 * Vercel Cron (`vercel.json`): deletes `rate_limits` counters whose window
 * started more than `RATE_LIMIT_RETENTION_SECONDS` ago. Every limit, failure
 * window and lockout is shorter than that, so no live counter is lost. With
 * Redis counting (hot state on), it skips Postgres unless a Redis outage left
 * rows there.
 */
async function get(req: Request): Promise<Response> {
  if (!isCronRequest(req)) return cronUnauthorized();
  const pruned = await pruneRateLimitCounters(getDb());
  return Response.json({ pruned });
}

export const GET = liveRoute(get);
