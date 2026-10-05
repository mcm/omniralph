import { failJob, getJob } from "@omniralph/db";
import { JobFailure, MAX_JOB_DELIVERIES, type JobOutcomeResponse } from "@omniralph/shared";
import { badRequest, readJson } from "@/lib/agent-auth/request";
import { requireAgent } from "@/lib/agent-auth/verify";
import { jobIdParam, notCurrentAgent, notFound, type JobRouteContext } from "@/lib/agent-api/jobs";
import { getDb } from "@/lib/db";
import {
  isReviewJob,
  onReviewJobCanceled,
  onReviewJobFailed,
  onReviewJobRetry,
} from "@/lib/review/jobs";

/** Lease delay before a retryable failure is redelivered, when the agent doesn't name one. */
const DEFAULT_RETRY_AFTER_SECONDS = 60;

/**
 * Records a failed delivery. Non-retryable failures, and any failure on the
 * last allowed delivery, fail the job (the agent acknowledges the message).
 * Otherwise the response is `retry`: the agent sets the message's lease to
 * `retryAfterSeconds` without acknowledging, so the queue redelivers it.
 * A review job's final failure fails its review and posts a failure note.
 */
export async function POST(req: Request, ctx: JobRouteContext): Promise<Response> {
  const principal = await requireAgent(req);
  if (principal instanceof Response) return principal;
  const jobId = await jobIdParam(ctx);
  if (!jobId) return notFound();
  const body = JobFailure.safeParse(await readJson(req));
  if (!body.success) return badRequest();

  const db = getDb();
  const outcome = await failJob(db, {
    jobId,
    agentId: principal.agentId,
    retryable: body.data.retryable,
    error: body.data.error ?? null,
    maxDeliveries: MAX_JOB_DELIVERIES,
  });
  const job = outcome.status === "not_found" ? null : await getJob(db, jobId);
  if (job && isReviewJob(job)) {
    const error = body.data.error ?? null;
    if (outcome.status === "failed") await onReviewJobFailed(db, job, error ?? "Review failed");
    else if (outcome.status === "canceled") await onReviewJobCanceled(db, job);
    else if (outcome.status === "retry") await onReviewJobRetry(db, job, error);
  }
  switch (outcome.status) {
    case "not_found":
      return notFound();
    case "conflict":
      return notCurrentAgent();
    case "retry":
      return Response.json({
        status: "retry",
        retryAfterSeconds: body.data.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS,
      } satisfies JobOutcomeResponse);
    case "failed":
    case "canceled":
    case "completed":
      return Response.json({ status: outcome.status } satisfies JobOutcomeResponse);
  }
}
