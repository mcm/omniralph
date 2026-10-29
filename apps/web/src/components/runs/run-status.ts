import type { StatusTone } from "@omniralph/ui";
import type { RunDetail } from "@/lib/api/runs";

type RunStatus = RunDetail["status"];

/** Each run status as a sentence names it. */
export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting on you",
  completed: "Finished",
  failed: "Failed",
  stopped: "Stopped",
  skipped: "Skipped",
};

/** Each run status's tone (Design rule 15): running and queued mint, failed coral, waiting and stopped lavender. */
export const RUN_STATUS_TONES: Record<RunStatus, StatusTone> = {
  queued: "run",
  running: "run",
  waiting: "need",
  completed: "neutral",
  failed: "fail",
  stopped: "need",
  skipped: "neutral",
};

/**
 * "Running · story 3 of 9" for a running epic while one of its stories runs: the running
 * story's place in the epic (as the Fleet's "Story 3 of 9" counts it), never the count of
 * finished ones. Null for any other run, or while no story runs.
 */
export function runningStoryLabel(
  run: Pick<RunDetail, "kind" | "status" | "progress">,
): string | null {
  const { progress } = run;
  if (run.kind !== "epic" || run.status !== "running" || progress?.running == null) return null;
  return `Running · story ${progress.running} of ${progress.total}`;
}
