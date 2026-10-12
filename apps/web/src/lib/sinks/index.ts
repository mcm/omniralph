import "server-only";
import type { Database, Job } from "@omniralph/db";
import { QueryRunResult, type JobSkipReason } from "@omniralph/shared";
import type { SinkKind } from "@omniralph/tasks";
import type { z } from "zod";
import { jobOutcomeHandler, type JobOutcomeHandler } from "@/lib/jobs/handlers";
import type { DefinitionSource } from "@/lib/definitions";
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
    harnessId: string,
  ): Promise<{ skip: false } | { skip: true; reason: JobSkipReason }>;
  /** Applies a completed run's result. Called again for a replayed result, so it must be idempotent. */
  apply(db: Database, job: Job, result: Result): Promise<unknown>;
  /** The run failed for good; `error` is null when the harness reported none. */
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
  definitions: DefinitionSource,
): Promise<Sink | undefined> {
  if (job.taskId === null) return undefined;
  const task = await definitions.getTask(job.taskId);
  return task ? sinkFor(task.sink) : undefined;
}

/** The lifecycle hooks the job routes call: an outcome handler without its payload schema. */
export type JobHooks = Omit<JobOutcomeHandler, "payload">;

/** A run's result as `sink` accepts it (its `parseResult`, else `parseSinkResult`); null when it rejects it. */
function sinkResult(sink: Sink, result: unknown): unknown {
  return sink.parseResult ? sink.parseResult(result) : parseSinkResult(sink, result);
}

/** A sink as lifecycle hooks: results are validated with `sinkResult` and applied on completion. */
function sinkHooks(sink: Sink): JobHooks {
  return {
    ...(sink.onStarted && { onStarted: sink.onStarted.bind(sink) }),
    isValidResult: (result) => sinkResult(sink, result) !== null,
    async onCompleted(db, job) {
      const result = sinkResult(sink, job.result);
      if (result === null)
        throw new Error(`Job ${job.id} completed with a result its ${sink.kind} sink rejects`);
      return sink.apply(db, job, result as SinkResult<unknown>);
    },
    ...(sink.onFailed && { onFailed: sink.onFailed.bind(sink) }),
    ...(sink.onRetry && { onRetry: sink.onRetry.bind(sink) }),
    ...(sink.onCanceled && { onCanceled: sink.onCanceled.bind(sink) }),
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
  definitions: DefinitionSource,
): Promise<JobHooks | undefined> {
  if (job.taskId !== null) {
    const sink = await taskSink(job, definitions);
    return sink && sinkHooks(sink);
  }
  return jobOutcomeHandler(job);
}
