import "server-only";
import {
  getHarnessOverview,
  listQueuedJobsTargetingHarness,
  markHarnessDeleted,
  revokeHarness as revokeHarnessRow,
  writeHarnessAudit,
  type Database,
  type Job,
} from "@omniralph/db";
import { skipJobAndClearDue, syncJobsDue } from "@/lib/dispatch/due";
import { MAX_JOB_DELIVERIES } from "@omniralph/shared";
import { getDb } from "@/lib/db";
import { cacheHarnessRevoked } from "./auth-state";
import { getDispatcher, type JobDispatcher } from "@/lib/dispatch";
import { organizationDefinitions } from "@/lib/definitions";
import { jobHooks, type JobHooks } from "@/lib/sinks";

const REVOKED = "Harness revoked";

/**
 * Revokes a harness (Harnesses page): sets `revoked_at`, revokes every refresh-token
 * family, fails its running jobs as retryable, removes its pins and writes a
 * `revoke` audit row. Unexpired access and job tokens are rejected from the next
 * request on, because `requireHarness`/`requireJob` check the harness's auth state
 * (written to Redis here, after the Postgres commit).
 *
 * Requeued untargeted jobs are claimed by other harnesses. Queued jobs only the
 * revoked harness may claim (`target_harness_id`) are redispatched: `repo.sync` jobs
 * are skipped, the rest go wherever the repo's remaining pins send them. Returns false for
 * unknown harnesses (with `organizationId`, also for another organization's).
 */
export async function revokeHarness(
  harnessId: string,
  options: {
    revokedBy?: string | null;
    ip?: string | null;
    /** Only revoke a harness of this organization. */
    organizationId?: string;
    db?: Database;
    dispatcher?: JobDispatcher;
  } = {},
): Promise<boolean> {
  const db = options.db ?? getDb();
  const revoked = await revokeHarnessRow(db, harnessId, {
    maxDeliveries: MAX_JOB_DELIVERIES,
    organizationId: options.organizationId,
  });
  if (!revoked) return false;
  await cacheHarnessRevoked(harnessId);
  // Requeued jobs are due again at once; failed and canceled ones leave the due set.
  await syncJobsDue([...revoked.requeuedJobs, ...revoked.failedJobs, ...revoked.canceledJobs]);
  await writeHarnessAudit(db, {
    harnessId,
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

  await forEachJob(db, revoked.requeuedJobs, (h, job) => h.onRetry?.(db, job, REVOKED));
  await forEachJob(db, revoked.canceledJobs, (h, job) => h.onCanceled?.(db, job));
  await forEachJob(db, revoked.failedJobs, (h, job) => h.onFailed?.(db, job, REVOKED));

  const dispatcher = options.dispatcher ?? getDispatcher();
  for (const job of await listQueuedJobsTargetingHarness(db, harnessId)) {
    try {
      if (job.taskType === "system") {
        await skipJobAndClearDue(db, job, { reason: REVOKED });
      } else {
        await dispatcher.republish(job.id);
      }
    } catch (error) {
      console.error(`Failed to redispatch job ${job.id} of revoked agent ${harnessId}`, error);
    }
  }
  return true;
}

/**
 * Deletes a harness of the organization (Harnesses page): revokes it first unless
 * it already is (see `revokeHarness`), then soft-deletes it so it's hidden from
 * the Harnesses pages, and writes a `delete` audit row. Returns false for unknown,
 * already deleted and other organizations' harnesses.
 */
export async function deleteHarness(
  harnessId: string,
  options: {
    organizationId: string;
    deletedBy?: string | null;
    ip?: string | null;
    db?: Database;
    dispatcher?: JobDispatcher;
  },
): Promise<boolean> {
  const db = options.db ?? getDb();
  const agent = await getHarnessOverview(db, options.organizationId, harnessId);
  if (!agent) return false;
  if (
    !agent.revokedAt &&
    !(await revokeHarness(harnessId, {
      revokedBy: options.deletedBy,
      ip: options.ip,
      organizationId: options.organizationId,
      db,
      dispatcher: options.dispatcher,
    }))
  ) {
    return false;
  }
  if (!(await markHarnessDeleted(db, options.organizationId, harnessId))) return false;
  await writeHarnessAudit(db, {
    harnessId,
    event: "delete",
    ip: options.ip ?? null,
    detail: { deletedBy: options.deletedBy ?? null },
  });
  return true;
}

/** Runs an outcome hook per job that has a handler; a failing hook or hook lookup (e.g. a code-host call or a DB read) doesn't stop the rest. */
async function forEachJob(
  db: Database,
  jobs: Job[],
  hook: (handler: JobHooks, job: Job) => Promise<unknown> | undefined,
): Promise<void> {
  for (const job of jobs) {
    try {
      const handler = await jobHooks(job, organizationDefinitions(db, job.organizationId));
      if (!handler) continue;
      await hook(handler, job);
    } catch (error) {
      console.error(`Job outcome hook failed for job ${job.id}`, error);
    }
  }
}
