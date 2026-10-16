import { failJob, getJob, getJobForHarness } from "@omniralph/db";
import { JobFailure, MAX_JOB_DELIVERIES, type JobOutcomeResponse } from "@omniralph/shared";
import { badRequest, readJson } from "@/lib/harness-auth/request";
import { requireHarness } from "@/lib/harness-auth/verify";
import {
  jobIdParam,
  notCurrentHarness,
  notFound,
  type JobRouteContext,
} from "@/lib/harness-api/jobs";
import { getDb } from "@/lib/db";
import { syncJobsDue } from "@/lib/dispatch/due";
import { organizationDefinitions } from "@/lib/definitions";
import { jobHooks } from "@/lib/sinks";

/** Delay before a retryable failure may be claimed again, when the harness doesn't name one. */
const DEFAULT_RETRY_AFTER_SECONDS = 60;

/**
 * Records a failed delivery. Non-retryable failures, and any failure on the
 * last allowed delivery, fail the job. Otherwise the job is queued again,
 * claimable after `retryAfterSeconds`, and the response is `retry`.
 * The job's hooks (`jobHooks`: its task's sink, or its type's outcome handler
 * for a legacy job: `onFailed`, `onCanceled`, `onRetry`) then
 * updates the job type's state, e.g. a review's final failure fails the
 * review and posts a failure note.
 */
export async function POST(req: Request, ctx: JobRouteContext): Promise<Response> {
  const principal = await requireHarness(req);
  if (principal instanceof Response) return principal;
  const jobId = await jobIdParam(ctx);
  if (!jobId) return notFound();
  const body = JobFailure.safeParse(await readJson(req));
  if (!body.success) return badRequest();

  const db = getDb();
  if (!(await getJobForHarness(db, jobId, principal.harnessId))) return notFound();
  const retryAfterSeconds = body.data.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS;
  const outcome = await failJob(db, {
    jobId,
    harnessId: principal.harnessId,
    retryable: body.data.retryable,
    error: body.data.error ?? null,
    maxDeliveries: MAX_JOB_DELIVERIES,
    retryAfterSeconds,
  });
  const job = outcome.status === "not_found" ? null : await getJob(db, jobId);
  // A retry is due at its `available_at`; a failed or canceled job leaves the due set.
  if (job && outcome.status !== "conflict") await syncJobsDue([job]);
  const handler = job && (await jobHooks(job, organizationDefinitions(db, job.organizationId)));
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
      return notCurrentHarness();
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
