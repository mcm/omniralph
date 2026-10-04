import { completeJob, writeAgentAudit } from "@omniralph/db";
import { JobResult, type JobOutcomeResponse } from "@omniralph/shared";
import { badRequest, clientIp, readJson } from "@/lib/agent-auth/request";
import { requireAgent } from "@/lib/agent-auth/verify";
import { jobIdParam, notCurrentAgent, notFound, type JobRouteContext } from "@/lib/agent-api/jobs";
import { getDb } from "@/lib/db";

/**
 * Stores a job's result. Only the job's current agent may submit it: an agent
 * whose delivery was taken over by another one gets 409.
 */
export async function POST(req: Request, ctx: JobRouteContext): Promise<Response> {
  const principal = await requireAgent(req);
  if (principal instanceof Response) return principal;
  const jobId = await jobIdParam(ctx);
  if (!jobId) return notFound();
  const body = JobResult.safeParse(await readJson(req));
  if (!body.success) return badRequest();

  const db = getDb();
  const outcome = await completeJob(db, {
    jobId,
    agentId: principal.agentId,
    result: body.data.result,
  });
  switch (outcome.status) {
    case "not_found":
      return notFound();
    case "conflict":
      return notCurrentAgent();
    case "completed":
    case "canceled":
      await writeAgentAudit(db, {
        agentId: principal.agentId,
        event: "result_submitted",
        ip: clientIp(req),
        detail: { jobId, status: outcome.status },
      });
      return Response.json({ status: outcome.status } satisfies JobOutcomeResponse);
    default:
      throw new Error(`Unexpected result outcome ${outcome.status}`);
  }
}
