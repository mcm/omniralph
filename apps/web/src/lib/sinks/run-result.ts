import "server-only";
import type { Job } from "@omniralph/db";
import { QueryRunResult, RunInvoker, RunSpecJobPayload } from "@omniralph/shared";
import { onRalphJobFinished, onRalphJobStarted } from "@/lib/ralph/jobs";
import { applyCorrelationResult, onCorrelationFailed } from "@/lib/review/correlate";
import type { Sink } from "./index";

/** The kind of run that invoked a `run.invoked` run (the trigger context's `invoker`); null without one. */
function invokerKind(job: Pick<Job, "payload">): RunInvoker["kind"] | null {
  const payload = RunSpecJobPayload.safeParse(job.payload);
  const invoker = payload.success
    ? RunInvoker.safeParse(payload.data.trigger.context.invoker)
    : null;
  return invoker?.success ? invoker.data.kind : null;
}

const byRalphRun = (job: Pick<Job, "payload">) => invokerKind(job) === "ralph-run";

/**
 * `run-result`: hands a `run.invoked` query run's result back to the run that
 * invoked it (the trigger context's `invoker`), so the sink accepts any query
 * result and the invoker checks the output itself:
 * - a review run's correlation (`builtin:correlate-findings`,
 *   `applyCorrelationResult`): an output that doesn't match leaves the
 *   findings unmerged instead of being rejected; a final failure or a cancel
 *   does the same.
 * - a ralph run's PR/MR description (its story task's `prDescriptionTaskId`):
 *   through the same hooks as a `ralph.describe-pr` job; the delivery makes
 *   its harness the run's sticky harness (or is skipped once the run is
 *   over), and `advanceRun` applies the outcome it finds through the run's
 *   `pr_job_id` (`applyPullRequestJob`).
 */
export const runResultSink: Sink<never, QueryRunResult> = {
  kind: "run-result",
  taskType: "query",
  anyOutput: true,
  outputSchema: null,
  parseResult(result) {
    const parsed = QueryRunResult.safeParse(result);
    return parsed.success ? parsed.data : null;
  },
  onStarted: async (db, job, harnessId) =>
    byRalphRun(job) ? onRalphJobStarted(db, job, harnessId) : { skip: false },
  apply: (db, job, result) =>
    byRalphRun(job) ? onRalphJobFinished(db, job) : applyCorrelationResult(db, job, result),
  onFailed: (db, job, error) =>
    byRalphRun(job)
      ? onRalphJobFinished(db, job)
      : onCorrelationFailed(db, job, `Correlation failed: ${error ?? "unknown error"}`),
  onCanceled: (db, job) =>
    byRalphRun(job)
      ? onRalphJobFinished(db, job)
      : onCorrelationFailed(db, job, "Correlation was canceled"),
};
