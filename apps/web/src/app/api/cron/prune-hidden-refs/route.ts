import { cronUnauthorized, isCronRequest } from "@/lib/cron";
import { getDb } from "@/lib/db";
import { getDispatcher } from "@/lib/dispatch";
import { pruneHiddenRefs } from "@/lib/ralph/hidden-refs";

/**
 * Vercel Cron (`vercel.json`, daily): enqueues the deletion of runs' hidden
 * refs (`refs/omniralph/runs/<run>`) on the code host once their run
 * completed or failed (the fallback when that deletion was missed), or once
 * they're older than 14 days and their run isn't running (stopped or stuck
 * runs). A harness deletes them with git (`worktree.cleanup`).
 */
export async function GET(req: Request): Promise<Response> {
  if (!isCronRequest(req)) return cronUnauthorized();
  const counts = await pruneHiddenRefs({ db: getDb(), dispatcher: getDispatcher() });
  return Response.json(counts);
}
