import { pruneRateLimits } from "@omniralph/db";
import { cronUnauthorized, isCronRequest } from "@/lib/cron";
import { getDb } from "@/lib/db";
import { RATE_LIMIT_RETENTION_SECONDS } from "@/lib/rate-limit";

/**
 * Vercel Cron (`vercel.json`): deletes `rate_limits` counters whose window
 * started more than `RATE_LIMIT_RETENTION_SECONDS` ago. Every limit, failure
 * window and lockout is shorter than that, so no live counter is lost.
 */
export async function GET(req: Request): Promise<Response> {
  if (!isCronRequest(req)) return cronUnauthorized();
  const before = new Date(Date.now() - RATE_LIMIT_RETENTION_SECONDS * 1000);
  const pruned = await pruneRateLimits(getDb(), before);
  return Response.json({ pruned });
}
