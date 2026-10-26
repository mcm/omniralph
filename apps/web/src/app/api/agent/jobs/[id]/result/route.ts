import { completeJob, getJob, getJobForAgent, writeAgentAudit } from "@omniralph/db";
import { JobResult, type JobOutcomeResponse } from "@omniralph/shared";
import { badRequest, clientIp, readJson } from "@/lib/agent-auth/request";
import { requireAgent } from "@/lib/agent-auth/verify";
import { jobIdParam, notCurrentAgent, notFound, type JobRouteContext } from "@/lib/agent-api/jobs";
import { getDb } from "@/lib/db";
import { removeJobsDue } from "@/lib/dispatch/due";
import { organizationPlaybooks } from "@/lib/playbooks";
import { jobHooks } from "@/lib/sinks";
import { liveRoute } from "@/lib/live/request";

/**
 * Stores a job's result. Only the job's current agent may submit it: an agent
 * whose delivery was taken over by another one gets 409.
 *
 * The job's hooks (`jobHooks`: its task's sink, or its type's outcome handler
 * for a legacy job) validate the result (400 when invalid) and
 * act on it once the job completes (`onCompleted`, `onCanceled`): e.g. a
 * review's findings are persisted and posted to the PR/MR, a learned rule is
 * stored, a thread reply is posted. The agent that completed a job with a
 * handler may submit its result again (e.g. after a timeout): that gets
 * `completed` and reruns `onCompleted`, which is idempotent (never a second
 * post).
 */
async function post(req: Request, ctx: JobRouteContext): Promise<Response> {
  const principal = await requireAgent(req);
  if (principal instanceof Response) return principal;
  const jobId = await jobIdParam(ctx);
  if (!jobId) return notFound();
  const body = JobResult.safeParse(await readJson(req));
  if (!body.success) return badRequest();

  const db = getDb();
  const job = await getJobForAgent(db, jobId, principal.agentId);
  if (!job) return notFound();
  const handler = await jobHooks(job, organizationPlaybooks(db, job.organizationId));
  if (handler?.isValidResult && !handler.isValidResult(body.data.result)) return badRequest();

  const outcome = await completeJob(db, {
    jobId,
    agentId: principal.agentId,
    result: body.data.result,
  });
  if (outcome.status === "completed" || outcome.status === "canceled") await removeJobsDue([job]);
  switch (outcome.status) {
    case "not_found":
      return notFound();
    case "conflict": {
      const current = handler ? await getJob(db, jobId) : null;
      if (current?.status === "completed" && current.agentId === principal.agentId) {
        await handler?.onCompleted?.(db, current);
        return Response.json({ status: "completed" } satisfies JobOutcomeResponse);
      }
      return notCurrentAgent();
    }
    case "completed":
    case "canceled": {
      await writeAgentAudit(db, {
        agentId: principal.agentId,
        event: "result_submitted",
        ip: clientIp(req),
        detail: { jobId, status: outcome.status },
      });
      if (handler) {
        const finished = (await getJob(db, jobId))!;
        if (outcome.status === "completed") await handler.onCompleted?.(db, finished);
        else await handler.onCanceled?.(db, finished);
      }
      return Response.json({ status: outcome.status } satisfies JobOutcomeResponse);
    }
    default:
      throw new Error(`Unexpected result outcome ${outcome.status}`);
  }
}

export const POST = liveRoute(post);
