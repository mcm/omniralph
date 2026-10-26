import { RalphCleanupPayload, type RalphCleanupResult, type JobPayload } from "@omniralph/shared";
import type { JobContext } from "../index.js";
import { cleanUpWorktree } from "../../rpc/worktree-cleanup.js";

/**
 * Runs a legacy `ralph.cleanup` job (`cleanUpWorktree`, which the
 * `worktree.cleanup` system RPC runs too). The control panel now enqueues
 * `worktree.cleanup` instead; this stays for jobs queued before that.
 */
export async function runCleanup(job: JobPayload, ctx: JobContext): Promise<RalphCleanupResult> {
  const parsed = RalphCleanupPayload.safeParse(job.payload);
  if (!parsed.success) throw new Error("invalid ralph.cleanup payload");
  return cleanUpWorktree(parsed.data, ctx);
}
