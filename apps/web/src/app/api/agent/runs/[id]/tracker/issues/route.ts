import { TrackerSearchQuery } from "@omniralph/shared";
import type { JobRouteContext } from "@/lib/agent-api/jobs";
import { runTrackerIssue, serveRunTrackerTool } from "@/lib/runs/tracker";
import { liveRoute } from "@/lib/live/request";

/**
 * `tracker_search_issues`: issues of the run's organization's tracker
 * matching `query` (full text), best match first, at most `first` (default
 * 10, at most 25). 400 `invalid_query` for a missing or too long query.
 */
async function get(req: Request, ctx: JobRouteContext): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const search = TrackerSearchQuery.safeParse({
    query: params.get("query") ?? undefined,
    first: params.get("first") ?? undefined,
  });
  if (!search.success) return Response.json({ error: "invalid_query" }, { status: 400 });
  return serveRunTrackerTool(req, ctx, "tracker_search_issues", async (tracker) => ({
    issues: (await tracker.searchIssues(search.data.query, { first: search.data.first })).map(
      runTrackerIssue,
    ),
  }));
}

export const GET = liveRoute(get);
