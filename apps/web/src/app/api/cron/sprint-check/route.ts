import { cronUnauthorized, isCronRequest } from "@/lib/cron";
import { getDb } from "@/lib/db";
import { liveRoute } from "@/lib/live/request";
import { checkRunningSprints, sprintRunDeps } from "@/lib/sprints/run";
import { lazyTrackerGateway } from "@/lib/tracker/client";

/**
 * Vercel Cron (`vercel.json`, hourly): checks every running sprint for a hook that never ran
 * (`checkRunningSprints`). An epic Om claimed whose run never began (Om died before
 * delegating it, or the agent session webhook never came), or whose run failed or was stopped
 * without its sprint pausing, stalls and pauses the sprint with the reason; an epic whose PRs
 * merged unnoticed counts as merged, and a sprint with nothing running starts its next epic.
 */
async function get(req: Request): Promise<Response> {
  if (!isCronRequest(req)) return cronUnauthorized();
  const db = getDb();
  const totals = await checkRunningSprints(db, (organizationId) =>
    sprintRunDeps({ db, organizationId, tracker: lazyTrackerGateway({ db, organizationId }) }),
  );
  return Response.json(totals);
}

export const GET = liveRoute(get);
