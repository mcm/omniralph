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
