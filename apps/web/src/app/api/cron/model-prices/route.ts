import { cronUnauthorized, isCronRequest } from "@/lib/cron";
import { refreshModelPrices } from "@/lib/cost/prices";
import { getDb } from "@/lib/db";
import { liveRoute } from "@/lib/live/request";

/**
 * Vercel Cron (`vercel.json`, daily): refreshes Anthropic models' list prices from the AI
 * Gateway's public model list (`refreshModelPrices`) and answers what changed
 * (`{inserted, changed, unchanged}`). A failed fetch changes nothing and answers 502, which
 * Vercel records as a failed cron. A refresh that changes prices publishes a `model_prices`
 * change per organization.
 */
async function get(req: Request): Promise<Response> {
  if (!isCronRequest(req)) return cronUnauthorized();
  const refreshed = await refreshModelPrices({ db: getDb() });
  if (!refreshed.ok) return Response.json({ error: refreshed.error }, { status: 502 });
  return Response.json(refreshed.result);
}

export const GET = liveRoute(get);
