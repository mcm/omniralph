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
  /** The row's kind, e.g. "Review": the line above its title (its dot's color says the state). */
  label: string;
  /** Names the row's dot with the kind and state, e.g. "Review, failed". */
  statusLabel: string;
  /** A running epic's story, e.g. "Story 2 of 4" (a badge); null otherwise. */
  story: string | null;
  /** The row dot's tone (Design rule 15). */
  tone: StatusTone;
}

/**
 * A run row's kind line, its dot's name and tone, and for a running epic with progress the
 * story it's on (the Runs board). Never a failure reason, findings count or summary (Design
 * rule 8).
 */
export function runRowLabel(row: Pick<RunRow, "kind" | "status" | "progress">): RunRowLabel {
  const kind = RUN_KIND_LABELS[row.kind];
  const story =
    row.kind === "epic" && row.status === "running" && row.progress && row.progress.total > 0
      ? `Story ${row.progress.current ?? Math.min(row.progress.done + 1, row.progress.total)} of ${row.progress.total}`
      : null;
  return {
    label: kind,
    statusLabel: `${kind}, ${RUN_STATE_WORDS[row.status]}`,
    story,
    tone: RUN_STATUS_TONES[row.status],
  };
}
