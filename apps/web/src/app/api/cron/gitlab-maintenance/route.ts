import { listProviderScmConnections } from "@omniralph/db";
import { maintainGitLabConnection } from "@/lib/connections/gitlab-maintenance";
import { cronUnauthorized, isCronRequest } from "@/lib/cron";
import { getDb } from "@/lib/db";
import { liveRoute } from "@/lib/live/request";

/**
 * Vercel Cron (`vercel.json`, daily): rotates every GitLab connection's bot
 * token (7-day expiry), then checks the token and the webhooks of its enabled
 * projects and replaces the connection's `health` with what it found
 * (`maintainGitLabConnection`, which an admin's "Rotate token" runs too). It never
 * changes a webhook. A connection whose check fails (e.g. GitLab unreachable)
 * keeps its previous health (plus any rotation problem) and is counted as
 * failed. Each connection whose token or health changed publishes a `connection` change.
 */
async function get(req: Request): Promise<Response> {
  if (!isCronRequest(req)) return cronUnauthorized();
  const db = getDb();
  const totals = { rotated: 0, checked: 0, problems: 0, failed: 0 };
  for (const connection of await listProviderScmConnections(db, "gitlab")) {
    const result = await maintainGitLabConnection(db, connection);
    if (!result.ok) {
      totals.failed += 1;
      continue;
    }
    if (result.rotation === "rotated") totals.rotated += 1;
    totals.checked += 1;
    totals.problems += result.health.problems.length;
  }
  return Response.json(totals);
}

export const GET = liveRoute(get);
