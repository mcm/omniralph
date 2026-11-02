import "server-only";
import {
  getRunIterationByJob,
  insertRunIteration,
  listRunIterations,
  updateRunIteration,
  type Database,
  type Job,
  type LoopRunKind,
  type LoopRunRef,
  type RalphRoundMetrics,
  type RalphTransaction,
  type RunIteration,
  type RunLoopOutcome,
} from "@omniralph/db";
import { QueryRunResult, RalphStoryMetric } from "@omniralph/shared";
import {
  PLAYBOOK_ROLES,
  playbookLoopSettings,
  type Playbook,
  type PlaybookLoopLimits,
  type PlaybookLoopSettings,
  type SinkKind,
} from "@omniralph/tasks";
import { z } from "zod";
import { addRoundMetric, isStalled } from "@/lib/ralph/rounds";

/**
 * The loop driver of looped query and review runs (ADR 0013): each iteration
 * runs a worker session, then a verifier session (a run of the playbook's
 * `loop.verifierPlaybookId`) that hasn't seen the worker's reasoning; a
 * playbook that names no verifier runs one session. The worker never decides
 * it is done; the verifier does.
 * Its findings become the next iteration's input until it reports
 * convergence, the run used its `maxIterations`, or the metric it reports
 * hasn't beaten its best for `stallRounds` iterations (the coding rounds'
 * `addRoundMetric`/`isStalled`). Every iteration is stored in
 * `run_iterations`, and every change is published live on the run's page.
 *
 * What a worker and a verifier are depends on the kind of run: each kind
 * registers a `LoopAdapter` that starts its jobs and applies the loop's end.
 * The job lifecycle (`lib/sinks`) hands every finished loop job to
 * `advanceLoop`: a worker's after its own sink applied it, a verifier's
 * instead of its `run-result` sink. Coding runs loop by their own story
 * attempts and rounds (`lib/ralph/outcome.ts`), not through this driver.
 */

/** The pool or a transaction: what the driver and its adapters write with. */
export type LoopExecutor = Database | RalphTransaction;

/**
 * What a loop's verifier answers (its query run's structured output): whether
 * the run converged, a summary of the iteration, what the next iteration
 * should address, and optionally a progress metric (e.g. open findings) for
 * stall detection.
 */
export const LoopVerdict = z.object({
  converged: z.boolean(),
  summary: z.string().trim().min(1).max(20_000),
  findings: z.array(z.string().trim().min(1).max(5_000)).max(100).default([]),
  metric: RalphStoryMetric.optional(),
});
export type LoopVerdict = z.infer<typeof LoopVerdict>;

/** How a looped run ended, as its adapter's `finish` gets it. */
export interface LoopEnd {
  outcome: RunLoopOutcome;
  /** Every iteration of the run, first first; the last carries `outcome`. */
  iterations: RunIteration[];
}

/** What a kind of run does in its loop. */
export interface LoopAdapter {
  /**
   * Starts the worker job of `iteration` (its `feedback` is the previous
   * verifier's findings; null for the first) and returns its ID. Called in
   * the driver's transaction; a replayed call should reuse the job (e.g. a
   * dedupe key on the iteration's ID).
   */
  startWorker(db: LoopExecutor, run: LoopRunRef, iteration: RunIteration): Promise<string>;
  /**
   * Starts the verifier job of `iteration`, a run of its `verifierPlaybookId`
   * (the run's playbook's `loop.verifierPlaybookId`) that checks `worker`'s
   * output, and returns its ID.
   */
  startVerifier(
    db: LoopExecutor,
    run: LoopRunRef,
    iteration: RunIteration,
    worker: Job,
  ): Promise<string>;
  /** The loop ended: applies its outcome to the run (e.g. finishes it). */
  finish(db: LoopExecutor, run: LoopRunRef, end: LoopEnd): Promise<void>;
}

const adapters = new Map<LoopRunKind, LoopAdapter>();

/** Registers what a kind of run does in its loop; each kind has one adapter. */
export function registerLoopAdapter(kind: LoopRunKind, adapter: LoopAdapter): void {
  if (adapters.has(kind)) throw new Error(`loop adapter for '${kind}' runs registered twice`);
  adapters.set(kind, adapter);
}

function adapterFor(kind: LoopRunKind): LoopAdapter {
  const adapter = adapters.get(kind);
  if (!adapter) throw new Error(`No loop adapter is registered for ${kind} runs`);
  return adapter;
}

/**
 * Whether runs of a task with `sink` may be loop jobs: the workers of looped
 * query and review roles, and the loop's verifiers. The job lifecycle only
 * looks a job's iteration up for these.
 */
export function sinkMayLoop(sink: SinkKind): boolean {
  return Object.entries(PLAYBOOK_ROLES).some(
    ([name, role]) =>
      role.sink === sink &&
      role.taskType !== "coding" &&
      (role.loop === "looped" || name === "verifier"),
  );
}

/**
 * Starts the loop of a run of `playbook`: its first iteration and worker
 * job, with the playbook's verifier and loop limits (`playbookLoopSettings`).
 * Null for a playbook whose role doesn't loop through the driver (the
 * single-session roles, and coding roles) or that names no verifier: its run
 * is one session. A run whose loop already started gets its first iteration back.
 */
export async function startLoop(
  db: Database,
  run: LoopRunRef,
  playbook: Pick<Playbook, "role" | "loop">,
): Promise<RunIteration | null> {
  const settings = playbookLoopSettings(playbook);
  if (!settings) return null;
  const { verifierPlaybookId, ...limits } = settings;
  if (verifierPlaybookId === null) return null;
  const adapter = adapterFor(run.kind);
  return db.transaction(async (tx) => {
    const iteration = await insertRunIteration(tx, {
      run,
      number: 1,
      feedback: null,
      verifierPlaybookId,
      ...limits,
    });
    if (!iteration) return (await listRunIterations(tx, run))[0]!;
    const workerJobId = await adapter.startWorker(tx, run, iteration);
    return (await updateRunIteration(tx, iteration.id, { workerJobId }))!;
  });
}

/** How a loop job finished. */
export type LoopJobFinish =
  | { status: "completed" }
  | { status: "failed"; error: string | null }
  | { status: "canceled" };

/** Whether `jobId` is a loop's worker or verifier job; null for a job outside any loop. */
export async function loopJobRole(
  db: LoopExecutor,
  jobId: string,
): Promise<"worker" | "verifier" | null> {
  const iteration = await getRunIterationByJob(db, jobId);
  if (!iteration) return null;
  return iteration.verifierJobId === jobId ? "verifier" : "worker";
}

/**
 * Advances the loop `job` belongs to once it finished: a completed worker
 * starts its iteration's verifier; a verifier's verdict ends the loop
 * (`loopOutcome`) or starts the next iteration with its findings as the
 * worker's feedback; a failed or canceled worker or verifier (or a verifier
 * whose answer isn't a `LoopVerdict`) fails the iteration and ends the loop.
 * Idempotent: a replayed outcome finds its iteration already advanced.
 * Returns whether the job was part of a loop.
 */
export async function advanceLoop(
  db: Database,
  job: Job,
  finish: LoopJobFinish,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const iteration = await getRunIterationByJob(tx, job.id, { lock: true });
    if (!iteration) return false;
    const run: LoopRunRef = {
      kind: iteration.runKind,
      id: iteration.runId,
      organizationId: iteration.organizationId,
    };
    const adapter = adapterFor(run.kind);
    if (iteration.workerJobId === job.id && iteration.status === "working") {
      if (finish.status !== "completed") {
        return failIteration(
          tx,
          adapter,
          run,
          iteration,
          "working",
          jobError("worker", finish),
          now,
        );
      }
      const verifierJobId = await adapter.startVerifier(tx, run, iteration, job);
      await updateRunIteration(
        tx,
        iteration.id,
        { status: "verifying", verifierJobId, verifyingAt: now() },
        "working",
      );
      return true;
    }
    if (iteration.verifierJobId === job.id && iteration.status === "verifying") {
      if (finish.status !== "completed") {
        return failIteration(
          tx,
          adapter,
          run,
          iteration,
          "verifying",
          jobError("verifier", finish),
          now,
        );
      }
      const verdict = readLoopVerdict(job.result);
      if (!verdict) {
        return failIteration(
          tx,
          adapter,
          run,
          iteration,
          "verifying",
          "The verifier's answer wasn't a verdict (converged, summary, findings).",
          now,
        );
      }
      await recordVerdict(tx, adapter, run, iteration, verdict, now);
    }
    return true;
  });
}

/** The verdict in a verifier's query run result; null when it didn't answer with one. */
export function readLoopVerdict(result: unknown): LoopVerdict | null {
  const run = QueryRunResult.safeParse(result);
  if (!run.success || run.data.outcome !== "answered") return null;
  const verdict = LoopVerdict.safeParse(run.data.structured);
  return verdict.success ? verdict.data : null;
}

function jobError(
  who: "worker" | "verifier",
  finish: Exclude<LoopJobFinish, { status: "completed" }>,
) {
  if (finish.status === "canceled") return `The ${who} was canceled.`;
  return `The ${who} failed: ${finish.error ?? "unknown error"}`;
}

async function failIteration(
  tx: RalphTransaction,
  adapter: LoopAdapter,
  run: LoopRunRef,
  iteration: RunIteration,
  fromStatus: "working" | "verifying",
  error: string,
  now: () => Date,
): Promise<true> {
  const failed = await updateRunIteration(
    tx,
    iteration.id,
    { status: "failed", error, outcome: "failed", finishedAt: now() },
    fromStatus,
  );
  if (failed)
    await adapter.finish(tx, run, {
      outcome: "failed",
      iterations: await listRunIterations(tx, run),
    });
  return true;
}

async function recordVerdict(
  tx: RalphTransaction,
  adapter: LoopAdapter,
  run: LoopRunRef,
  iteration: RunIteration,
  verdict: LoopVerdict,
  now: () => Date,
): Promise<void> {
  const finishedAt = now();
  const done = await updateRunIteration(
    tx,
    iteration.id,
    {
      status: "done",
      verdict: verdict.converged ? "converged" : "continue",
      summary: verdict.summary,
      findings: verdict.findings,
      metric: verdict.metric ?? null,
      finishedAt,
    },
    "verifying",
  );
  if (!done) return;
  const iterations = await listRunIterations(tx, run);
  const outcome = loopOutcome(iterations, settingsOf(iteration));
  if (outcome) {
    const last = (await updateRunIteration(tx, iteration.id, { outcome }))!;
    await adapter.finish(tx, run, {
      outcome,
      iterations: iterations.map((it) => (it.id === last.id ? last : it)),
    });
    return;
  }
  const next = await insertRunIteration(tx, {
    run,
    number: iteration.number + 1,
    feedback: loopFeedback(verdict),
    ...settingsOf(iteration),
  });
  if (!next) return;
  const workerJobId = await adapter.startWorker(tx, run, next);
  await updateRunIteration(tx, next.id, { workerJobId });
}

/** The loop a run's next iteration keeps: its verifier and limits. */
function settingsOf(
  iteration: RunIteration,
): PlaybookLoopSettings & { verifierPlaybookId: string } {
  return {
    verifierPlaybookId: iteration.verifierPlaybookId,
    maxIterations: iteration.maxIterations,
    stallRounds: iteration.stallRounds,
  };
}

/**
 * Why a loop stops after its last iteration's verdict, or null when it runs
 * another iteration: the verifier reported convergence, the run used
 * `maxIterations`, or the reported metric hasn't beaten its best for
 * `stallRounds` iterations (`isStalled`, as a story's rounds).
 */
export function loopOutcome(
  iterations: readonly Pick<
    RunIteration,
    "number" | "verdict" | "metric" | "createdAt" | "finishedAt"
  >[],
  settings: PlaybookLoopLimits,
): Exclude<RunLoopOutcome, "failed"> | null {
  const last = iterations.at(-1);
  if (!last) return null;
  if (last.verdict === "converged") return "converged";
  if (last.number >= settings.maxIterations) return "max-iterations";
  const metrics = loopMetrics(iterations);
  if (metrics && isStalled(metrics, settings.stallRounds)) return "stalled";
  return null;
}

/** The metric history of a run's iterations (a renamed or reversed metric starts afresh); null without any. */
export function loopMetrics(
  iterations: readonly Pick<RunIteration, "number" | "metric" | "createdAt" | "finishedAt">[],
): RalphRoundMetrics | null {
  return iterations.reduce<RalphRoundMetrics | null>(
    (history, iteration) =>
      iteration.metric
        ? addRoundMetric(
            history,
            iteration.metric,
            iteration.number,
            iteration.finishedAt ?? iteration.createdAt,
          )
        : history,
    null,
  );
}

/** The next iteration's worker input: the verifier's summary and what it sent back. */
export function loopFeedback(verdict: Pick<LoopVerdict, "summary" | "findings">): string {
  const findings = verdict.findings.map((finding) => `- ${finding}`).join("\n");
  return findings ? `${verdict.summary}\n\n${findings}` : verdict.summary;
}
