import type { StatusTone } from "@omniralph/ui";
import type { RunRow } from "@/lib/api/runs";
import { RUN_STATUS_TONES } from "@/components/runs/run-status";
import { RUN_KIND_LABELS } from "@/components/runs/run-kind";

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
 * A run row's label and dot tone: "{Kind} · {state}", the same form as the Inbox's rows, so a
 * running epic is "Epic · running" in Runs and in the Inbox's Running tab (Design rules 8 and
 * 21). Never a failure reason, findings count, story count or summary (rule 8): which story
 * runs is on the run's status line (`runStatusLine`).
 */
export function runRowLabel(row: Pick<RunRow, "kind" | "status">): RunRowLabel {
  return {
    label: `${RUN_KIND_LABELS[row.kind]} · ${RUN_STATE_WORDS[row.status]}`,
    tone: RUN_STATUS_TONES[row.status],
  };
}
