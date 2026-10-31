import type { StatusTone } from "../status/status.js";

/** Where a step stands. Only `waiting` means needs you (Design rule 15). */
export type StepState =
  | "done"
  | "waiting"
  | "running"
  | "failed"
  | "blocked"
  | "pending"
  | "canceled";

export interface ProgressStep {
  id: string;
  label: string;
  state: StepState;
  /** A short machine fact shown after the label (e.g. a duration or ID), in mono. */
  meta?: string;
  /** Makes the label a link. */
  href?: string;
}

/** The visible and spoken name of each state. */
export const STEP_STATE_LABELS: Record<StepState, string> = {
  done: "Done",
  waiting: "Waiting on you",
  running: "Running",
  failed: "Failed",
  blocked: "Blocked",
  pending: "Pending",
  canceled: "Canceled",
};

/**
 * Each state's tone (Design rule 15), the same on a progress card's dot and anywhere else a
 * step's state shows: done mint, running lavender, waiting lavender with its halo, failed
 * coral, the rest neutral. A done step's mark is a check in its tone.
 */
export const STEP_STATE_TONES: Readonly<Record<StepState, StatusTone>> = {
  done: "good",
  waiting: "need",
  running: "run",
  failed: "fail",
  blocked: "neutral",
  pending: "neutral",
  canceled: "neutral",
};

/** The parts after "N of M done", in their fixed order. */
const SUMMARY_PARTS: readonly [StepState, string][] = [
  ["waiting", "waiting on you"],
  ["running", "running"],
  ["failed", "failed"],
  ["blocked", "blocked"],
  ["canceled", "canceled"],
];

/**
 * The one-line count for a progress card (Design rule 10): "N of M done" followed by each
 * non-zero part in a fixed order, e.g. "2 of 4 done · 1 waiting on you · 1 blocked", then
 * the optional `suffix` (e.g. a total duration: "8 of 9 done · 1 canceled · 3h 31m").
 */
export function progressSummary(
  steps: readonly Pick<ProgressStep, "state">[],
  suffix?: string,
): string {
  if (steps.length === 0) return "No steps yet";
  const count = (state: StepState) => steps.filter((step) => step.state === state).length;
  const parts = [`${count("done")} of ${steps.length} done`];
  for (const [state, text] of SUMMARY_PARTS) {
    const n = count(state);
    if (n > 0) parts.push(`${n} ${text}`);
  }
  if (suffix) parts.push(suffix);
  return parts.join(" · ");
}
