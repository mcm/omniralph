import type { MenuItem, StatusTone } from "@omniralph/ui";
import { IconCopy, IconExternalLink, IconMessage, IconPlayerStop } from "@tabler/icons-react";
import type { RunDetail, RunRetryTarget, RunStep } from "@/lib/api/runs";
import { stepState } from "./progress";
import { RUN_STATUS_LABELS, RUN_STATUS_TONES } from "./run-status";

type Provider = "github" | "gitlab";

/** "merge request" on GitLab, "pull request" on GitHub. */
function changeRequestWord(provider: Provider): string {
  return provider === "gitlab" ? "merge request" : "pull request";
}

/** The run's state word: "Running · story 2 of 4" for a running epic with progress. */
function stateWord(detail: Pick<RunDetail, "kind" | "status" | "progress">): string {
  const { progress } = detail;
  if (detail.kind === "epic" && detail.status === "running" && progress && progress.total > 0) {
    return `Running · story ${Math.min(progress.done + 1, progress.total)} of ${progress.total}`;
  }
  return RUN_STATUS_LABELS[detail.status];
}

export interface RunStatusLineView {
  text: string;
  tone: StatusTone;
}

/**
 * The run detail's status line: the state word, plus " · merge request open|merged|closed"
 * (or "pull request …") when the run has a PR/MR, e.g. "Finished · merge request open" or
 * "Running · story 2 of 4". Its tone is the status's (Design rule 15).
 */
export function runStatusLine(
  detail: Pick<RunDetail, "kind" | "status" | "progress" | "pullRequest" | "details">,
): RunStatusLineView {
  const tone = RUN_STATUS_TONES[detail.status];
  const word = stateWord(detail);
  const pullRequest = detail.details.pullRequest ?? detail.pullRequest;
  if (!pullRequest) return { text: word, tone };
  const { merged = null, closed = null } = detail.details.pullRequest ?? {};
  const state = merged ? "merged" : closed ? "closed" : "open";
  return { text: `${word} · ${changeRequestWord(pullRequest.provider)} ${state}`, tone };
}

/** Whether the step has an attempt (a story counts its finished ones). */
function hasAttempt(step: RunStep, attempts: RunDetail["attempts"]): boolean {
  if (step.kind === "attempt" || step.kind === "correlation") return true;
  if (step.kind === "story" && step.attempts > 0) return true;
  return attempts.some((attempt) => attempt.step === step.id);
}

/**
 * The step a run opens on: the first running step, else the first failed one, else the
 * first waiting one, else the last step that has an attempt. None for a run without steps
 * (or whose steps haven't started).
 */
export function defaultStep(detail: Pick<RunDetail, "steps" | "attempts">): string | undefined {
  const { steps } = detail;
  for (const state of ["running", "failed", "waiting"] as const) {
    const step = steps.find((candidate) => stepState(candidate.status) === state);
    if (step) return step.id;
  }
  return steps.findLast((step) => hasAttempt(step, detail.attempts))?.id;
}

/** The step the URL names, when the run has it; else `defaultStep`. */
export function selectedStep(
  detail: Pick<RunDetail, "steps" | "attempts">,
  stepId: string | null,
): RunStep | undefined {
  const id =
    stepId && detail.steps.some((step) => step.id === stepId) ? stepId : defaultStep(detail);
  return detail.steps.find((step) => step.id === id);
}

/** A toolbar button of the run detail. */
export type RunToolbarItem =
  | { kind: "pull_request"; label: "Open merge request" | "Open pull request"; href: string }
  | { kind: "retry"; label: "Retry run" | "Re-run story"; target: RunRetryTarget };

/**
 * The run detail's toolbar (Design rule 5), at most two icon buttons: "Open merge request" /
 * "Open pull request" when the run has a PR/MR, then "Retry run" when the run can be retried,
 * or "Re-run story" for a finished epic whose selected story can be re-run.
 */
export function runToolbar(
  detail: Pick<RunDetail, "kind" | "status" | "pullRequest" | "details">,
  step: RunStep | undefined,
): RunToolbarItem[] {
  const items: RunToolbarItem[] = [];
  const { pullRequest } = detail;
  if (pullRequest?.url) {
    items.push({
      kind: "pull_request",
      label: pullRequest.provider === "gitlab" ? "Open merge request" : "Open pull request",
      href: pullRequest.url,
    });
  }
  const { retry } = detail.details.actions;
  if (retry.run) {
    items.push({ kind: "retry", label: "Retry run", target: { kind: "run" } });
  } else if (
    detail.kind === "epic" &&
    detail.status === "completed" &&
    step?.kind === "story" &&
    retry.storyIds.includes(step.id)
  ) {
    items.push({
      kind: "retry",
      label: "Re-run story",
      target: { kind: "story", storyId: step.id },
    });
  }
  return items;
}

export interface RunMenuHandlers {
  /** Copies the run's branch. */
  onCopyBranch: () => void;
  /** Asks to confirm, then stops the run. */
  onStop: () => void;
  /** Items other screens add first (the Backlog's "View PRD"). */
  leading?: readonly MenuItem[];
}

/**
 * The run detail's ⋯ menu, the single source of its entries: the `leading` items other
 * screens add, Open chat (the caller's own Ask chat the run came from), Open in Linear (the
 * work item) and Copy branch, then, after a divider, "Stop run" (destructive; `onStop`
 * confirms) when the run can be stopped.
 */
export function runMenuItems(
  detail: Pick<RunDetail, "workItem" | "branch" | "details" | "chat">,
  { onCopyBranch, onStop, leading = [] }: RunMenuHandlers,
): MenuItem[] {
  const items: MenuItem[] = [...leading];
  if (detail.chat?.href)
    items.push({ label: "Open chat", icon: IconMessage, href: detail.chat.href });
  if (detail.workItem?.url) {
    items.push({ label: "Open in Linear", icon: IconExternalLink, href: detail.workItem.url });
  }
  if (detail.branch) items.push({ label: "Copy branch", icon: IconCopy, onSelect: onCopyBranch });
  if (detail.details.actions.stop) {
    items.push({ label: "Stop run", icon: IconPlayerStop, destructive: true, onSelect: onStop });
  }
  return items;
}
