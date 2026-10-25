import { expireQueuedJobs, getJob } from "@omniralph/db";
import { JOB_RETENTION_SECONDS } from "@omniralph/shared";
import { cronUnauthorized, isCronRequest } from "@/lib/cron";
import { getDb } from "@/lib/db";
import {
  hasExpiredQueuedJob,
  reconcileExpiredQueuedJobs,
  syncJobsDueFromPostgres,
} from "@/lib/dispatch/due";
import { organizationPlaybooks } from "@/lib/playbooks";
import { jobHooks } from "@/lib/sinks";
import { liveRoute } from "@/lib/live/request";

/**
 * Vercel Cron (`vercel.json`): marks jobs still `queued` 24h after creation
 * (`JOB_RETENTION_SECONDS`) as `expired`, so no agent picks up a stale job.
 * Their outcome handlers hear about the failure (e.g. a
 * review fails with a note on the PR/MR). With Redis, it returns without
 * querying Postgres while no queued job is that old (`hasExpiredQueuedJob`).
 */
async function get(req: Request): Promise<Response> {
  if (!isCronRequest(req)) return cronUnauthorized();
  const now = new Date();
  const db = getDb();
  const createdBefore = new Date(now.getTime() - JOB_RETENTION_SECONDS * 1000);
  if (!(await hasExpiredQueuedJob(db, createdBefore))) return Response.json({ expired: 0 });
  const expired = await expireQueuedJobs(db, createdBefore, now);
  await syncJobsDueFromPostgres(db, expired);
  await reconcileExpiredQueuedJobs(db, createdBefore);
  for (const jobId of expired) {
    try {
      const job = await getJob(db, jobId);
      const handler = job && (await jobHooks(job, organizationPlaybooks(db, job.organizationId)));
      if (job && handler?.onFailed) {
        await handler.onFailed(db, job, "No agent picked up the job within 24 hours");
      }
    } catch (error) {
      console.error("failed to record expired job", jobId, error);
    }
  }
  return Response.json({ expired: expired.length });
}

export const GET = liveRoute(get);
