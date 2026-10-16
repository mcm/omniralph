import "server-only";
import { listJobDueStates, skipJob, type Database, type JobDueState } from "@omniralph/db";
import type { ChainableCommander } from "ioredis";
import {
  getRedis,
  hotStateEnabled,
  readHotState,
  registerHotStateRebuilder,
  writeHotState,
} from "@/lib/hot-state";
import "@/lib/hot-state/rebuilders";

/**
 * The claim's due set: one Redis sorted set per organization (`job-due:{organizationId}`)
 * scoring each `queued` or `running` job by when it can next be claimed (ms): a queued
 * job at its `available_at`, a running one when its lease lapses. The claim long-poll
 * only queries Postgres while its organization has an entry due (`hasDueJob`).
 *
 * Writers update it after their Postgres commit (`syncJobsDue`, `renewJobsDue`). An
 * entry left behind (e.g. by a rebuild racing a writer) only costs a Postgres claim:
 * one that finds nothing re-checks the due entries against Postgres (`reconcileDueJobs`).
 */

const KEY_PREFIX = "job-due:";
/** Most due entries `reconcileDueJobs` re-checks at a time. */
const RECONCILE_LIMIT = 100;

export function jobDueKey(organizationId: string): string {
  return `${KEY_PREFIX}${organizationId}`;
}

/** When the job can next be claimed (ms), or null once it's finished. */
function dueAt(job: Pick<JobDueState, "status" | "availableAt" | "leaseExpiresAt">): number | null {
  if (job.status === "queued") return job.availableAt.getTime();
  if (job.status === "running") return job.leaseExpiresAt?.getTime() ?? 0;
  return null;
}

/** Runs a MULTI, rejecting when any of its commands failed. */
async function exec(multi: ChainableCommander): Promise<void> {
  const results = await multi.exec();
  const failed = results?.find(([error]) => error);
  if (failed) throw failed[0];
}

/** Queues `job`'s entry: its due time (`XX`: only if it's still there), or its removal. */
function queueSync(multi: ChainableCommander, job: JobDueState, onlyExisting: boolean): void {
  const key = jobDueKey(job.organizationId);
  const at = dueAt(job);
  if (at === null) multi.zrem(key, job.id);
  else if (onlyExisting) multi.zadd(key, "XX", at, job.id);
  else multi.zadd(key, at, job.id);
}

/**
 * Records the jobs' current state in the due set; call after the Postgres commit that
 * changed it (dispatch, retry, claim, cancel, skip, expire, revoke, finish).
 */
export async function syncJobsDue(jobs: readonly JobDueState[]): Promise<void> {
  if (jobs.length === 0) return;
  await writeHotState(async (redis) => {
    const multi = redis.multi();
    for (const job of jobs) queueSync(multi, job, false);
    await exec(multi);
  });
}

/** Removes finished jobs from the due set; call after the Postgres commit. */
export async function removeJobsDue(
  jobs: readonly Pick<JobDueState, "id" | "organizationId">[],
): Promise<void> {
  if (jobs.length === 0) return;
  await writeHotState(async (redis) => {
    const multi = redis.multi();
    for (const job of jobs) multi.zrem(jobDueKey(job.organizationId), job.id);
    await exec(multi);
  });
}

/** `skipJob`, then removes the job from the due set. */
export async function skipJobAndClearDue(
  db: Database,
  job: Pick<JobDueState, "id" | "organizationId">,
  input: { reason: string; now?: Date },
): Promise<boolean> {
  const skipped = await skipJob(db, job.id, input);
  if (skipped) await removeJobsDue([job]);
  return skipped;
}

/** Re-reads the jobs from Postgres and records their state; for writers that don't have the row. */
export async function syncJobsDueFromPostgres(
  db: Database,
  jobIds: readonly string[],
): Promise<void> {
  if (jobIds.length === 0 || !hotStateEnabled()) return;
  await syncJobsDue(await listJobDueStates(db, jobIds));
}

/**
 * Moves renewed leases' entries to their new expiry; call after `renewJobLeases`. `XX`:
 * a job that finished meanwhile isn't added back.
 */
export async function renewJobsDue(
  organizationId: string,
  jobIds: readonly string[],
  leaseExpiresAt: Date,
): Promise<void> {
  if (jobIds.length === 0) return;
  await writeHotState(async (redis) => {
    const multi = redis.multi();
    for (const id of jobIds) {
      multi.zadd(jobDueKey(organizationId), "XX", leaseExpiresAt.getTime(), id);
    }
    await exec(multi);
  });
}

/**
 * Whether the organization has a job due at `now` (queued and available, or running
 * with a lapsed lease), so a claim may find one in Postgres. True whenever the due set
 * can't be trusted (hot state off, a rebuild elsewhere, Redis down): the claim then
 * queries Postgres as it did without Redis.
 */
export async function hasDueJob(
  db: Database,
  organizationId: string,
  now: number = Date.now(),
): Promise<boolean> {
  return readHotState(
    db,
    async (redis) => (await redis.zcount(jobDueKey(organizationId), "-inf", now)) > 0,
    async () => true,
  );
}

/**
 * Re-checks the organization's due entries against Postgres and corrects them; call when
 * a claim found nothing, so an entry left behind doesn't keep the claim querying
 * Postgres. Due jobs the claim can't take (another pool, a busy harness) stay due.
 */
export async function reconcileDueJobs(
  db: Database,
  organizationId: string,
  now: number = Date.now(),
): Promise<void> {
  if (!hotStateEnabled()) return;
  try {
    const redis = getRedis();
    const key = jobDueKey(organizationId);
    const ids = await redis.zrangebyscore(key, "-inf", now, "LIMIT", 0, RECONCILE_LIMIT);
    if (ids.length === 0) return;
    const states = new Map((await listJobDueStates(db, ids)).map((job) => [job.id, job]));
    const multi = redis.multi();
    for (const id of ids) {
      const job = states.get(id);
      // Unknown or finished: gone. Otherwise `XX`, so a job finished meanwhile isn't re-added.
      if (job) queueSync(multi, job, true);
      else multi.zrem(key, id);
    }
    await exec(multi);
  } catch (error) {
    console.warn("hot-state: reconciling the job due set failed", error);
  }
}

// Deletes every due set first, then reads Postgres: a writer committing after the read
// writes its entry after the delete, so no change is lost (an entry the read still saw
// as active is corrected by `reconcileDueJobs`).
registerHotStateRebuilder("job-due", async (redis, db) => {
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", `${KEY_PREFIX}*`, "COUNT", 500);
    if (keys.length > 0) await redis.del(...keys);
    cursor = next;
  } while (cursor !== "0");
  const multi = redis.multi();
  for (const job of await listJobDueStates(db)) queueSync(multi, job, false);
  await exec(multi);
});
