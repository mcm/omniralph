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

/**
 * Each run status's tone (Design rule 15): running lavender (live now), waiting lavender
 * with its halo (needs you), finished mint, stopped amber, failed coral, queued and skipped
 * neutral (not started).
 */
export const RUN_STATUS_TONES: Record<RunStatus, StatusTone> = {
  queued: "neutral",
  running: "run",
  waiting: "need",
  completed: "good",
  failed: "fail",
  stopped: "warn",
  skipped: "neutral",
};
