import { TrackerEntityId } from "@omniralph/shared";
import { notFound } from "@/lib/agent-api/jobs";
import { runTrackerIssue, serveRunTrackerTool } from "@/lib/runs/tracker";
import { liveRoute } from "@/lib/live/request";

interface IssueRouteContext {
  params: Promise<{ id: string; issueId: string }>;
}

/** `tracker_get_issue`: an issue (by ID or identifier) of the run's organization's tracker. */
async function get(req: Request, ctx: IssueRouteContext): Promise<Response> {
  const issueId = TrackerEntityId.safeParse((await ctx.params).issueId);
  if (!issueId.success) return notFound();
  return serveRunTrackerTool(req, ctx, "tracker_get_issue", async (tracker) => ({
    issue: runTrackerIssue(await tracker.getIssue(issueId.data)),
  }));
}

export const GET = liveRoute(get);
