import { expireQueuedJobs } from "@omniralph/db";
import { JOB_RETENTION_SECONDS } from "@omniralph/shared";
import { cronUnauthorized, isCronRequest } from "@/lib/cron";
import { getDb } from "@/lib/db";

/**
 * Vercel Cron (`vercel.json`): marks jobs still `queued` after the queue's 24h
 * message retention as `expired`; their messages are gone, so no agent will
 * ever start them.
 */
export async function GET(req: Request): Promise<Response> {
  if (!isCronRequest(req)) return cronUnauthorized();
  const now = new Date();
  const expired = await expireQueuedJobs(
    getDb(),
    new Date(now.getTime() - JOB_RETENTION_SECONDS * 1000),
    now,
  );
  return Response.json({ expired: expired.length });
}
