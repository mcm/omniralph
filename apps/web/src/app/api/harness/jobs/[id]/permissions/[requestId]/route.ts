import { answerRunPermissionRequest, getJobForHarness } from "@omniralph/db";
import { requireJob } from "@/lib/harness-auth/verify";
import { jobIdParam, notFound } from "@/lib/harness-api/jobs";
import { getDb } from "@/lib/db";
import { getLinearGateway } from "@/lib/linear/client";
import { expirePermission } from "@/lib/ralph/permissions";
import { readRunPermission } from "@/lib/runs/permissions";
import { liveRoute } from "@/lib/live/request";

interface PermissionRouteContext {
  params: Promise<{ id: string; requestId: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The calling job and the request ID, or the error response. */
async function resolve(req: Request, ctx: PermissionRouteContext) {
  const principal = await requireJob(req, "run:activity");
  if (principal instanceof Response) return principal;
  const jobId = await jobIdParam(ctx);
  const { requestId } = await ctx.params;
  if (!jobId || !UUID.test(requestId)) return notFound();
  if (jobId !== principal.jobId) {
    return Response.json({ error: "job_mismatch" }, { status: 403 });
  }
  const db = getDb();
  const job = await getJobForHarness(db, jobId, principal.harnessId);
  if (!job) return notFound();
  return { db, job, requestId: requestId.toLowerCase() };
}

/**
 * The answer to a permission request so far (`RalphPermissionAnswer`), from
 * the stored request (`readRunPermission`).
 */
async function get(req: Request, ctx: PermissionRouteContext): Promise<Response> {
  const resolved = await resolve(req, ctx);
  if (resolved instanceof Response) return resolved;
  const { db, job, requestId } = resolved;
  return Response.json(await readRunPermission(db, job, requestId));
}

/**
 * The harness stopped waiting for an answer and denied the call: the request
 * is closed as expired (unless already answered), and so is a ralph run's question.
 */
async function remove(req: Request, ctx: PermissionRouteContext): Promise<Response> {
  const resolved = await resolve(req, ctx);
  if (resolved instanceof Response) return resolved;
  const { db, job, requestId } = resolved;
  await answerRunPermissionRequest(db, { jobId: job.id, requestId, answer: "expired" });
  if (!job.ralphRunId) return new Response(null, { status: 204 });
  await expirePermission(
    { db, linear: (organizationId) => getLinearGateway({ db, organizationId }) },
    job,
    requestId,
  );
  return new Response(null, { status: 204 });
}

export const GET = liveRoute(get);
export const DELETE = liveRoute(remove);
