import { expireQueuedJobs, getJob } from "@omniralph/db";
import { JOB_RETENTION_SECONDS } from "@omniralph/shared";
import { cronUnauthorized, isCronRequest } from "@/lib/cron";
import { getDb } from "@/lib/db";
import { organizationDefinitions } from "@/lib/definitions";
import { jobHooks } from "@/lib/sinks";

/**
 * Vercel Cron (`vercel.json`): marks jobs still `queued` 24h after creation
 * (`JOB_RETENTION_SECONDS`) as `expired`, so no agent picks up a stale job.
 * Their outcome handlers hear about the failure (e.g. a
 * review fails with a note on the PR/MR).
 */
export async function GET(req: Request): Promise<Response> {
  if (!isCronRequest(req)) return cronUnauthorized();
  const now = new Date();
  const db = getDb();
  const expired = await expireQueuedJobs(
    db,
    new Date(now.getTime() - JOB_RETENTION_SECONDS * 1000),
    now,
  );
  for (const jobId of expired) {
    const job = await getJob(db, jobId);
    const handler = job && (await jobHooks(job, organizationDefinitions(db, job.organizationId)));
    if (job && handler?.onFailed) {
      await handler
        .onFailed(db, job, "No agent picked up the job within 24 hours")
        .catch((error: unknown) => console.error("failed to record expired job", jobId, error));
    }
  }
  return Response.json({ expired: expired.length });
}
