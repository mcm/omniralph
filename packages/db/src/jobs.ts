/**
 * Job state and the job queue itself: agents claim `queued` jobs (`claimJob`).
 * Lifecycle: `queued` → `running` (claim, per delivery) → `completed` |
 * `failed` | `canceled`, or back to `queued` on a retryable failure; `queued`
 * jobs older than the retention become `expired`.
 * See `docs/adr/0006-postgres-job-queue.md`.
 */
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { harnessVersionAtLeast, isJobTaskType } from "@omniralph/shared";
import type { Database } from "./client.js";
import { effectiveHostToolPath } from "./host-tools.js";
import {
  chatThreadRuns,
  harnessHostTools,
  harnessRepoPins,
  harnesses,
  hostTools,
  jobs,
  type HarnessUpdateState,
  type JobTaskType,
} from "./schema.js";

export type Job = typeof jobs.$inferSelect;
export type JobStatus = Job["status"];

/**
 * How long a claimed job's lease lasts; the agent's heartbeat renews it.
 * Mirrors `JOB_LEASE_SECONDS` in `@omniralph/shared` (which this package doesn't depend on).
 */
export const JOB_LEASE_SECONDS = 120;

const secondsAfter = (now: Date, seconds: number) => new Date(now.getTime() + seconds * 1000);

export interface NewJobInput {
  /** Only this organization's agents receive the job (its repository's / run's organization). */
  organizationId: string;
  type: string;
  /** How the harness runs the job (`legacyJobRouting(type)` for legacy job types). */
  taskType: JobTaskType;
  /** The pool whose slots the job takes; null exactly for `system` jobs. */
  pool: string | null;
  /** The task definition the job runs; null for legacy jobs. */
  taskId?: string | null;
  /** Only harnesses reporting at least this version claim the job. */
  minHarnessVersion?: string | null;
  /** Only harnesses reporting every one of these installables claim the job. */
  requiredInstallables?: readonly string[];
  /** Only harnesses with an effective path for every one of these host tools claim the job. */
  requiredHostTools?: readonly string[];
  payload?: Record<string, unknown>;
  repositoryId?: string | null;
  /** At most one queued/running job per key; a second insert returns the active job. */
  dedupeKey?: string | null;
  /** The ralph run a `ralph.*` job belongs to. */
  ralphRunId?: string | null;
  /** Only this agent may claim the job; null: any agent of the organization. */
  targetHarnessId?: string | null;
}

/**
 * Inserts a `queued` job, unless a queued or running job with the same
 * `dedupeKey` exists: then that job is returned with `created: false`.
 */
export async function insertJob(
  db: Database,
  input: NewJobInput,
): Promise<{ job: Job; created: boolean }> {
  // A conflicting job can finish between the insert and the lookup; then insert again.
  for (let attempt = 0; attempt < 3; attempt++) {
    const [row] = await db
      .insert(jobs)
      .values({
        organizationId: input.organizationId,
        type: input.type,
        taskType: input.taskType,
        pool: input.pool,
        taskId: input.taskId ?? null,
        minHarnessVersion: input.minHarnessVersion ?? null,
        requiredInstallables: [...(input.requiredInstallables ?? [])],
        requiredHostTools: [...(input.requiredHostTools ?? [])],
        payload: input.payload ?? {},
        repositoryId: input.repositoryId ?? null,
        dedupeKey: input.dedupeKey ?? null,
        ralphRunId: input.ralphRunId ?? null,
        targetHarnessId: input.targetHarnessId ?? null,
      })
      .onConflictDoNothing({
        target: jobs.dedupeKey,
        where: sql`status in ('queued', 'running')`,
      })
      .returning();
    if (row) return { job: row, created: true };

    const [active] = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.dedupeKey, input.dedupeKey!), inArray(jobs.status, ["queued", "running"])))
      .limit(1);
    if (active) return { job: active, created: false };
  }
  throw new Error(`Failed to insert job with dedupe key ${input.dedupeKey}`);
}

/**
 * Sets which agent may claim a `queued` job (null: any agent of its
 * organization). False if the job isn't queued.
 */
export async function setQueuedJobTarget(
  db: Database,
  jobId: string,
  targetHarnessId: string | null,
): Promise<boolean> {
  const rows = await db
    .update(jobs)
    .set({ targetHarnessId })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, "queued")))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

export async function getJob(db: Database, jobId: string): Promise<Job | null> {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  return row ?? null;
}

/**
 * A job as seen by an agent: null when it doesn't exist or belongs to another
 * organization than the agent's (agents never act on other organizations' jobs).
 */
export async function getJobForHarness(
  db: Database,
  jobId: string,
  harnessId: string,
): Promise<Job | null> {
  const [row] = await db
    .select({ job: jobs })
    .from(jobs)
    .innerJoin(harnesses, eq(harnesses.organizationId, jobs.organizationId))
    .where(and(eq(jobs.id, jobId), eq(harnesses.id, harnessId)))
    .limit(1);
  return row?.job ?? null;
}

/**
 * The agent to send a pinned repo's jobs to: among its pinned, non-revoked
 * agents, the one with the fewest active jobs (then the most recent
 * heartbeat). Null when the repo isn't pinned (any agent of the organization
 * may serve it). Only agents of `organizationId` count. `lastHeartbeats`
 * supplies heartbeats more recent than `last_heartbeat_at` (the control
 * panel's Redis), used where later than the row's.
 */
export async function pinnedHarnessFor(
  db: Database,
  organizationId: string,
  repositoryId: string,
  options: {
    lastHeartbeats?: (harnessIds: string[]) => Promise<ReadonlyMap<string, Date>>;
  } = {},
): Promise<string | null> {
  const active = db
    .select({ harnessId: jobs.harnessId, n: count().as("n") })
    .from(jobs)
    .where(inArray(jobs.status, ["queued", "running"]))
    .groupBy(jobs.harnessId)
    .as("active");
  const rows = await db
    .select({
      harnessId: harnesses.id,
      activeJobs: sql<number>`coalesce(${active.n}, 0)`.mapWith(Number),
      lastHeartbeatAt: harnesses.lastHeartbeatAt,
    })
    .from(harnessRepoPins)
    .innerJoin(harnesses, eq(harnesses.id, harnessRepoPins.harnessId))
    .leftJoin(active, eq(active.harnessId, harnesses.id))
    .where(
      and(
        eq(harnessRepoPins.repositoryId, repositoryId),
        eq(harnesses.organizationId, organizationId),
        isNull(harnesses.revokedAt),
      ),
    )
    .orderBy(
      asc(sql`coalesce(${active.n}, 0)`),
      sql`${harnesses.lastHeartbeatAt} desc nulls last`,
      asc(harnesses.id),
    );
  if (!options.lastHeartbeats || rows.length < 2) return rows[0]?.harnessId ?? null;
  const live = await options.lastHeartbeats(rows.map((r) => r.harnessId));
  const seen = (row: (typeof rows)[number]) =>
    Math.max(row.lastHeartbeatAt?.getTime() ?? 0, live.get(row.harnessId)?.getTime() ?? 0);
  // Stable: equal heartbeats keep the query's ID order.
  const [best] = [...rows].sort((a, b) => a.activeJobs - b.activeJobs || seen(b) - seen(a));
  return best!.harnessId;
}

export type CancelJobResult = "canceled" | "cancel_requested" | "not_cancelable" | "not_found";

/**
 * Requests cancellation: sets `cancel_requested`. A queued job is canceled
 * right away (start then skips it); a running one is stopped by its agent,
 * which learns about it from its next heartbeat response.
 */
export async function requestJobCancel(
  db: Database,
  jobId: string,
  now: Date = new Date(),
): Promise<CancelJobResult> {
  const [queued] = await db
    .update(jobs)
    .set({ cancelRequested: true, status: "canceled", finishedAt: now })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, "queued")))
    .returning({ id: jobs.id });
  if (queued) return "canceled";
  const [running] = await db
    .update(jobs)
    .set({ cancelRequested: true })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, "running")))
    .returning({ id: jobs.id });
  if (running) return "cancel_requested";
  return (await getJob(db, jobId)) ? "not_cancelable" : "not_found";
}

/** A candidate the claim settled instead of running; the caller runs its outcome handler. */
export interface SettledJob {
  /** `canceled`: cancellation was requested; `failed`: it reached `maxDeliveries`. */
  outcome: "canceled" | "failed";
  job: Job;
}

export interface ClaimJobResult {
  /** The claimed job, or null when nothing is claimable. */
  claim: { action: "run"; job: Job } | null;
  settled: SettledJob[];
}

/**
 * Claims the next job for a harness from the `jobs` table, in one transaction.
 * Eligible: the harness's organization's jobs whose task type is in
 * `acceptedTaskTypes` and whose pool is in `pools` (the pools it has a free
 * slot in), plus `system` jobs (always accepted, no pool); whose
 * `min_harness_version` is null or at most `harnessVersion`
 * (`harnessVersionAtLeast`; none when the harness reported no version);
 * whose `required_installables` are all in the harness's
 * `reported_installables` and whose `required_host_tools` all have an
 * `effectiveHostToolPath` on it (`harness_host_tools`);
 * targeted at this harness or at none; that are `queued` with
 * `available_at <= now` or `running` with a lapsed lease (the previous
 * harness's results are then rejected). Jobs targeted at this harness come
 * first, then the oldest. The claim sets `running`, the harness, `started_at`
 * and the lease and increments `delivery_count`. A cancel-requested candidate
 * is canceled and one at `maxDeliveries` is failed; both are returned in
 * `settled` and the claim moves on to the next candidate. `beforeClaim` runs
 * on the job about to be claimed (e.g. to sign its job token): if it throws,
 * the whole transaction rolls back and no delivery is used up; if it returns
 * `{ fail }` (the job can never run, e.g. its run spec can't be resolved), the
 * job is failed with that error, added to `settled`, and the claim moves on.
 */
export async function claimJob(
  db: Database,
  input: {
    harnessId: string;
    organizationId: string;
    acceptedTaskTypes: readonly string[];
    pools: readonly string[];
    /** The harness's reported version; null when it reported none. */
    harnessVersion: string | null;
    maxDeliveries: number;
    leaseSeconds?: number;
    now?: Date;
    beforeClaim?: (job: Job) => Promise<void | { fail: string }>;
  },
): Promise<ClaimJobResult> {
  const now = input.now ?? new Date();
  const settled: SettledJob[] = [];
  const eligible = await claimCandidates(db, { ...input, now });
  return db.transaction(async (tx): Promise<ClaimJobResult> => {
    for (;;) {
      const [job] = await tx
        .select()
        .from(jobs)
        .where(eligible)
        // Targeted jobs (`target_harness_id is null` false) first.
        .orderBy(sql`${jobs.targetHarnessId} is null`, asc(jobs.createdAt), asc(jobs.id))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!job) return { claim: null, settled };

      if (job.cancelRequested) {
        const [canceled] = await tx
          .update(jobs)
          .set({ status: "canceled", leaseExpiresAt: null, finishedAt: now })
          .where(eq(jobs.id, job.id))
          .returning();
        settled.push({ outcome: "canceled", job: canceled! });
        continue;
      }
      if (job.deliveryCount >= input.maxDeliveries) {
        const [failed] = await tx
          .update(jobs)
          .set({
            status: "failed",
            error: `Gave up after ${job.deliveryCount} deliveries`,
            leaseExpiresAt: null,
            finishedAt: now,
          })
          .where(eq(jobs.id, job.id))
          .returning();
        settled.push({ outcome: "failed", job: failed! });
        continue;
      }
      const before = await input.beforeClaim?.(job);
      if (before) {
        const [failed] = await tx
          .update(jobs)
          .set({ status: "failed", error: before.fail, leaseExpiresAt: null, finishedAt: now })
          .where(eq(jobs.id, job.id))
          .returning();
        settled.push({ outcome: "failed", job: failed! });
        continue;
      }
      const [claimed] = await tx
        .update(jobs)
        .set({
          status: "running",
          harnessId: input.harnessId,
          deliveryCount: sql`${jobs.deliveryCount} + 1`,
          startedAt: now,
          leaseExpiresAt: secondsAfter(now, input.leaseSeconds ?? JOB_LEASE_SECONDS),
        })
        .where(eq(jobs.id, job.id))
        .returning();
      return { claim: { action: "run", job: claimed! }, settled };
    }
  });
}

/** Who is claiming: the inputs `claimJob` and `hasClaimableJob` select candidates by. */
export interface ClaimCandidatesInput {
  harnessId: string;
  organizationId: string;
  acceptedTaskTypes: readonly string[];
  pools: readonly string[];
  /** The harness's reported version; null when it reported none. */
  harnessVersion: string | null;
}

/**
 * The `jobs` condition of the candidates `claimJob` would claim at `now` (see
 * there for the rules), shared with `hasClaimableJob` so the two can't drift.
 */
async function claimCandidates(
  db: Database,
  input: ClaimCandidatesInput & { now: Date },
): Promise<SQL | undefined> {
  const { now } = input;
  const pooledTaskTypes = input.acceptedTaskTypes
    .filter(isJobTaskType)
    .filter((t) => t !== "system");
  const claimable = and(
    eq(jobs.organizationId, input.organizationId),
    or(
      eq(jobs.taskType, "system"),
      pooledTaskTypes.length > 0 && input.pools.length > 0
        ? and(inArray(jobs.taskType, pooledTaskTypes), inArray(jobs.pool, [...input.pools]))
        : sql`false`,
    ),
    or(isNull(jobs.targetHarnessId), eq(jobs.targetHarnessId, input.harnessId)),
    or(
      and(eq(jobs.status, "queued"), lte(jobs.availableAt, now)),
      and(eq(jobs.status, "running"), lt(jobs.leaseExpiresAt, now)),
    ),
  );
  // The minimum versions among the candidates this harness meets (semver isn't SQL-comparable).
  const minimums = await db
    .selectDistinct({ version: jobs.minHarnessVersion })
    .from(jobs)
    .where(and(claimable, sql`${jobs.minHarnessVersion} is not null`));
  const harnessVersion = input.harnessVersion;
  const metMinimums = minimums
    .map((m) => m.version!)
    .filter((minimum) => harnessVersion !== null && harnessVersionAtLeast(harnessVersion, minimum));
  const { installables, hostTools: tools } = await harnessCapabilities(db, input);
  return and(
    claimable,
    metMinimums.length > 0
      ? or(isNull(jobs.minHarnessVersion), inArray(jobs.minHarnessVersion, metMinimums))
      : isNull(jobs.minHarnessVersion),
    sql`${jobs.requiredInstallables} <@ ${textArray(installables)}`,
    sql`${jobs.requiredHostTools} <@ ${textArray(tools)}`,
  );
}

/**
 * Whether `claimJob` would find a candidate for the harness right now (the
 * heartbeat's `claimable`): same conditions, no lock, no claim. A candidate it
 * would settle (cancel-requested, out of deliveries) counts too: the claim
 * that follows settles it.
 */
export async function hasClaimableJob(
  db: Database,
  input: ClaimCandidatesInput & { now?: Date },
): Promise<boolean> {
  const eligible = await claimCandidates(db, { ...input, now: input.now ?? new Date() });
  const [job] = await db.select({ id: jobs.id }).from(jobs).where(eligible).limit(1);
  return job !== undefined;
}

/**
 * The installables a harness reported and the host tools it has an effective
 * path for, by name: what jobs' `required_installables` and
 * `required_host_tools` are checked against.
 */
async function harnessCapabilities(
  db: Database,
  input: { harnessId: string; organizationId: string },
): Promise<{ installables: string[]; hostTools: string[] }> {
  const [harness] = await db
    .select({ installables: harnesses.reportedInstallables })
    .from(harnesses)
    .where(
      and(eq(harnesses.id, input.harnessId), eq(harnesses.organizationId, input.organizationId)),
    )
    .limit(1);
  const tools = await db
    .select({
      name: hostTools.name,
      configuredPath: harnessHostTools.configuredPath,
      configuredPathExists: harnessHostTools.configuredPathExists,
      discoveredPath: harnessHostTools.discoveredPath,
    })
    .from(harnessHostTools)
    .innerJoin(hostTools, eq(hostTools.id, harnessHostTools.hostToolId))
    .where(
      and(
        eq(harnessHostTools.harnessId, input.harnessId),
        eq(hostTools.organizationId, input.organizationId),
      ),
    );
  return {
    installables: (harness?.installables ?? []).map((installable) => installable.name),
    hostTools: tools
      .filter((tool) => effectiveHostToolPath(tool) !== null)
      .map((tool) => tool.name),
  };
}

/** `values` as a SQL `text[]`. */
function textArray(values: readonly string[]) {
  return values.length > 0
    ? sql`array[${sql.join(
        values.map((value) => sql`${value}`),
        sql`, `,
      )}]::text[]`
    : sql`'{}'::text[]`;
}

/** What the claim's due set (Redis hot state) keeps of a job: when it can next be claimed. */
export type JobDueState = Pick<
  Job,
  "id" | "organizationId" | "status" | "createdAt" | "availableAt" | "leaseExpiresAt"
>;

/**
 * The due state of the jobs with the given IDs (unknown IDs are left out), or of
 * every `queued` and `running` job when `jobIds` is omitted.
 */
export async function listJobDueStates(
  db: Database,
  jobIds?: readonly string[],
): Promise<JobDueState[]> {
  if (jobIds?.length === 0) return [];
  return db
    .select({
      id: jobs.id,
      organizationId: jobs.organizationId,
      status: jobs.status,
      createdAt: jobs.createdAt,
      availableAt: jobs.availableAt,
      leaseExpiresAt: jobs.leaseExpiresAt,
    })
    .from(jobs)
    .where(jobIds ? inArray(jobs.id, [...jobIds]) : inArray(jobs.status, ["queued", "running"]));
}

/**
 * Extends the lease of the given jobs that are `running` on `harnessId` (others
 * are left alone). Returns the IDs whose lease was renewed.
 */
export async function renewJobLeases(
  db: Database,
  harnessId: string,
  jobIds: readonly string[],
  now: Date = new Date(),
  leaseSeconds: number = JOB_LEASE_SECONDS,
): Promise<string[]> {
  if (jobIds.length === 0) return [];
  const rows = await db
    .update(jobs)
    .set({ leaseExpiresAt: secondsAfter(now, leaseSeconds) })
    .where(
      and(inArray(jobs.id, [...jobIds]), eq(jobs.status, "running"), eq(jobs.harnessId, harnessId)),
    )
    .returning({ id: jobs.id });
  return rows.map((r) => r.id);
}

export type FinishJobResult =
  | { status: "completed" | "failed" | "canceled" }
  | { status: "retry" }
  /** The job isn't running on this agent (any more). */
  | { status: "conflict" }
  | { status: "not_found" };

/** Locks a job that must be `running` on `harnessId`; returns why not otherwise. */
async function lockRunningJob(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  jobId: string,
  harnessId: string,
): Promise<{ job: Job } | { rejected: FinishJobResult }> {
  const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for("update");
  if (!job) return { rejected: { status: "not_found" } };
  if (job.status !== "running" || job.harnessId !== harnessId) {
    return { rejected: { status: "conflict" } };
  }
  return { job };
}

/**
 * Stores an agent's result. Only the job's current agent may report it;
 * a job canceled while running ends `canceled` (its result is kept).
 */
export async function completeJob(
  db: Database,
  input: { jobId: string; harnessId: string; result: Record<string, unknown>; now?: Date },
): Promise<FinishJobResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx): Promise<FinishJobResult> => {
    const locked = await lockRunningJob(tx, input.jobId, input.harnessId);
    if ("rejected" in locked) return locked.rejected;
    const status = locked.job.cancelRequested ? "canceled" : "completed";
    await tx
      .update(jobs)
      .set({ status, result: input.result, error: null, finishedAt: now })
      .where(eq(jobs.id, input.jobId));
    return { status };
  });
}

/**
 * Records a failed delivery. Non-retryable failures, and retryable ones on the
 * `maxDeliveries`-th delivery, fail the job; other retryable failures put it
 * back to `queued`, claimable again after `retryAfterSeconds`. A job canceled while running
 * ends `canceled`. Only the job's current agent may report it.
 */
export async function failJob(
  db: Database,
  input: {
    jobId: string;
    harnessId: string;
    retryable: boolean;
    error?: string | null;
    maxDeliveries: number;
    /** How long a retried job waits before it may be claimed again (default 0). */
    retryAfterSeconds?: number;
    now?: Date;
  },
): Promise<FinishJobResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx): Promise<FinishJobResult> => {
    const locked = await lockRunningJob(tx, input.jobId, input.harnessId);
    if ("rejected" in locked) return locked.rejected;
    const { job } = locked;
    const error = input.error ?? null;
    if (job.cancelRequested) {
      await tx
        .update(jobs)
        .set({ status: "canceled", error, finishedAt: now })
        .where(eq(jobs.id, job.id));
      return { status: "canceled" };
    }
    if (!input.retryable || job.deliveryCount >= input.maxDeliveries) {
      await tx
        .update(jobs)
        .set({ status: "failed", error, finishedAt: now })
        .where(eq(jobs.id, job.id));
      return { status: "failed" };
    }
    await tx
      .update(jobs)
      .set({
        status: "queued",
        harnessId: null,
        error,
        availableAt: secondsAfter(now, input.retryAfterSeconds ?? 0),
        leaseExpiresAt: null,
      })
      .where(eq(jobs.id, job.id));
    return { status: "retry" };
  });
}

/**
 * Marks a queued or running job `skipped` (there was nothing to do). Returns
 * false when the job had already finished.
 */
export async function skipJob(
  db: Database,
  jobId: string,
  input: { reason: string; now?: Date },
): Promise<boolean> {
  const rows = await db
    .update(jobs)
    .set({ status: "skipped", error: input.reason, finishedAt: input.now ?? new Date() })
    .where(and(eq(jobs.id, jobId), inArray(jobs.status, ["queued", "running"])))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

/**
 * Marks a `completed` job `failed` with `error`: its result was well-formed
 * but couldn't be used (e.g. a triage the control panel rejects). Returns
 * false when the job isn't `completed`.
 */
export async function failCompletedJob(
  db: Database,
  jobId: string,
  error: string,
): Promise<boolean> {
  const rows = await db
    .update(jobs)
    .set({ status: "failed", error })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, "completed")))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

/**
 * Queued or running jobs whose dedupe key starts with `prefix`, e.g. every
 * active review job of one PR (`review.run:<repositoryId>:<prNumber>:`).
 */
export async function listActiveJobsByDedupePrefix(db: Database, prefix: string): Promise<Job[]> {
  const pattern = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return db
    .select()
    .from(jobs)
    .where(and(sql`${jobs.dedupeKey} like ${pattern}`, inArray(jobs.status, ["queued", "running"])))
    .orderBy(asc(jobs.createdAt));
}

/**
 * The organization's latest completed job of `type` mapped to chat thread
 * `chatThreadId` as a query run (`chat_thread_runs`), e.g. a thread's last
 * answered code question. Null when there is none.
 */
export async function latestCompletedChatThreadJob(
  db: Database,
  input: { organizationId: string; type: string; chatThreadId: string },
): Promise<Job | null> {
  const [row] = await db
    .select({ job: jobs })
    .from(chatThreadRuns)
    .innerJoin(jobs, eq(jobs.id, chatThreadRuns.jobId))
    .where(
      and(
        eq(chatThreadRuns.organizationId, input.organizationId),
        eq(chatThreadRuns.chatThreadId, input.chatThreadId),
        eq(chatThreadRuns.kind, "query"),
        eq(jobs.organizationId, input.organizationId),
        eq(jobs.type, input.type),
        eq(jobs.status, "completed"),
      ),
    )
    .orderBy(sql`${jobs.finishedAt} desc nulls last`, desc(jobs.createdAt))
    .limit(1);
  return row?.job ?? null;
}

/** Marks jobs still `queued` that were created before `createdBefore` as `expired`. */
export async function expireQueuedJobs(
  db: Database,
  createdBefore: Date,
  now: Date = new Date(),
): Promise<string[]> {
  const rows = await db
    .update(jobs)
    .set({ status: "expired", finishedAt: now })
    .where(and(eq(jobs.status, "queued"), lt(jobs.createdAt, createdBefore)))
    .returning({ id: jobs.id });
  return rows.map((r) => r.id);
}

/** Records a heartbeat and returns the agent's (central) configuration row. */
export async function recordHarnessHeartbeat(
  db: Database,
  harnessId: string,
  input: {
    version: string;
    /** Self-update reporting; older agents send none, which clears it. */
    selfUpdate?: "supported" | "unsupported";
    update?: HarnessUpdateState;
    failedVersions?: string[];
    /** The update request the agent acted on: cleared when it's still the pending one. */
    handledUpdateRequestId?: string | null;
    /** The installables installed on the harness; replaces the last report (none clears it). */
    installables?: { name: string; version: string }[];
    /** The Claude models the harness can run; replaces the last report (none clears it). */
    models?: { value: string; displayName: string }[];
    now?: Date;
  },
): Promise<typeof harnesses.$inferSelect | null> {
  const handled = input.handledUpdateRequestId ?? null;
  const clearIfHandled = (column: AnyPgColumn) =>
    sql`case when ${harnesses.updateRequestId} = ${handled}::uuid then null else ${column} end`;
  const [row] = await db
    .update(harnesses)
    .set({
      reportedVersion: input.version,
      selfUpdate: input.selfUpdate ?? null,
      updateState: input.update ?? null,
      failedVersions: input.failedVersions ?? [],
      reportedInstallables: input.installables ?? [],
      reportedModels: input.models ?? [],
      ...(handled !== null && {
        updateRequestId: clearIfHandled(harnesses.updateRequestId),
        updateRequestVersion: clearIfHandled(harnesses.updateRequestVersion),
        updateRequestedAt: clearIfHandled(harnesses.updateRequestedAt),
      }),
      lastHeartbeatAt: input.now ?? new Date(),
    })
    .where(eq(harnesses.id, harnessId))
    .returning();
  return row ?? null;
}

export async function getHarness(
  db: Database,
  harnessId: string,
): Promise<typeof harnesses.$inferSelect | null> {
  const [row] = await db.select().from(harnesses).where(eq(harnesses.id, harnessId)).limit(1);
  return row ?? null;
}

export async function listHarnessPinnedRepositoryIds(
  db: Database,
  harnessId: string,
): Promise<string[]> {
  const rows = await db
    .select({ repositoryId: harnessRepoPins.repositoryId })
    .from(harnessRepoPins)
    .where(eq(harnessRepoPins.harnessId, harnessId))
    .orderBy(asc(harnessRepoPins.createdAt));
  return rows.map((r) => r.repositoryId);
}

/**
 * Splits the jobs an agent reports as running into those it should keep
 * running (`running` on this agent, no cancel requested) and those it must
 * stop (canceled, finished, unknown or taken over by another agent).
 */
export async function classifyHarnessRunningJobs(
  db: Database,
  harnessId: string,
  jobIds: readonly string[],
): Promise<{ keep: Pick<Job, "id" | "type" | "taskType" | "taskId">[]; cancel: string[] }> {
  if (jobIds.length === 0) return { keep: [], cancel: [] };
  const rows = await db
    .select({
      id: jobs.id,
      type: jobs.type,
      taskType: jobs.taskType,
      taskId: jobs.taskId,
      status: jobs.status,
      harnessId: jobs.harnessId,
      cancelRequested: jobs.cancelRequested,
    })
    .from(jobs)
    .where(inArray(jobs.id, [...jobIds]))
    .orderBy(desc(jobs.createdAt));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const keep: Pick<Job, "id" | "type" | "taskType" | "taskId">[] = [];
  const cancel: string[] = [];
  for (const id of new Set(jobIds)) {
    const row = byId.get(id);
    if (row && row.status === "running" && row.harnessId === harnessId && !row.cancelRequested) {
      keep.push({ id, type: row.type, taskType: row.taskType, taskId: row.taskId });
    } else {
      cancel.push(id);
    }
  }
  return { keep, cancel };
}

/**
 * Runs `post` while holding a row lock on the job, unless its comment was
 * already posted (`scm_comment_id` set): concurrent or replayed calls wait for
 * the lock and then see the stored ID, so the comment is posted at most once.
 * `post` returns the posted comment's ID, or null when it posted nothing.
 */
export async function postJobCommentOnce(
  db: Database,
  jobId: string,
  post: (job: Job) => Promise<string | null>,
): Promise<{ posted: boolean }> {
  return db.transaction(async (tx) => {
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for("update");
    if (!job || job.scmCommentId !== null) return { posted: false };
    const commentId = await post(job);
    if (commentId === null) return { posted: false };
    await tx.update(jobs).set({ scmCommentId: commentId }).where(eq(jobs.id, jobId));
    return { posted: true };
  });
}
