import type { MenuItem, StatusTone } from "@omniralph/ui";
import { IconCopy, IconMessage, IconPlayerStop } from "@tabler/icons-react";
import { workItemLinkMenuItems } from "@/components/work-items/work-item-links";
import type { RunDetail, RunRetryTarget, RunStep } from "@/lib/api/runs";
import { stepState } from "./progress";
import { RUN_STATUS_LABELS, RUN_STATUS_TONES } from "./run-status";

type Provider = "github" | "gitlab";

/** "merge request" on GitLab, "pull request" on GitHub. */
function changeRequestWord(provider: Provider): string {
  return provider === "gitlab" ? "merge request" : "pull request";
}

/** "merge request open|merged|closed" (or "pull request …"), the state of a run's PR/MR. */
function changeRequestState(
  detail: Pick<RunDetail, "pullRequest" | "details">,
): RunStatusLineView["change"] {
  const pullRequest = detail.details.pullRequest ?? detail.pullRequest;
  if (!pullRequest) return null;
  const { merged = null, closed = null } = detail.details.pullRequest ?? {};
  const state = merged ? "merged" : closed ? "closed" : "open";
  return {
    provider: pullRequest.provider,
    text: `${changeRequestWord(pullRequest.provider)} ${state}`,
  };
}

export interface RunStatusLineView {
  /** The state word: "Running", "Finished". */
  text: string;
  tone: StatusTone;
  /** A running epic's story: "Story 2 of 4"; null otherwise. */
  story: string | null;
  /** The run's PR/MR and its state, "merge request open"; null without one. */
  change: { provider: Provider; text: string } | null;
}

/**
 * A running epic's story number: the running story's position in execution order, so it
 * matches the progress card's numbering; else (no story running yet) the one after the done
 * ones (`progress.done` counts canceled stories too).
 */
function runningStoryNumber(
  steps: RunDetail["steps"],
  progress: NonNullable<RunDetail["progress"]>,
): number {
  const stories = steps.filter((step) => step.kind === "story");
  const running = stories.findIndex((step) => stepState(step.status) === "running");
  return running >= 0 ? running + 1 : Math.min(progress.done + 1, progress.total);
}

/**
 * The run detail's status line: the state word, then badges for a running epic's story
 * ("Story 2 of 4") and the run's PR/MR state ("merge request open|merged|closed", or "pull
 * request …"), e.g. "Finished [merge request open]". Its tone is the status's (Design rule 15).
 */
export function runStatusLine(
  detail: Pick<RunDetail, "kind" | "status" | "progress" | "pullRequest" | "details"> &
    Partial<Pick<RunDetail, "steps">>,
): RunStatusLineView {
  const { progress } = detail;
  const story =
    detail.kind === "epic" && detail.status === "running" && progress && progress.total > 0
      ? `Story ${runningStoryNumber(detail.steps ?? [], progress)} of ${progress.total}`
      : null;
  return {
    text: RUN_STATUS_LABELS[detail.status],
    tone: RUN_STATUS_TONES[detail.status],
    story,
    change: changeRequestState(detail),
  };
}

/** Whether the step has an attempt (a story counts its finished ones). */
function hasAttempt(step: RunStep, attempts: RunDetail["attempts"]): boolean {
  if (step.kind === "attempt" || step.kind === "correlation") return true;
  if (step.kind === "story" && step.attempts > 0) return true;
  return attempts.some((attempt) => attempt.step === step.id);
}

/** The open findings of a review pass, all severities. */
function openFindings(step: Extract<RunStep, { kind: "review_pass" }>): number {
  const { critical, high, medium, low, info } = step.openFindings;
  return critical + high + medium + low + info;
}

/**
 * The step a run opens on: the first running step, else the first failed one, else the
 * first waiting one. Then, for a review, its first pass with open findings, else its first
 * pass (never the correlation step, which has no findings); for an epic, the first story that
 * has an attempt (its stories are in execution order, so a finished epic opens on its
 * earliest story); else the last step that has an attempt (a request's latest turn). None
 * for a run without steps (or whose steps haven't started).
 */
export function defaultStep(detail: Pick<RunDetail, "steps" | "attempts">): string | undefined {
  const { steps } = detail;
  for (const state of ["running", "failed", "waiting"] as const) {
    const step = steps.find((candidate) => stepState(candidate.status) === state);
    if (step) return step.id;
  }
  const passes = steps.filter((step) => step.kind === "review_pass");
  if (passes.length > 0) return (passes.find((pass) => openFindings(pass) > 0) ?? passes[0])!.id;
  const started = steps.filter((step) => hasAttempt(step, detail.attempts));
  return (started.find((step) => step.kind === "story") ?? started.at(-1))?.id;
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
  /** Items other screens add first (e.g. Ask's). */
  leading?: readonly MenuItem[];
  /** "Stop run"'s shortcut key, in `aria-keyshortcuts` form. */
  stopKeyShortcuts?: string;
}

/**
 * The run detail's ⋯ menu, the single source of its entries: the `leading` items other
 * screens add, Open chat (the caller's own Ask chat the run came from), Open work item (its
 * Backlog page) and Open in <tracker> (`workItemLinkMenuItems`) and Copy branch, then, after a divider, "Stop run" (destructive; `onStop`
 * confirms) when the run can be stopped.
 */
export function runMenuItems(
  detail: Pick<RunDetail, "workItem" | "branch" | "details" | "chat">,
  { onCopyBranch, onStop, leading = [], stopKeyShortcuts }: RunMenuHandlers,
): MenuItem[] {
  const items: MenuItem[] = [...leading];
  if (detail.chat?.href)
    items.push({ label: "Open chat", icon: IconMessage, href: detail.chat.href });
  items.push(...workItemLinkMenuItems(detail.workItem));
  if (detail.branch) items.push({ label: "Copy branch", icon: IconCopy, onSelect: onCopyBranch });
  if (detail.details.actions.stop) {
    items.push({
      label: "Stop run",
      icon: IconPlayerStop,
      destructive: true,
      onSelect: onStop,
      keyShortcuts: stopKeyShortcuts,
    });
  }
  return items;
}
