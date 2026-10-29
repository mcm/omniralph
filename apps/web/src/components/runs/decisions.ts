import { START_EPIC } from "@/components/work-items/action-labels";
import type { InboxAction, InboxItem } from "@/lib/api/inbox";

/**
 * What a decision does: an Inbox action (`POST /api/ui/inbox/items/{key}`), or one of the
 * item's own: `start_epic` (a ready PRD's work item starts, through the Backlog's Start
 * epic) and `open_change` (opens the PR/MR on its code host).
 */
export type InboxDecisionAction = InboxAction | "start_epic" | "open_change";

/** One decision on an Inbox item: a labeled button (Design rule 6). */
export interface InboxDecision {
  action: InboxDecisionAction;
  label: string;
  /** `primary` (lavender) only for the first: the action that clears the item. */
  variant: "primary" | "outline";
}

type Kind = InboxItem["kind"];

type DecisionItem = Pick<InboxItem, "kind" | "actions" | "workItem" | "pullRequest"> & {
  run?: Pick<NonNullable<InboxItem["run"]>, "status"> | null;
};

const SNOOZE: [InboxAction, string] = ["snooze", "Snooze"];
const DONE: [InboxAction, string] = ["done", "Done"];

/** "Open pull request", or "Open merge request" on GitLab. */
export function openChangeLabel(item: Pick<InboxItem, "pullRequest">): string {
  return item.pullRequest?.provider === "gitlab" ? "Open merge request" : "Open pull request";
}

/**
 * A decision's label: its kind's, except a PR/MR's Open merge request on GitLab, and a manual
 * story's Done while its epic still runs ("Mark story done": there is nothing to resume).
 */
function decisionLabel(item: DecisionItem, action: InboxDecisionAction, label: string): string {
  if (action === "open_change") return openChangeLabel(item);
  if (item.kind === "manual_story" && action === "done" && item.run?.status === "running") {
    return "Mark story done";
  }
  return label;
}

/** Whether the item offers a decision of its own (one that isn't an Inbox action). */
function offers(item: DecisionItem, action: InboxDecisionAction): boolean {
  if (action === "start_epic") return Boolean(item.workItem?.id);
  if (action === "open_change") return Boolean(item.pullRequest?.url);
  return item.actions.includes(action);
}

/** Each kind's buttons, in order: the clearing action first. */
const DECISIONS: Record<Kind, readonly [InboxDecisionAction, string][]> = {
  manual_story: [["done", "Done, resume epic"], ["skip", "Skip story"], SNOOZE],
  blocked_epic: [["start_anyway", "Start anyway"], DONE, SNOOZE],
  question: [["answer", "Send answer"], DONE, SNOOZE],
  stopped_epic: [["resume", "Resume"], DONE, SNOOZE],
  prd_ready: [["start_epic", START_EPIC], DONE, SNOOZE],
  pr_waiting: [["open_change", "Open pull request"], DONE, SNOOZE],
  agent_offline: [DONE, SNOOZE],
  agent_update_failed: [DONE, SNOOZE],
  failed_run: [["retry", "Retry"], DONE, SNOOZE],
  failed_system: [["retry", "Retry"], DONE, SNOOZE],
  run: [],
};

/**
 * The item's decision buttons, in order: its kind's buttons whose action the item offers
 * (its `actions`; a work item to start; a PR/MR link to open). The first is the decision the
 * item waits for and the only `primary` one.
 */
export function inboxDecisions(item: DecisionItem): InboxDecision[] {
  return DECISIONS[item.kind]
    .filter(([action]) => offers(item, action))
    .map(([action, label], index) => ({
      action,
      label: decisionLabel(item, action, label),
      variant: index === 0 ? "primary" : "outline",
    }));
}

export const SNOOZE_CHOICES = ["hour", "tomorrow", "next-week"] as const;
export type SnoozeChoice = (typeof SNOOZE_CHOICES)[number];

export const SNOOZE_LABELS: Record<SnoozeChoice, string> = {
  hour: "1 hour",
  tomorrow: "Tomorrow",
  "next-week": "Next week",
};

/**
 * Until when a snooze lasts: an hour from `now`, 9:00 the next day, or 9:00 next Monday
 * (local time; a Monday's next Monday is a week ahead). Always 5 minutes to 30 days ahead.
 */
export function snoozeUntil(choice: SnoozeChoice, now: Date): Date {
  if (choice === "hour") return new Date(now.getTime() + 3_600_000);
  const days = choice === "tomorrow" ? 1 : (8 - now.getDay()) % 7 || 7;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 9, 0, 0, 0);
}

/** A decision on an item that no longer derives (someone else decided it first). */
export const ITEM_HANDLED = "This item was already handled.";
