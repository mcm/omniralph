import {
  STEP_STATE_LABELS,
  type ProgressStep,
  type StatusTone,
  type StepState,
} from "@omniralph/ui";
import type { RunDetail, RunStep } from "@/lib/api/runs";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** A duration as the progress card's count line shows it: "45s", "13m", "3h 31m", "2h". */
export function formatDuration(ms: number): string {
  if (ms < MINUTE) return `${Math.floor(ms / SECOND)}s`;
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  const hours = Math.floor(ms / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

/**
 * A step's state on the progress card (the epic's mapping): completed → done, manual or
 * waiting → waiting, running → running, failed or exhausted → failed, blocked (a pending
 * story with open blockers) → blocked, canceled or skipped → canceled, anything else
 * (queued, waiting for an agent, too) → pending, so a queued run never reads as running.
 */
export function stepState(status: RunStep["status"] | "waiting"): StepState {
  switch (status) {
    case "completed":
      return "done";
    case "manual":
    case "waiting":
      return "waiting";
    case "running":
      return "running";
    case "failed":
    case "exhausted":
    case "budget_exhausted":
      return "failed";
    case "blocked":
      return "blocked";
    case "canceled":
    case "skipped":
      return "canceled";
    default:
      return "pending";
  }
}

/** A step's name, as its progress card row reads (a story's title, a pass's task). */
export function stepLabel(step: RunStep): string {
  switch (step.kind) {
    case "story":
      return step.title;
    case "review_pass":
      return step.taskName;
    case "correlation":
    case "attempt":
      return step.label;
  }
}

export interface RunProgressSteps {
  steps: ProgressStep[];
  /** The run's total duration (the sum of its steps'), for the count line; none when zero. */
  summarySuffix: string | undefined;
}

/**
 * A run's steps as the progress card draws them: each step's label, state and duration,
 * plus the run's total duration ("8 of 9 done · 1 canceled · 3h 31m").
 */
export function stepsToProgress(steps: readonly RunStep[]): RunProgressSteps {
  let total = 0;
  const progress = steps.map((step): ProgressStep => {
    const duration = step.durationMs ?? 0;
    total += duration;
    return {
      id: step.id,
      label: stepLabel(step),
      state: stepState(step.status),
      ...(duration > 0 ? { meta: formatDuration(duration) } : {}),
    };
  });
  return { steps: progress, summarySuffix: total > 0 ? formatDuration(total) : undefined };
}

/** What a run's steps are called, as its progress card's title. */
const PROGRESS_TITLES: Record<RunDetail["kind"], string> = {
  epic: "Stories",
  review: "Review passes",
  request: "Turns",
  triage: "Turns",
  ask: "Turns",
};

/** The progress card's title: "Epic progress" for an epic in the Inbox, else by kind. */
export function progressTitle(kind: RunDetail["kind"], mode: "link" | "select"): string {
  return mode === "link" && kind === "epic" ? "Epic progress" : PROGRESS_TITLES[kind];
}

const STEP_TONES: Record<StepState, StatusTone> = {
  done: "neutral",
  waiting: "need",
  running: "run",
  failed: "fail",
  blocked: "neutral",
  pending: "neutral",
  canceled: "neutral",
};

/**
 * A step's status line on its own view (the phone step page), under its name: its state,
 * e.g. "Running", toned like its progress card dot.
 */
export function stepStatusLine(step: RunStep): { tone: StatusTone; state: string } {
  const state = stepState(step.status);
  return { tone: STEP_TONES[state], state: STEP_STATE_LABELS[state] };
}
