/**
 * Job state (Postgres is the source of truth; Vercel Queues only delivers
 * `{ jobId }` messages). Lifecycle: `queued` → `running` (start, per delivery)
 * → `completed` | `failed` | `canceled`, or back to `queued` on a retryable
 * failure; `queued` jobs older than the queue retention become `expired`.
 * See `docs/adr/0001-job-dispatch.md`.
 */
import { and, asc, count, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Database } from "./client.js";
import { agentRepoPins, agents, jobs, type AgentUpdateState } from "./schema.js";

export type Job = typeof jobs.$inferSelect;
export type JobStatus = Job["status"];

export interface NewJobInput {
  /** Only this organization's agents receive the job (its repository's / run's organization). */
  organizationId: string;
  capability: string;
  type: string;
  payload?: Record<string, unknown>;
  repositoryId?: string | null;
  /** At most one queued/running job per key; a second insert returns the active job. */
  dedupeKey?: string | null;
  /** The ralph run a `ralph.*` job belongs to. */
  ralphRunId?: string | null;
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
        capability: input.capability,
        type: input.type,
        payload: input.payload ?? {},
        repositoryId: input.repositoryId ?? null,
        dedupeKey: input.dedupeKey ?? null,
        ralphRunId: input.ralphRunId ?? null,
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

/** Records where a job was published. `topic` stays null until publishing succeeded. */
export async function markJobPublished(
  db: Database,
  jobId: string,
  input: { topic: string; messageId: string | null },
): Promise<void> {
  await db
    .update(jobs)
    .set({ topic: input.topic, queueMessageId: input.messageId })
    .where(eq(jobs.id, jobId));
}

export async function getJob(db: Database, jobId: string): Promise<Job | null> {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  return row ?? null;
}

/**
 * A job as seen by an agent: null when it doesn't exist or belongs to another
 * organization than the agent's (agents never act on other organizations' jobs).
 */
export async function getJobForAgent(
  db: Database,
  jobId: string,
  agentId: string,
): Promise<Job | null> {
  const [row] = await db
    .select({ job: jobs })
    .from(jobs)
    .innerJoin(agents, eq(agents.organizationId, jobs.organizationId))
    .where(and(eq(jobs.id, jobId), eq(agents.id, agentId)))
    .limit(1);
  return row?.job ?? null;
}

/**
 * The agent to send a pinned repo's jobs to: among its pinned, non-revoked
 * agents, the one with the fewest active jobs (then the most recent
 * heartbeat). Null when the repo isn't pinned (any agent of the organization
 * may serve it). Only agents of `organizationId` count.
 */
export async function pinnedAgentFor(
  db: Database,
  organizationId: string,
  repositoryId: string,
): Promise<string | null> {
  const active = db
    .select({ agentId: jobs.agentId, n: count().as("n") })
    .from(jobs)
    .where(inArray(jobs.status, ["queued", "running"]))
    .groupBy(jobs.agentId)
    .as("active");
  const [row] = await db
    .select({ agentId: agents.id })
    .from(agentRepoPins)
    .innerJoin(agents, eq(agents.id, agentRepoPins.agentId))
    .leftJoin(active, eq(active.agentId, agents.id))
    .where(
      and(
        eq(agentRepoPins.repositoryId, repositoryId),
        eq(agents.organizationId, organizationId),
        isNull(agents.revokedAt),
      ),
    )
    .orderBy(
      asc(sql`coalesce(${active.n}, 0)`),
      sql`${agents.lastHeartbeatAt} desc nulls last`,
      asc(agents.id),
    )
    .limit(1);
  return row?.agentId ?? null;
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

export type StartJobResult =
  | { action: "run"; job: Job }
  | {
      action: "skip";
      reason:
        | "not_found"
        | "canceled"
        | "completed"
        | "failed"
        | "expired"
        | "skipped"
        | "max_deliveries"
        | "capability_disabled";
    };

/**
 * Starts a delivery of a job on an agent: atomically sets `running`, the
 * agent and `started_at` and increments `delivery_count`. A job still
 * `running` elsewhere is taken over (the queue only redelivers once the
 * previous agent's lease lapsed); that agent's results are then rejected.
 * Canceled, finished and expired jobs are skipped, as is a delivery beyond
 * `maxDeliveries`, which fails the job.
 */
export async function startJob(
  db: Database,
  input: {
    jobId: string;
    agentId: string;
    /** The agent's organization: a job of another organization is never started. */
    organizationId: string;
    enabledCapabilities: readonly string[];
    maxDeliveries: number;
    now?: Date;
  },
): Promise<StartJobResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx): Promise<StartJobResult> => {
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, input.jobId)).for("update");
    if (!job || job.organizationId !== input.organizationId) {
      return { action: "skip", reason: "not_found" };
    }
    switch (job.status) {
      case "canceled":
      case "completed":
      case "failed":
      case "expired":
      case "skipped":
        return { action: "skip", reason: job.status };
      case "queued":
      case "running":
        break;
    }
    if (job.cancelRequested) {
      await tx.update(jobs).set({ status: "canceled", finishedAt: now }).where(eq(jobs.id, job.id));
      return { action: "skip", reason: "canceled" };
    }
    if (!input.enabledCapabilities.includes(job.capability)) {
      return { action: "skip", reason: "capability_disabled" };
    }
    if (job.deliveryCount >= input.maxDeliveries) {
      await tx
        .update(jobs)
        .set({
          status: "failed",
          error: `Gave up after ${job.deliveryCount} deliveries`,
          finishedAt: now,
        })
        .where(eq(jobs.id, job.id));
      return { action: "skip", reason: "max_deliveries" };
    }
    const [started] = await tx
      .update(jobs)
      .set({
        status: "running",
        agentId: input.agentId,
        deliveryCount: sql`${jobs.deliveryCount} + 1`,
        startedAt: now,
      })
      .where(eq(jobs.id, job.id))
      .returning();
    return { action: "run", job: started! };
  });
}

export type FinishJobResult =
  | { status: "completed" | "failed" | "canceled" }
  | { status: "retry" }
  /** The job isn't running on this agent (any more). */
  | { status: "conflict" }
  | { status: "not_found" };

/** Locks a job that must be `running` on `agentId`; returns why not otherwise. */
async function lockRunningJob(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  jobId: string,
  agentId: string,
): Promise<{ job: Job } | { rejected: FinishJobResult }> {
  const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for("update");
  if (!job) return { rejected: { status: "not_found" } };
  if (job.status !== "running" || job.agentId !== agentId) {
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
  input: { jobId: string; agentId: string; result: Record<string, unknown>; now?: Date },
): Promise<FinishJobResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx): Promise<FinishJobResult> => {
    const locked = await lockRunningJob(tx, input.jobId, input.agentId);
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
 * back to `queued` for the queue to redeliver. A job canceled while running
 * ends `canceled`. Only the job's current agent may report it.
 */
export async function failJob(
  db: Database,
  input: {
    jobId: string;
    agentId: string;
    retryable: boolean;
    error?: string | null;
    maxDeliveries: number;
    now?: Date;
  },
): Promise<FinishJobResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx): Promise<FinishJobResult> => {
    const locked = await lockRunningJob(tx, input.jobId, input.agentId);
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
      .set({ status: "queued", agentId: null, error })
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
export async function recordAgentHeartbeat(
  db: Database,
  agentId: string,
  input: {
    version: string;
    capabilities: string[];
    /** Self-update reporting; older agents send none, which clears it. */
    selfUpdate?: "supported" | "unsupported";
    update?: AgentUpdateState;
    failedVersions?: string[];
    /** The update request the agent acted on: cleared when it's still the pending one. */
    handledUpdateRequestId?: string | null;
    now?: Date;
  },
): Promise<typeof agents.$inferSelect | null> {
  const handled = input.handledUpdateRequestId ?? null;
  const clearIfHandled = (column: AnyPgColumn) =>
    sql`case when ${agents.updateRequestId} = ${handled}::uuid then null else ${column} end`;
  const [row] = await db
    .update(agents)
    .set({
      reportedVersion: input.version,
      reportedCapabilities: input.capabilities,
      selfUpdate: input.selfUpdate ?? null,
      updateState: input.update ?? null,
      failedVersions: input.failedVersions ?? [],
      ...(handled !== null && {
        updateRequestId: clearIfHandled(agents.updateRequestId),
        updateRequestVersion: clearIfHandled(agents.updateRequestVersion),
        updateRequestedAt: clearIfHandled(agents.updateRequestedAt),
      }),
      lastHeartbeatAt: input.now ?? new Date(),
    })
    .where(eq(agents.id, agentId))
    .returning();
  return row ?? null;
}

export async function getAgent(
  db: Database,
  agentId: string,
): Promise<typeof agents.$inferSelect | null> {
  const [row] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  return row ?? null;
}

export async function listAgentPinnedRepositoryIds(
  db: Database,
  agentId: string,
): Promise<string[]> {
  const rows = await db
    .select({ repositoryId: agentRepoPins.repositoryId })
    .from(agentRepoPins)
    .where(eq(agentRepoPins.agentId, agentId))
    .orderBy(asc(agentRepoPins.createdAt));
  return rows.map((r) => r.repositoryId);
}

/**
 * Splits the jobs an agent reports as running into those it should keep
 * running (`running` on this agent, no cancel requested) and those it must
 * stop (canceled, finished, unknown or taken over by another agent).
 */
export async function classifyAgentRunningJobs(
  db: Database,
  agentId: string,
  jobIds: readonly string[],
): Promise<{ keep: Pick<Job, "id" | "capability">[]; cancel: string[] }> {
  if (jobIds.length === 0) return { keep: [], cancel: [] };
  const rows = await db
    .select({
      id: jobs.id,
      capability: jobs.capability,
      status: jobs.status,
      agentId: jobs.agentId,
      cancelRequested: jobs.cancelRequested,
    })
    .from(jobs)
    .where(inArray(jobs.id, [...jobIds]))
    .orderBy(desc(jobs.createdAt));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const keep: Pick<Job, "id" | "capability">[] = [];
  const cancel: string[] = [];
  for (const id of new Set(jobIds)) {
    const row = byId.get(id);
    if (row && row.status === "running" && row.agentId === agentId && !row.cancelRequested) {
      keep.push({ id, capability: row.capability });
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
