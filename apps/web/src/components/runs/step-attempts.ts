import type { RunAttempt, RunDetail, RunRetryTarget, RunStep } from "@/lib/api/runs";

/** Transcript events shown before "{n} more events · Show all". */
export const TRANSCRIPT_PREVIEW_EVENTS = 8;

/** The step panel's own tabs; other screens add theirs between them (Diff, Findings). */
export const STEP_PANEL_TRANSCRIPT = "transcript";
export const STEP_PANEL_ATTEMPTS = "attempts";

/** The attempt statuses that can still change (and be canceled). */
const LIVE_STATUSES: readonly RunAttempt["status"][] = ["queued", "running"];
const FAILED_STATUSES: readonly RunAttempt["status"][] = ["failed", "expired"];

/** Whether the attempt is queued or running: its transcript can still grow. */
export function isLiveAttempt(attempt: Pick<RunAttempt, "status">): boolean {
  return LIVE_STATUSES.includes(attempt.status);
}

/** Whether the attempt failed (or expired before an agent finished it). */
export function isFailedAttempt(attempt: Pick<RunAttempt, "status">): boolean {
  return FAILED_STATUSES.includes(attempt.status);
}

/** The step's attempts, newest first (the run detail lists them newest first). */
export function stepAttempts(
  run: Pick<RunDetail, "attempts">,
  step: Pick<RunStep, "id">,
): RunAttempt[] {
  return run.attempts.filter((attempt) => attempt.step === step.id);
}

/** The attempt the URL names (`?attempt=`) when the step has it, else the step's latest. */
export function selectedAttempt(
  attempts: readonly RunAttempt[],
  attemptId: string | null | undefined,
): RunAttempt | undefined {
  return attempts.find((attempt) => attempt.id === attemptId) ?? attempts[0];
}

/** The tab the URL names (`?tab=`) when the panel has it, else Transcript. */
export function selectedTab(tabs: readonly string[], tab: string | null | undefined): string {
  return tab && tabs.includes(tab) ? tab : STEP_PANEL_TRANSCRIPT;
}

/**
 * A story's `lastFeedback` (why its last attempt didn't complete), shown above its
 * transcript while its last attempt isn't a completed one; null otherwise.
 */
export function lastFeedback(step: RunStep, attempts: readonly RunAttempt[]): string | null {
  if (step.kind !== "story" || !step.lastFeedback) return null;
  return attempts[0]?.status === "completed" ? null : step.lastFeedback;
}

/** "{n} more events" past the preview. */
export function moreEvents(n: number): string {
  return `${n} more ${n === 1 ? "event" : "events"}`;
}

export interface StepRetry {
  label: "Retry story" | "Re-run story" | "Retry attempt";
  target: RunRetryTarget;
}

/**
 * The step panel's retry button, from the step's state and the run's `actions`: "Re-run
 * story" for a finished story, "Retry story" for another story the run can retry, else
 * "Retry attempt" for the shown attempt when it can be retried. None otherwise.
 */
export function stepRetry(
  run: Pick<RunDetail, "details">,
  step: RunStep,
  attempt: Pick<RunAttempt, "id"> | undefined,
): StepRetry | null {
  const { retry } = run.details.actions;
  if (step.kind === "story" && retry.storyIds.includes(step.id)) {
    return {
      label: step.status === "completed" ? "Re-run story" : "Retry story",
      target: { kind: "story", storyId: step.id },
    };
  }
  if (attempt && retry.attemptIds.includes(attempt.id)) {
    return { label: "Retry attempt", target: { kind: "attempt", attemptId: attempt.id } };
  }
  return null;
}
