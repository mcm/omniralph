import { getAgent, getJob, getJobForAgent, startJob } from "@omniralph/db";
import { MAX_JOB_DELIVERIES, type JobStartResponse } from "@omniralph/shared";
import { requireAgent } from "@/lib/agent-auth/verify";
import {
  jobIdParam,
  runnableCapabilities,
  signJobToken,
  type JobRouteContext,
} from "@/lib/agent-api/jobs";
import { getDb } from "@/lib/db";
import { jobOutcomeHandler } from "@/lib/jobs/handlers";

/**
 * Called by an agent when it receives a job's queue message. Atomically marks
 * the job `running` on the agent and counts the delivery; returns `run` with
 * the job and a job token, or `skip` (the agent then acknowledges the message).
 * The job type's outcome handler hears about the start (`onStarted`, which may
 * still skip it), a delivery past the limit (`onFailed`) and a canceled job
 * (`onCanceled`).
 */
export async function POST(req: Request, ctx: JobRouteContext): Promise<Response> {
  const principal = await requireAgent(req);
  if (principal instanceof Response) return principal;
  const db = getDb();
  const { agentId } = principal;
  const jobId = await jobIdParam(ctx);
  // Another organization's job is "not found": its message never reaches this agent's topics.
  const [agent, job] = jobId
    ? await Promise.all([getAgent(db, agentId), getJobForAgent(db, jobId, agentId)])
    : [];
  if (!agent || !job) {
    return Response.json({ action: "skip", reason: "not_found" } satisfies JobStartResponse);
  }

  // Sign before starting: if signing (KMS) fails, no delivery is used up.
  const jobToken = await signJobToken(job, agentId);
  const started = await startJob(db, {
    jobId: job.id,
    agentId,
    organizationId: agent.organizationId,
    enabledCapabilities: runnableCapabilities(agent.enabledCapabilities),
    maxDeliveries: MAX_JOB_DELIVERIES,
  });
  const handler = jobOutcomeHandler(job);
  if (started.action === "skip") {
    if (handler && started.reason === "max_deliveries") {
      const failed = (await getJob(db, job.id)) ?? job;
      await handler.onFailed?.(db, failed, failed.error ?? "Gave up after too many deliveries");
    } else if (handler && started.reason === "canceled") {
      await handler.onCanceled?.(db, job);
    }
    return Response.json({ action: "skip", reason: started.reason } satisfies JobStartResponse);
  }
  if (handler?.onStarted) {
    const hook = await handler.onStarted(db, started.job, agentId);
    if (hook.skip) {
      return Response.json({ action: "skip", reason: hook.reason } satisfies JobStartResponse);
    }
  }
  const { id, capability, type, repositoryId, payload, deliveryCount } = started.job;
  return Response.json({
    action: "run",
    job: { id, capability, type, repositoryId, payload, deliveryCount },
    jobToken,
  } satisfies JobStartResponse);
}
