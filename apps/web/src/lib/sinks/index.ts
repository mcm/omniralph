import "server-only";
import type { Database, Job } from "@omniralph/db";
import { QueryRunResult, type JobSkipReason } from "@omniralph/shared";
import { SINK_KINDS, type SinkKind, type TaskType } from "@omniralph/tasks";
import type { z } from "zod";
import { jobOutcomeHandler, type JobOutcomeHandler } from "@/lib/jobs/handlers";
import { getPlaybookTask, type PlaybookSource } from "@/lib/playbooks";
import { advanceLoop, loopJobRole, sinkMayLoop, type LoopJobFinish } from "@/lib/runs/loop";
import { chatThreadSink } from "./chat-thread";
import { findingThreadSink } from "./finding-thread";
import { learnedRuleSink } from "./learned-rule";
import { ralphRunSink } from "./ralph-run";
import { reviewSink } from "./review";
import { runResultSink } from "./run-result";
import { stickyCommentSink } from "./sticky-comment";
import { triageSink } from "./triage";

/**
 * Sinks: control-panel code, keyed by kind, that applies a run's output (a
 * task definition names its sink). They replace the per-type outcome
 * handlers of `lib/jobs/handlers.ts` for run-spec jobs (jobs with a
 * `task_id`); legacy jobs keep those.
 */

/** A query run's result as a sink sees it: `structured` parsed with the sink's `outputSchema`. */
export type SinkResult<Output> = Omit<QueryRunResult, "structured"> & { structured: Output | null };

/**
 * A sink for query runs applies a `SinkResult<Output>`; a sink for another
 * task type (`review`) parses its own run result (`parseResult`) and applies a
 * `Result`.
 */
export interface Sink<Output = unknown, Result = SinkResult<Output>> {
  kind: SinkKind;
  /** The task type whose runs it applies; a task definition naming the sink must have it. */
  taskType: TaskType;
  /**
   * Takes any query result, structured or not (checking it in `parseResult`),
   * instead of the kind `outputSchema` says.
   */
  anyOutput?: boolean;
  /**
   * The structured part (`structured`) of a `QueryRunResult` the sink accepts
   * from an answered run; null for a sink that takes the Markdown `answer`.
   */
  outputSchema: z.ZodType<Output> | null;
  /**
   * Parses a run result that isn't a `QueryRunResult` (a review task's), or
   * one the sink checks itself (`run-result`); null when the sink rejects it.
   * Replaces `parseSinkResult` for the sink.
   */
  parseResult?(result: unknown): Result | null;
  /**
   * After a delivery started. `skip` ends the claim without running it (the
   * hook has already recorded why); the claim then moves on to the next job.
   */
  onStarted?(
    db: Database,
    job: Job,
    agentId: string,
  ): Promise<{ skip: false } | { skip: true; reason: JobSkipReason }>;
  /** Applies a completed run's result. Called again for a replayed result, so it must be idempotent. */
  apply(db: Database, job: Job, result: Result): Promise<unknown>;
  /** The run failed for good; `error` is null when the agent reported none. */
  onFailed?(db: Database, job: Job, error: string | null): Promise<unknown>;
  /** A retryable failure: the run waits for a redelivery. */
  onRetry?(db: Database, job: Job, error: string | null): Promise<unknown>;
  /** The run was canceled before it finished (by a person, a revocation or a claim). */
  onCanceled?(db: Database, job: Job): Promise<unknown>;
}

/** Erases a sink's output type for the registry (`sinkResult` checks it at runtime). */
function registered<Output, Result>(sink: Sink<Output, Result>): Sink {
  return sink as unknown as Sink;
}

const SINKS = new Map<SinkKind, Sink>(
  [
    registered(learnedRuleSink),
    registered(findingThreadSink),
    registered(chatThreadSink),
    registered(triageSink),
    registered(reviewSink),
    registered(runResultSink),
    registered(stickyCommentSink),
    registered(ralphRunSink),
  ].map((sink) => [sink.kind, sink]),
);

/** Every implemented sink, in `SINK_KINDS` order. */
export function allSinks(): Sink[] {
  return SINK_KINDS.flatMap((kind) => SINKS.get(kind) ?? []);
}

/** The sink of `kind`, or undefined while none is implemented. */
export function sinkFor(kind: SinkKind): Sink | undefined {
  return SINKS.get(kind);
}

/**
 * A result the sink accepts: a `QueryRunResult` whose answered output is the
 * kind the sink takes (structured output matching `outputSchema`, or a
 * Markdown answer for a sink without one); null otherwise.
 */
export function parseSinkResult<Output>(
  sink: Sink<Output>,
  result: unknown,
): SinkResult<Output> | null {
  const parsed = QueryRunResult.safeParse(result);
  if (!parsed.success) return null;
  const run = parsed.data;
  if (run.outcome !== "answered") return { ...run, structured: null };
  if (sink.outputSchema === null) return run.answer === null ? null : { ...run, structured: null };
  if (run.structured === null || run.structured === undefined) return null;
  const output = sink.outputSchema.safeParse(run.structured);
  return output.success ? { ...run, structured: output.data } : null;
}

/** The sink of a run-spec job's task; undefined for a legacy job, an unknown task or a sink not implemented yet. */
export async function taskSink(
  job: Pick<Job, "taskId">,
  definitions: PlaybookSource,
): Promise<Sink | undefined> {
  if (job.taskId === null) return undefined;
  const task = await getPlaybookTask(definitions, job.taskId);
  return task ? sinkFor(task.sink) : undefined;
}

/** The lifecycle hooks the job routes call: an outcome handler without its payload schema. */
export type JobHooks = Omit<JobOutcomeHandler, "payload">;

/** A run's result as `sink` accepts it (its `parseResult`, else `parseSinkResult`); null when it rejects it. */
function sinkResult(sink: Sink, result: unknown): unknown {
  return sink.parseResult ? sink.parseResult(result) : parseSinkResult(sink, result);
}

/**
 * A sink as lifecycle hooks: results are validated with `sinkResult` and
 * applied on completion. For a sink whose runs may be loop jobs
 * (`sinkMayLoop`), a finished job that belongs to a looped run's iteration
 * also advances its loop (`advanceLoop`): a worker's after the sink applied
 * it, a verifier's instead of the sink (the driver reads its verdict).
 */
function sinkHooks(sink: Sink): JobHooks {
  const loops = sinkMayLoop(sink.kind);
  /** Runs the sink's hook unless the job is a loop's verifier, then advances its loop. */
  async function withLoop(
    db: Database,
    job: Job,
    finish: LoopJobFinish,
    apply: (() => Promise<unknown>) | undefined,
  ): Promise<unknown> {
    const role = loops ? await loopJobRole(db, job.id) : null;
    if (role === "verifier") return advanceLoop(db, job, finish);
    const applied = await apply?.();
    if (role === "worker") await advanceLoop(db, job, finish);
    return applied;
  }
  return {
    ...(sink.onStarted && { onStarted: sink.onStarted.bind(sink) }),
    isValidResult: (result) => sinkResult(sink, result) !== null,
    onCompleted: (db, job) =>
      withLoop(db, job, { status: "completed" }, () => {
        const result = sinkResult(sink, job.result);
        if (result === null)
          throw new Error(`Job ${job.id} completed with a result its ${sink.kind} sink rejects`);
        return sink.apply(db, job, result as SinkResult<unknown>);
      }),
    ...((sink.onFailed || loops) && {
      onFailed: (db: Database, job: Job, error: string | null) =>
        withLoop(
          db,
          job,
          { status: "failed", error },
          sink.onFailed && (() => sink.onFailed!(db, job, error)),
        ),
    }),
    ...(sink.onRetry && { onRetry: sink.onRetry.bind(sink) }),
    ...((sink.onCanceled || loops) && {
      onCanceled: (db: Database, job: Job) =>
        withLoop(
          db,
          job,
          { status: "canceled" },
          sink.onCanceled && (() => sink.onCanceled!(db, job)),
        ),
    }),
  };
}

/**
 * The hooks of `job` in the job lifecycle (claim, result, fail, revocation,
 * expiry, cancel): its task's sink for a run-spec job (one with a
 * `task_id`), the legacy `jobOutcomeHandler` otherwise; undefined when it has
 * neither.
 */
export async function jobHooks(
  job: Pick<Job, "type" | "payload" | "taskId">,
  definitions: PlaybookSource,
): Promise<JobHooks | undefined> {
  if (job.taskId !== null) {
    const sink = await taskSink(job, definitions);
    return sink && sinkHooks(sink);
  }
  return jobOutcomeHandler(job);
}
