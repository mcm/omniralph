import "server-only";
import { TriageAgentOutput } from "@omniralph/ralph";
import {
  onTriageJobCompleted,
  onTriageJobFinishedWithoutResult,
  onTriageJobStarted,
} from "@/lib/triage/apply";
import type { Sink } from "./index";

/**
 * The `triage` sink of `builtin:triage` runs (job type `triage.run`): the
 * structured result has the triage output's shape (`TriageAgentOutput`, the
 * task's output schema); `validateTriageOutput` then decides whether it is a
 * usable PRD. A well-formed result it rejects is still accepted: `apply` then
 * fails the job and the run, and tells the Linear session why.
 *
 * - `onStarted` claims the triage run for the job, and skips it when the
 *   issue or a sub-issue went in progress or done since triage was asked for.
 * - `apply` (`applyTriageJob`) re-checks the issue isn't locked, then writes
 *   the PRD to Linear, once: a replayed result finds the run finished.
 * - `onFailed`/`onCanceled` end the run and say so in the session.
 *
 * `apply`, `onFailed` and `onCanceled` then start the job a reply that
 * arrived meanwhile asks for.
 */
export const triageSink: Sink<TriageAgentOutput> = {
  kind: "triage",
  outputSchema: TriageAgentOutput,
  onStarted: (db, job) => onTriageJobStarted(db, job),
  apply: (db, job) => onTriageJobCompleted(db, job),
  onFailed: (db, job, error) => onTriageJobFinishedWithoutResult(db, job, "failed", error),
  onCanceled: (db, job) => onTriageJobFinishedWithoutResult(db, job, "stopped", null),
};
