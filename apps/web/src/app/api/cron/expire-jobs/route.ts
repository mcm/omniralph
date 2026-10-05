import { expireQueuedJobs, getJob } from "@omniralph/db";
import { JOB_RETENTION_SECONDS } from "@omniralph/shared";
import { cronUnauthorized, isCronRequest } from "@/lib/cron";
import { getDb } from "@/lib/db";
import { isReviewJob, onReviewJobFailed } from "@/lib/review/jobs";

/**
 * Vercel Cron (`vercel.json`): marks jobs still `queued` after the queue's 24h
 * message retention as `expired`; their messages are gone, so no agent will
 * ever start them. Their reviews fail with a note on the PR/MR.
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
    if (job && isReviewJob(job)) {
      await onReviewJobFailed(db, job, "No agent picked up the review within 24 hours").catch(
        (error: unknown) => console.error("failed to record expired review", jobId, error),
      );
    }
  }
  return Response.json({ expired: expired.length });
}
