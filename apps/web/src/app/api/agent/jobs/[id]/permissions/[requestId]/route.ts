import { getJobForAgent, getRun } from "@omniralph/db";
import { requireJob } from "@/lib/agent-auth/verify";
import { jobIdParam, notFound } from "@/lib/agent-api/jobs";
import { getDb } from "@/lib/db";
import { getLinearGateway } from "@/lib/linear/client";
import { isRalphJob } from "@/lib/ralph/activities";
import { expirePermission, readPermission } from "@/lib/ralph/permissions";

interface PermissionRouteContext {
  params: Promise<{ id: string; requestId: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The calling job's ralph job and the request ID, or the error response. */
async function resolve(req: Request, ctx: PermissionRouteContext) {
  const principal = await requireJob(req, "ralph:activity");
  if (principal instanceof Response) return principal;
  const jobId = await jobIdParam(ctx);
  const { requestId } = await ctx.params;
  if (!jobId || !UUID.test(requestId)) return notFound();
  if (jobId !== principal.jobId) {
    return Response.json({ error: "job_mismatch" }, { status: 403 });
  }
  const db = getDb();
  const job = await getJobForAgent(db, jobId, principal.agentId);
  if (!job) return notFound();
  if (!isRalphJob(job)) return Response.json({ error: "not_a_ralph_job" }, { status: 403 });
  return { db, job, requestId: requestId.toLowerCase() };
}

/** The answer to a permission question so far (`RalphPermissionAnswer`). */
export async function GET(req: Request, ctx: PermissionRouteContext): Promise<Response> {
  const resolved = await resolve(req, ctx);
  if (resolved instanceof Response) return resolved;
  const { db, job, requestId } = resolved;
  const run = job.ralphRunId ? await getRun(db, job.ralphRunId) : null;
  return Response.json(readPermission(run, job, requestId));
}

/** The agent stopped waiting for an answer and denied the call: the question is closed. */
export async function DELETE(req: Request, ctx: PermissionRouteContext): Promise<Response> {
  const resolved = await resolve(req, ctx);
  if (resolved instanceof Response) return resolved;
  const { db, job, requestId } = resolved;
  await expirePermission(
    { db, linear: (organizationId) => getLinearGateway({ db, organizationId }) },
    job,
    requestId,
  );
  return new Response(null, { status: 204 });
}
