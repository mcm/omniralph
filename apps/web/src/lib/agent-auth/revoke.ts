import "server-only";
import {
  listQueuedJobsOnAgentTopics,
  revokeAgent as revokeAgentRow,
  skipJob,
  writeAgentAudit,
  type Database,
  type Job,
} from "@omniralph/db";
import { MAX_JOB_DELIVERIES, SYSTEM_CAPABILITY } from "@omniralph/shared";
import { getDb } from "@/lib/db";
import { getDispatcher, type JobDispatcher } from "@/lib/dispatch";
import {
  isReviewJob,
  onReviewJobCanceled,
  onReviewJobFailed,
  onReviewJobRetry,
} from "@/lib/review/jobs";

const REVOKED = "Agent revoked";

/**
 * Revokes an agent (Agents page): sets `revoked_at`, revokes every refresh-token
 * family, fails its running jobs as retryable, removes its pins and writes a
 * `revoke` audit row. Unexpired access and job tokens are rejected from the next
 * request on, because `requireAgent`/`requireJob` check the agent row.
 *
 * Requeued jobs on the shared topics are redelivered to other agents once the
 * revoked agent's lease lapses. Jobs published to the agent's own topics (which
 * nobody else reads) are published again: `repo.sync` jobs are skipped, the
 * rest go wherever the repo's remaining pins send them. Returns false for
 * unknown agents.
 */
export async function revokeAgent(
  agentId: string,
  options: {
    revokedBy?: string | null;
    ip?: string | null;
    db?: Database;
    dispatcher?: JobDispatcher;
  } = {},
): Promise<boolean> {
  const db = options.db ?? getDb();
  const revoked = await revokeAgentRow(db, agentId, { maxDeliveries: MAX_JOB_DELIVERIES });
  if (!revoked) return false;
  await writeAgentAudit(db, {
    agentId,
    event: "revoke",
    ip: options.ip ?? null,
    detail: {
      revokedBy: options.revokedBy ?? null,
      requeuedJobIds: revoked.requeuedJobs.map((j) => j.id),
      failedJobIds: revoked.failedJobs.map((j) => j.id),
      canceledJobIds: revoked.canceledJobs.map((j) => j.id),
      unpinnedRepositoryIds: revoked.unpinnedRepositoryIds,
    },
  });

  await forEachReviewJob(revoked.requeuedJobs, (job) => onReviewJobRetry(db, job, REVOKED));
  await forEachReviewJob(revoked.canceledJobs, (job) => onReviewJobCanceled(db, job));
  await forEachReviewJob(revoked.failedJobs, (job) => onReviewJobFailed(db, job, REVOKED));

  const dispatcher = options.dispatcher ?? getDispatcher();
  for (const job of await listQueuedJobsOnAgentTopics(db, agentId)) {
    try {
      if (job.capability === SYSTEM_CAPABILITY) {
        await skipJob(db, job.id, { reason: REVOKED });
      } else {
        await dispatcher.republish(job.id);
      }
    } catch (error) {
      console.error(`Failed to redispatch job ${job.id} of revoked agent ${agentId}`, error);
    }
  }
  return true;
}

/** Runs a review hook per review job; a failing hook (e.g. a code-host call) doesn't stop the rest. */
async function forEachReviewJob(jobs: Job[], hook: (job: Job) => Promise<void>): Promise<void> {
  for (const job of jobs) {
    if (!isReviewJob(job)) continue;
    try {
      await hook(job);
    } catch (error) {
      console.error(`Review hook failed for job ${job.id}`, error);
    }
  }
}
