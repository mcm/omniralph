import { getAgent, getJob, startJob } from "@omniralph/db";
import { MAX_JOB_DELIVERIES, type JobStartResponse } from "@omniralph/shared";
import { requireAgent } from "@/lib/agent-auth/verify";
import { jobIdParam, signJobToken, type JobRouteContext } from "@/lib/agent-api/jobs";
import { getDb } from "@/lib/db";

/**
 * Called by an agent when it receives a job's queue message. Atomically marks
 * the job `running` on the agent and counts the delivery; returns `run` with
 * the job and a job token, or `skip` (the agent then acknowledges the message).
 */
export async function POST(req: Request, ctx: JobRouteContext): Promise<Response> {
  const principal = await requireAgent(req);
  if (principal instanceof Response) return principal;
  const db = getDb();
  const { agentId } = principal;
  const jobId = await jobIdParam(ctx);
  const [agent, job] = jobId ? await Promise.all([getAgent(db, agentId), getJob(db, jobId)]) : [];
  if (!agent || !job) {
    return Response.json({ action: "skip", reason: "not_found" } satisfies JobStartResponse);
  }

  // Sign before starting: if signing (KMS) fails, no delivery is used up.
  const jobToken = await signJobToken(job, agentId);
  const started = await startJob(db, {
    jobId: job.id,
    agentId,
    enabledCapabilities: agent.enabledCapabilities,
    maxDeliveries: MAX_JOB_DELIVERIES,
  });
  if (started.action === "skip") {
    return Response.json({ action: "skip", reason: started.reason } satisfies JobStartResponse);
  }
  const { id, capability, type, repositoryId, payload, deliveryCount } = started.job;
  return Response.json({
    action: "run",
    job: { id, capability, type, repositoryId, payload, deliveryCount },
    jobToken,
  } satisfies JobStartResponse);
}
