/**
 * Run iterations: the worker-then-verifier passes of a looped query or review
 * run (`run_iterations`), which the control panel's loop driver
 * (`apps/web/src/lib/runs/loop.ts`) starts and advances. Every write records a
 * live `run` change for the iteration's run, so its run page updates.
 */
import { and, asc, eq, or } from "drizzle-orm";
import { recordChange } from "./changes.js";
import type { Database } from "./client.js";
import {
  runIterations,
  type LoopRunKind,
  type RunIterationMetric,
  type RunIterationStatus,
  type RunIterationVerdict,
  type RunLoopOutcome,
} from "./schema.js";

export type RunIteration = typeof runIterations.$inferSelect;

/** A transaction, as handed to `db.transaction`'s callback. */
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** The queries below run on the pool or inside a transaction. */
type Executor = Database | Transaction;

/** The run a loop iterates. */
export interface LoopRunRef {
  kind: LoopRunKind;
  id: string;
  organizationId: string;
}

export interface NewRunIterationInput {
  run: LoopRunRef;
  number: number;
  feedback: string | null;
  maxIterations: number;
  stallRounds: number;
}

/**
 * Inserts the run's iteration `number` (`working`), or returns null when the
 * run already has one with that number (a replayed outcome started it).
 */
export async function insertRunIteration(
  db: Executor,
  input: NewRunIterationInput,
): Promise<RunIteration | null> {
  const [row] = await db
    .insert(runIterations)
    .values({
      organizationId: input.run.organizationId,
      runKind: input.run.kind,
      runId: input.run.id,
      number: input.number,
      feedback: input.feedback,
      maxIterations: input.maxIterations,
      stallRounds: input.stallRounds,
    })
    .onConflictDoNothing()
    .returning();
  if (row) recordIterationChange(db, row);
  return row ?? null;
}

/** What an iteration's driver may change. */
export interface RunIterationUpdate {
  status?: RunIterationStatus;
  workerJobId?: string | null;
  verifierJobId?: string | null;
  verdict?: RunIterationVerdict | null;
  metric?: RunIterationMetric | null;
  summary?: string | null;
  findings?: string[];
  error?: string | null;
  outcome?: RunLoopOutcome | null;
  verifyingAt?: Date | null;
  finishedAt?: Date | null;
}

/**
 * Updates an iteration; with `fromStatus`, only while it still has that
 * status (so a replayed outcome doesn't advance it twice). Returns the
 * updated row, or null when nothing matched.
 */
export async function updateRunIteration(
  db: Executor,
  id: string,
  update: RunIterationUpdate,
  fromStatus?: RunIterationStatus,
): Promise<RunIteration | null> {
  const [row] = await db
    .update(runIterations)
    .set(update)
    .where(
      fromStatus === undefined
        ? eq(runIterations.id, id)
        : and(eq(runIterations.id, id), eq(runIterations.status, fromStatus)),
    )
    .returning();
  if (row) recordIterationChange(db, row);
  return row ?? null;
}

/** The run's iterations, first first. */
export async function listRunIterations(
  db: Executor,
  run: Pick<LoopRunRef, "kind" | "id">,
): Promise<RunIteration[]> {
  return db
    .select()
    .from(runIterations)
    .where(and(eq(runIterations.runKind, run.kind), eq(runIterations.runId, run.id)))
    .orderBy(asc(runIterations.number));
}

/**
 * The iteration whose worker or verifier `jobId` is, locked for the rest of
 * the transaction when `lock` is set (`SELECT … FOR UPDATE`); null for a job
 * that isn't part of a loop.
 */
export async function getRunIterationByJob(
  db: Executor,
  jobId: string,
  options: { lock?: boolean } = {},
): Promise<RunIteration | null> {
  const query = db
    .select()
    .from(runIterations)
    .where(or(eq(runIterations.workerJobId, jobId), eq(runIterations.verifierJobId, jobId)))
    .limit(1);
  const [row] = options.lock ? await query.for("update") : await query;
  return row ?? null;
}

function recordIterationChange(db: Executor, row: RunIteration): void {
  recordChange(db, {
    resource: "run",
    ids: [row.runId],
    runId: row.runId,
    organizationId: row.organizationId,
  });
}
