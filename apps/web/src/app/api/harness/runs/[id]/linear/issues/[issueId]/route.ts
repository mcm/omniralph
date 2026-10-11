import { LinearEntityId } from "@omniralph/shared";
import { notFound } from "@/lib/harness-api/jobs";
import { runLinearIssue, serveRunLinearTool } from "@/lib/runs/linear";

interface IssueRouteContext {
  params: Promise<{ id: string; issueId: string }>;
}

/** `linear_get_issue`: an issue (by ID or identifier) of the run's organization's Linear workspace. */
export async function GET(req: Request, ctx: IssueRouteContext): Promise<Response> {
  const issueId = LinearEntityId.safeParse((await ctx.params).issueId);
  if (!issueId.success) return notFound();
  return serveRunLinearTool(req, ctx, "linear_get_issue", async (linear) => ({
    issue: runLinearIssue(await linear.getIssue(issueId.data)),
  }));
}
