import { LinearEntityId, MAX_LINEAR_COMMENTS } from "@omniralph/shared";
import { notFound } from "@/lib/harness-api/jobs";
import { runLinearComment, serveRunLinearTool } from "@/lib/runs/linear";

interface CommentsRouteContext {
  params: Promise<{ id: string; issueId: string }>;
}

/**
 * `linear_list_comments`: an issue's comments, oldest first; only the most
 * recent `MAX_LINEAR_COMMENTS`, with `omitted` counting the older ones.
 */
export async function GET(req: Request, ctx: CommentsRouteContext): Promise<Response> {
  const issueId = LinearEntityId.safeParse((await ctx.params).issueId);
  if (!issueId.success) return notFound();
  return serveRunLinearTool(req, ctx, "linear_list_comments", async (linear) => {
    const comments = await linear.getComments(issueId.data);
    const recent = comments.slice(-MAX_LINEAR_COMMENTS);
    return { comments: recent.map(runLinearComment), omitted: comments.length - recent.length };
  });
}
