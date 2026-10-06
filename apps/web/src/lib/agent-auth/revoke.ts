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
import { jobOutcomeHandler, type JobOutcomeHandler } from "@/lib/jobs/handlers";

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

  await forEachJob(revoked.requeuedJobs, (h, job) => h.onRetry?.(db, job, REVOKED));
  await forEachJob(revoked.canceledJobs, (h, job) => h.onCanceled?.(db, job));
  await forEachJob(revoked.failedJobs, (h, job) => h.onFailed?.(db, job, REVOKED));

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

/** Runs an outcome hook per job that has a handler; a failing hook (e.g. a code-host call) doesn't stop the rest. */
async function forEachJob(
  jobs: Job[],
  hook: (handler: JobOutcomeHandler, job: Job) => Promise<unknown> | undefined,
): Promise<void> {
  for (const job of jobs) {
    const handler = jobOutcomeHandler(job);
    if (!handler) continue;
    try {
      await hook(handler, job);
    } catch (error) {
      console.error(`Job outcome hook failed for job ${job.id}`, error);
    }
  }
}
