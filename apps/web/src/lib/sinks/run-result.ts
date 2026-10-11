import "server-only";
import { QueryRunResult } from "@omniralph/shared";
import { applyCorrelationResult, onCorrelationFailed } from "@/lib/review/correlate";
import type { Sink } from "./index";

/**
 * `run-result`: hands a `run.invoked` query run's result back to the run that
 * invoked it (the trigger context's `invoker`). The only invoker so far is a
 * review run, whose correlation (`builtin:correlate-findings`) checks the
 * output itself (`applyCorrelationResult`), so the sink accepts any query
 * result: an output that doesn't match leaves the findings unmerged instead
 * of being rejected. A final failure or a cancel does the same.
 */
export const runResultSink: Sink<never, QueryRunResult> = {
  kind: "run-result",
  outputSchema: null,
  parseResult(result) {
    const parsed = QueryRunResult.safeParse(result);
    return parsed.success ? parsed.data : null;
  },
  apply: applyCorrelationResult,
  onFailed: (db, job, error) =>
    onCorrelationFailed(db, job, `Correlation failed: ${error ?? "unknown error"}`),
  onCanceled: (db, job) => onCorrelationFailed(db, job, "Correlation was canceled"),
};
