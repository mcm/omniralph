import {
  answerRunPermissionRequest,
  createRunPermissionRequest,
  getJobForHarness,
} from "@omniralph/db";
import { RalphPermissionRequest } from "@omniralph/shared";
import { badRequest, readJson } from "@/lib/harness-auth/request";
import { requireJob } from "@/lib/harness-auth/verify";
import { jobIdParam, notFound, type JobRouteContext } from "@/lib/harness-api/jobs";
import { getDb } from "@/lib/db";
import { getLinearGateway } from "@/lib/linear/client";
import { askPermission } from "@/lib/ralph/permissions";

function forbidden(error: string): Response {
  return Response.json({ error }, { status: 403 });
}

/**
 * Stores a request of a running job's session to approve a tool call in
 * `run_permission_requests` (idempotent per `requestId`). A ralph job also
 * asks its run's conversation (`lib/ralph/permissions.ts`). Needs the job's
 * own token (session or legacy) with `run:activity`; the body is a
 * `RalphPermissionRequest`. The harness then polls
 * `GET …/permissions/{requestId}`. 410 when the ralph run is over (the request
 * is closed as expired and the harness denies the call); 502 when Linear fails.
 */
export async function POST(req: Request, ctx: JobRouteContext): Promise<Response> {
  const principal = await requireJob(req, "run:activity");
  if (principal instanceof Response) return principal;
  const jobId = await jobIdParam(ctx);
  if (!jobId) return notFound();
  if (jobId !== principal.jobId) return forbidden("job_mismatch");
  const db = getDb();
  const job = await getJobForHarness(db, jobId, principal.harnessId);
  if (!job) return notFound();
  const request = RalphPermissionRequest.safeParse(await readJson(req));
  if (!request.success) return badRequest();
  const requestId = request.data.requestId.toLowerCase();
  const now = new Date();
  await createRunPermissionRequest(db, {
    jobId: job.id,
    requestId,
    tool: request.data.tool,
    detail: request.data.detail,
    askedAt: now,
    expiresAt: new Date(now.getTime() + request.data.timeoutSeconds * 1000),
  });
  if (!job.ralphRunId) return Response.json({ status: "pending" });

  try {
    const outcome = await askPermission(
      { db, linear: (organizationId) => getLinearGateway({ db, organizationId }) },
      job,
      request.data,
      now,
    );
    if (outcome.status === "no_run") {
      await answerRunPermissionRequest(db, { jobId: job.id, requestId, answer: "expired" });
      return Response.json({ error: "run_over" }, { status: 410 });
    }
    return Response.json({ status: "pending" });
  } catch (error) {
    console.error("asking for a tool permission in Linear failed", error);
    return Response.json({ error: "linear_unavailable" }, { status: 502 });
  }
}
