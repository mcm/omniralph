import { flushAgentAuth } from "@/lib/agent-auth/refresh";
import { cronUnauthorized, isCronRequest } from "@/lib/cron";
import { getDb } from "@/lib/db";
import { liveRoute } from "@/lib/live/request";

/**
 * Vercel Cron (`vercel.json`), in the daily window: writes the agents' refresh-token
 * generations and the `token_refresh` audit rows buffered in Redis since the last run to
 * Postgres (`flushAgentAuth`). Does nothing with hot state off: refreshes write to
 * Postgres directly then.
 */
async function get(req: Request): Promise<Response> {
  if (!isCronRequest(req)) return cronUnauthorized();
  return Response.json(await flushAgentAuth(getDb()));
}

export const GET = liveRoute(get);
