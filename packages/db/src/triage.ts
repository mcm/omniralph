/**
 * Triage runs: a Linear issue triaged in one Linear agent session. The control
 * panel looks runs up by session (replies) and by issue (the label trigger),
 * and records the `triage.run` job whose outcome it applies next.
 */
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Database } from "./client.js";
import { triageRuns, type TriageLastResult } from "./schema.js";

export type TriageRun = typeof triageRuns.$inferSelect;
export type TriageRunStatus = TriageRun["status"];
export type TriageRunTrigger = TriageRun["trigger"];

/** A transaction, as handed to `db.transaction`'s callback. */
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** The queries below run on the pool or inside a transaction. */
type Executor = Database | Transaction;

/** Runs that haven't finished; at most one per issue. */
export const ACTIVE_TRIAGE_RUN_STATUSES = [
  "queued",
  "running",
] as const satisfies TriageRunStatus[];

export interface NewTriageRunInput {
  organizationId: string;
  linearIssueId: string;
  linearAgentSessionId: string;
  trigger: TriageRunTrigger;
}

/**
 * Creates a `queued` run, unless the agent session already has a run or the
 * issue already has an unfinished one: then that run is returned with
 * `created: false`.
 */
export async function createTriageRun(
  db: Executor,
  input: NewTriageRunInput,
): Promise<{ run: TriageRun; created: boolean }> {
  // A conflicting run can finish between the insert and the lookup; then insert again.
  for (let attempt = 0; attempt < 3; attempt++) {
    const [row] = await db.insert(triageRuns).values(input).onConflictDoNothing().returning();
    if (row) return { run: row, created: true };

    const existing =
      (await getTriageRunBySession(db, input.linearAgentSessionId)) ??
      (await getActiveTriageRun(db, input.organizationId, input.linearIssueId));
    if (existing) return { run: existing, created: false };
  }
  throw new Error(`Failed to create a triage run for Linear issue ${input.linearIssueId}`);
}

export async function getTriageRun(db: Executor, id: string): Promise<TriageRun | null> {
  const [row] = await db.select().from(triageRuns).where(eq(triageRuns.id, id)).limit(1);
  return row ?? null;
}

/** The triage run of a Linear agent session, or null. */
export async function getTriageRunBySession(
  db: Executor,
  linearAgentSessionId: string,
): Promise<TriageRun | null> {
  const [row] = await db
    .select()
    .from(triageRuns)
    .where(eq(triageRuns.linearAgentSessionId, linearAgentSessionId))
    .limit(1);
  return row ?? null;
}

/** The organization's unfinished triage run of a Linear issue, or null. */
export async function getActiveTriageRun(
  db: Executor,
  organizationId: string,
  linearIssueId: string,
): Promise<TriageRun | null> {
  const [row] = await db
    .select()
    .from(triageRuns)
    .where(
      and(
        eq(triageRuns.organizationId, organizationId),
        eq(triageRuns.linearIssueId, linearIssueId),
        inArray(triageRuns.status, ACTIVE_TRIAGE_RUN_STATUSES),
      ),
    )
    .orderBy(desc(triageRuns.createdAt), desc(triageRuns.id))
    .limit(1);
  return row ?? null;
}

/**
 * Sets the `triage.run` job whose outcome the run applies next (null once
 * applied). Returns null if the run is gone.
 */
export async function setTriageRunJob(
  db: Executor,
  runId: string,
  jobId: string | null,
): Promise<TriageRun | null> {
  const [row] = await db
    .update(triageRuns)
    .set({ currentJobId: jobId, updatedAt: new Date() })
    .where(eq(triageRuns.id, runId))
    .returning();
  return row ?? null;
}

/**
 * Sets the run's status and, when given, its last result (`undefined` keeps
 * it, null clears it). Returns null if the run is gone.
 */
export async function setTriageRunStatus(
  db: Executor,
  runId: string,
  status: TriageRunStatus,
  lastResult?: TriageLastResult | null,
): Promise<TriageRun | null> {
  const [row] = await db
    .update(triageRuns)
    .set({
      status,
      ...(lastResult !== undefined ? { lastResult } : {}),
      updatedAt: new Date(),
    })
    .where(eq(triageRuns.id, runId))
    .returning();
  return row ?? null;
}

/**
 * Moves the unfinished run to `running` when `jobId` is its current job, or
 * when it has none yet (the job can start before its enqueuer records it):
 * then `jobId` becomes its current job. Returns null (and changes nothing)
 * otherwise: the run moved on to another job, or is over.
 */
export async function startTriageRunJob(
  db: Executor,
  runId: string,
  jobId: string,
): Promise<TriageRun | null> {
  const [row] = await db
    .update(triageRuns)
    .set({ status: "running", currentJobId: jobId, updatedAt: new Date() })
    .where(
      and(
        eq(triageRuns.id, runId),
        or(eq(triageRuns.currentJobId, jobId), isNull(triageRuns.currentJobId)),
        inArray(triageRuns.status, ACTIVE_TRIAGE_RUN_STATUSES),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Finishes the run with `status` (and, when given, its last result) when
 * `jobId` is its current job and it is still queued or running. Returns null
 * (and changes nothing) otherwise, so a job's outcome is applied once: a
 * replayed result finds the run finished already.
 */
export async function finishTriageRunJob(
  db: Executor,
  runId: string,
  jobId: string,
  status: Exclude<TriageRunStatus, (typeof ACTIVE_TRIAGE_RUN_STATUSES)[number]>,
  lastResult?: TriageLastResult | null,
): Promise<TriageRun | null> {
  const [row] = await db
    .update(triageRuns)
    .set({
      status,
      ...(lastResult !== undefined ? { lastResult } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(triageRuns.id, runId),
        eq(triageRuns.currentJobId, jobId),
        inArray(triageRuns.status, ACTIVE_TRIAGE_RUN_STATUSES),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Sets the run's Linear agent session (a run created before its session, as
 * the label trigger does, holds a placeholder until then). Returns null if
 * the run is gone.
 */
export async function setTriageRunSession(
  db: Executor,
  runId: string,
  linearAgentSessionId: string,
): Promise<TriageRun | null> {
  const [row] = await db
    .update(triageRuns)
    .set({ linearAgentSessionId, updatedAt: new Date() })
    .where(eq(triageRuns.id, runId))
    .returning();
  return row ?? null;
}

/** What `replyToTriageRun` / `takeTriageRunPendingReply` did. */
export type TriageRunReplyResult =
  /** The run is queued or running: the reply waits for its next job. */
  | { status: "pending"; run: TriageRun }
  /** The run is queued again (no current job yet), to triage with `reply`. */
  | { status: "requeued"; run: TriageRun; reply: string }
  /** Another run of the issue is queued or running: nothing changed. */
  | { status: "conflict"; other: TriageRun | null }
  /** Nothing to triage with (no reply given or pending), or the run is gone. */
  | { status: "none" };

const isActiveStatus = (status: TriageRunStatus) =>
  (ACTIVE_TRIAGE_RUN_STATUSES as readonly string[]).includes(status);

const joinReplies = (...replies: (string | null | undefined)[]) =>
  replies
    .map((r) => r?.trim())
    .filter(Boolean)
    .join("\n\n");

/**
 * Takes a reply in the run's session, under the run's lock: while the run is
 * queued or running the reply is stored (after any earlier pending one) for
 * the next job; otherwise the run is queued again (its current job cleared,
 * its pending replies taken) and the combined reply returned, unless another
 * run of the issue is unfinished.
 */
export async function replyToTriageRun(
  db: Database,
  runId: string,
  reply: string,
): Promise<TriageRunReplyResult> {
  return requeueTriageRun(db, runId, reply);
}

/**
 * Queues the run again with its pending replies once its job is over (as
 * `replyToTriageRun` does for a new reply). `none` when it has none, or is
 * still queued or running.
 */
export async function takeTriageRunPendingReply(
  db: Database,
  runId: string,
): Promise<TriageRunReplyResult> {
  return requeueTriageRun(db, runId, null);
}

async function requeueTriageRun(
  db: Database,
  runId: string,
  reply: string | null,
): Promise<TriageRunReplyResult> {
  try {
    return await db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(triageRuns)
        .where(eq(triageRuns.id, runId))
        .for("update");
      if (!run) return { status: "none" } as const;
      if (isActiveStatus(run.status)) {
        if (reply === null || !reply.trim()) return { status: "none" } as const;
        const [row] = await tx
          .update(triageRuns)
          .set({ pendingReply: joinReplies(run.pendingReply, reply), updatedAt: new Date() })
          .where(eq(triageRuns.id, runId))
          .returning();
        return { status: "pending", run: row! } as const;
      }
      const combined = joinReplies(run.pendingReply, reply);
      if (!combined) return { status: "none" } as const;
      const other = await getActiveTriageRun(tx, run.organizationId, run.linearIssueId);
      if (other) return { status: "conflict", other } as const;
      const [row] = await tx
        .update(triageRuns)
        .set({ status: "queued", currentJobId: null, pendingReply: null, updatedAt: new Date() })
        .where(eq(triageRuns.id, runId))
        .returning();
      return { status: "requeued", run: row!, reply: combined } as const;
    });
  } catch (error) {
    // Another run of the issue became active meanwhile (`triage_runs_issue_active_uq`).
    if (isUniqueViolation(error)) {
      const run = await getTriageRun(db, runId);
      const other = run && (await getActiveTriageRun(db, run.organizationId, run.linearIssueId));
      return { status: "conflict", other: other ?? null };
    }
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  for (let e = error; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

/**
 * Stops a queued or running run (Linear's Stop signal): it becomes `stopped`
 * and its pending replies are dropped. Returns the run as it was before, or
 * null when it wasn't queued or running.
 */
export async function stopTriageRun(db: Database, runId: string): Promise<TriageRun | null> {
  return db.transaction(async (tx) => {
    const [run] = await tx.select().from(triageRuns).where(eq(triageRuns.id, runId)).for("update");
    if (!run || !isActiveStatus(run.status)) return null;
    await tx
      .update(triageRuns)
      .set({ status: "stopped", pendingReply: null, updatedAt: new Date() })
      .where(eq(triageRuns.id, runId));
    return run;
  });
}
