import "server-only";
import {
  applyCorrelation,
  failCorrelation,
  getRepository,
  insertJob,
  pinnedHarnessFor,
  type CorrelationInput,
  type Database,
  type Job,
  type ReviewRun,
  type StartCorrelation,
} from "@omniralph/db";
import {
  CORRELATION_JOB_TYPE,
  CorrelationOutput,
  CorrelationTriggerContext,
  ReviewRunInvoker,
  RunSpecJobPayload,
  type QueryRunResult,
} from "@omniralph/shared";
import { z } from "zod";
import { organizationDefinitions, taskJobInput } from "@/lib/definitions";
import { readHarnessLastSeen } from "@/lib/harnesses/last-seen";
import { reviewTaskNames } from "./post";
import { finishReviewRun } from "./run";

/**
 * Review run correlation: once the last task run of a review run ends with
 * two or more of them finished, `settleReviewRun` (holding the run's row
 * lock) calls `startCorrelation`, which enqueues one run of the
 * repository's correlation task (`builtin:correlate-findings`, trigger
 * `run.invoked`) with every finished task's findings and summary. The task's
 * `run-result` sink hands its result back here: a valid output merges the
 * findings (`applyCorrelation`); a final failure, or an output that doesn't
 * match `CorrelationOutput`, leaves them unmerged and completes the run with
 * the error (`failCorrelation`). Either way the review run is then posted
 * (`finishReviewRun`).
 */

/** Dedupe key of a review run's correlation job. */
export function correlationJobKey(reviewRunId: string): string {
  return `${CORRELATION_JOB_TYPE}:${reviewRunId}`;
}

/** The `run.invoked` trigger context of a review run's correlation. */
export function correlationContext(
  run: Pick<ReviewRun, "id" | "prNumber">,
  repository: string,
  inputs: readonly CorrelationInput[],
  taskName: (taskId: string) => string,
): CorrelationTriggerContext {
  return CorrelationTriggerContext.parse({
    invoker: { kind: "review-run", id: run.id },
    repository,
    pr: { number: run.prNumber },
    reviewRun: {
      tasks: {
        items: inputs.map(({ review, findings }) => {
          const taskId = review.taskId ?? "unknown";
          return {
            taskId,
            name: taskName(taskId),
            summary: review.summary?.trim() || null,
            findings:
              findings.length === 0
                ? null
                : findings.map((f) => ({
                    id: f.id,
                    path: f.path,
                    startLine: f.startLine,
                    endLine: f.endLine,
                    severity: f.severity,
                    category: f.category,
                    confidence: f.confidence,
                    title: f.title,
                    body: f.body,
                    suggestion: f.suggestion,
                  })),
          };
        }),
      },
    },
  });
}

/**
 * `settleReviewRun`'s `StartCorrelation`: inserts the review run's
 * correlation job (in its transaction, claimable by the repository's pinned
 * harness if any, as the dispatcher routes jobs), or returns why it can't:
 * the repository is gone, or its correlation task isn't a query task taking
 * `run.invoked`.
 */
export const startCorrelation: StartCorrelation = async (tx, run, inputs) => {
  const repository = await getRepository(tx, run.repositoryId);
  if (!repository) return { error: "Correlation skipped: the repository is gone" };
  const taskId = repository.correlationTaskId;
  const definitions = organizationDefinitions(tx, run.organizationId);
  const task = await definitions.getTask(taskId);
  if (!task || task.taskType !== "query" || !task.triggers.includes("run.invoked")) {
    console.warn("skipping an unknown correlation task", {
      repositoryId: run.repositoryId,
      taskId,
    });
    return { error: `Correlation skipped: ${taskId} is not a correlation task` };
  }
  const { job } = await insertJob(tx, {
    organizationId: run.organizationId,
    type: CORRELATION_JOB_TYPE,
    ...(await taskJobInput(definitions, task, {
      trigger: {
        kind: "run.invoked",
        context: correlationContext(
          run,
          repository.fullPath,
          inputs,
          await reviewTaskNames(
            definitions,
            inputs.map(({ review }) => review.taskId ?? "unknown"),
          ),
        ),
      },
      repositoryId: run.repositoryId,
    })),
    dedupeKey: correlationJobKey(run.id),
    targetHarnessId: await pinnedHarnessFor(tx, run.organizationId, run.repositoryId, {
      lastHeartbeats: readHarnessLastSeen,
    }),
  });
  return { jobId: job.id };
};

/** The review run a correlation job was invoked by. */
function invokingReviewRun(job: Pick<Job, "id" | "payload">): string {
  const context = RunSpecJobPayload.parse(job.payload).trigger.context;
  const invoker = ReviewRunInvoker.safeParse(context.invoker);
  if (!invoker.success) throw new Error(`Job ${job.id} wasn't invoked by a review run`);
  return invoker.data.id;
}

export type CorrelationOutcome =
  | { status: "applied"; merged: number }
  /** The run was no longer correlating on this job (e.g. superseded). */
  | { status: "ignored" }
  | { status: "failed"; error: string };

/**
 * Applies a correlation run's result to its review run: a valid output
 * merges its findings and stores the summary; a run that didn't answer, or
 * an output that isn't a `CorrelationOutput`, completes the review run with
 * the error and leaves the findings unmerged. Then the review run is posted
 * (once). Safe to call again for a replayed result.
 */
export async function applyCorrelationResult(
  db: Database,
  job: Pick<Job, "id" | "payload">,
  result: QueryRunResult,
): Promise<CorrelationOutcome> {
  const reviewRunId = invokingReviewRun(job);
  const outcome = await correlate(db, reviewRunId, job.id, result);
  await finishReviewRun(db, reviewRunId);
  return outcome;
}

async function correlate(
  db: Database,
  reviewRunId: string,
  jobId: string,
  result: QueryRunResult,
): Promise<CorrelationOutcome> {
  const output =
    result.outcome === "answered" ? CorrelationOutput.safeParse(result.structured) : null;
  if (!output?.success) {
    const error = output
      ? `Correlation output is invalid: ${z.prettifyError(output.error).slice(0, 2000)}`
      : `Correlation didn't finish (${result.outcome})`;
    return (await failCorrelation(db, { reviewRunId, jobId, error }))
      ? { status: "failed", error }
      : { status: "ignored" };
  }
  const applied = await applyCorrelation(db, {
    reviewRunId,
    jobId,
    findings: output.data.findings,
    summary: output.data.summary,
  });
  return applied.applied ? { status: "applied", merged: applied.merged } : { status: "ignored" };
}

/**
 * A correlation run that failed for good or was canceled: the findings stay
 * unmerged, and the review run is posted with them.
 */
export async function onCorrelationFailed(
  db: Database,
  job: Pick<Job, "id" | "payload">,
  error: string,
): Promise<void> {
  const reviewRunId = invokingReviewRun(job);
  await failCorrelation(db, { reviewRunId, jobId: job.id, error });
  await finishReviewRun(db, reviewRunId);
}
