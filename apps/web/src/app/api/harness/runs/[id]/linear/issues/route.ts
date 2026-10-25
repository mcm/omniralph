import { LinearSearchQuery } from "@omniralph/shared";
import type { JobRouteContext } from "@/lib/harness-api/jobs";
import { runLinearIssue, serveRunLinearTool } from "@/lib/runs/linear";
import { liveRoute } from "@/lib/live/request";

/**
 * `linear_search_issues`: issues of the run's organization's Linear workspace
 * matching `query` (full text), best match first, at most `first` (default
 * 10, at most 25). 400 `invalid_query` for a missing or too long query.
 */
async function get(req: Request, ctx: JobRouteContext): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const search = LinearSearchQuery.safeParse({
    query: params.get("query") ?? undefined,
    first: params.get("first") ?? undefined,
  });
  if (!search.success) return Response.json({ error: "invalid_query" }, { status: 400 });
  return serveRunLinearTool(req, ctx, "linear_search_issues", async (linear) => ({
    issues: (await linear.searchIssues(search.data.query, { first: search.data.first })).map(
      runLinearIssue,
    ),
  }));
}

export const GET = liveRoute(get);
