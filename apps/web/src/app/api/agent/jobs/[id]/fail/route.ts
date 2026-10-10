import { failJob, getJob, getJobForAgent } from "@omniralph/db";
import { JobFailure, MAX_JOB_DELIVERIES, type JobOutcomeResponse } from "@omniralph/shared";
import { badRequest, readJson } from "@/lib/agent-auth/request";
import { requireAgent } from "@/lib/agent-auth/verify";
import { jobIdParam, notCurrentAgent, notFound, type JobRouteContext } from "@/lib/agent-api/jobs";
import { getDb } from "@/lib/db";
import { jobOutcomeHandler } from "@/lib/jobs/handlers";

/** Delay before a retryable failure may be claimed again, when the agent doesn't name one. */
const DEFAULT_RETRY_AFTER_SECONDS = 60;

/**
 * Records a failed delivery. Non-retryable failures, and any failure on the
 * last allowed delivery, fail the job. Otherwise the job is queued again,
 * claimable after `retryAfterSeconds`, and the response is `retry`.
 * The job type's outcome handler (`onFailed`, `onCanceled`, `onRetry`) then
 * updates the capability's state, e.g. a review's final failure fails the
 * review and posts a failure note.
 */
export async function POST(req: Request, ctx: JobRouteContext): Promise<Response> {
  const principal = await requireAgent(req);
  if (principal instanceof Response) return principal;
  const jobId = await jobIdParam(ctx);
  if (!jobId) return notFound();
  const body = JobFailure.safeParse(await readJson(req));
  if (!body.success) return badRequest();

  const db = getDb();
  if (!(await getJobForAgent(db, jobId, principal.agentId))) return notFound();
  const retryAfterSeconds = body.data.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS;
  const outcome = await failJob(db, {
    jobId,
    agentId: principal.agentId,
    retryable: body.data.retryable,
    error: body.data.error ?? null,
    maxDeliveries: MAX_JOB_DELIVERIES,
    retryAfterSeconds,
  });
  const job = outcome.status === "not_found" ? null : await getJob(db, jobId);
  const handler = job && jobOutcomeHandler(job);
  if (job && handler) {
    const error = body.data.error ?? null;
    if (outcome.status === "failed") await handler.onFailed?.(db, job, error);
    else if (outcome.status === "canceled") await handler.onCanceled?.(db, job);
    else if (outcome.status === "retry") await handler.onRetry?.(db, job, error);
  }
  switch (outcome.status) {
    case "not_found":
      return notFound();
    case "conflict":
      return notCurrentAgent();
    case "retry":
      return Response.json({
        status: "retry",
        retryAfterSeconds,
      } satisfies JobOutcomeResponse);
    case "failed":
    case "canceled":
    case "completed":
      return Response.json({ status: outcome.status } satisfies JobOutcomeResponse);
  }
}
