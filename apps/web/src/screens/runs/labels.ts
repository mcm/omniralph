import type { StatusTone } from "@omniralph/ui";
import type { RunRow } from "@/lib/api/runs";
import { RUN_STATUS_TONES } from "@/components/runs/run-status";
import { RUN_KIND_LABELS } from "../inbox/labels";

type RunStatus = RunRow["status"];

/** Each run status as a row's state word names it. */
export const RUN_STATE_WORDS: Readonly<Record<RunStatus, string>> = {
  queued: "queued",
  running: "running",
  waiting: "waiting on you",
  completed: "finished",
  failed: "failed",
  stopped: "stopped",
  skipped: "skipped",
};

export interface RunRowLabel {
  /** The row's kind and state, e.g. "Review · failed"; it also names the dot. */
  label: string;
  /** The row dot's tone (Design rule 15). */
  tone: StatusTone;
}

/**
 * A run row's label and dot tone: "{Kind} · {state}", and for a running epic with progress
 * "Running · story {n} of {total}" (the Runs board). Never a failure reason, findings count
 * or summary (Design rule 8).
 */
export function runRowLabel(row: Pick<RunRow, "kind" | "status" | "progress">): RunRowLabel {
  const tone = RUN_STATUS_TONES[row.status];
  if (row.kind === "epic" && row.status === "running" && row.progress && row.progress.total > 0) {
    const story = Math.min(row.progress.done + 1, row.progress.total);
    return { label: `Running · story ${story} of ${row.progress.total}`, tone };
  }
  return { label: `${RUN_KIND_LABELS[row.kind]} · ${RUN_STATE_WORDS[row.status]}`, tone };
}
