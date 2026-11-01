import { TrackerEntityId, MAX_TRACKER_COMMENTS } from "@omniralph/shared";
import { notFound } from "@/lib/agent-api/jobs";
import { runTrackerComment, serveRunTrackerTool } from "@/lib/runs/tracker";
import { liveRoute } from "@/lib/live/request";

interface CommentsRouteContext {
  params: Promise<{ id: string; issueId: string }>;
}

/**
 * `tracker_list_comments`: an issue's comments, oldest first; only the most
 * recent `MAX_TRACKER_COMMENTS`, with `omitted` counting the older ones.
 */
async function get(req: Request, ctx: CommentsRouteContext): Promise<Response> {
  const issueId = TrackerEntityId.safeParse((await ctx.params).issueId);
  if (!issueId.success) return notFound();
  return serveRunTrackerTool(req, ctx, "tracker_list_comments", async (tracker) => {
    const comments = await tracker.getComments(issueId.data);
    const recent = comments.slice(-MAX_TRACKER_COMMENTS);
    return { comments: recent.map(runTrackerComment), omitted: comments.length - recent.length };
  });
}

export const GET = liveRoute(get);
