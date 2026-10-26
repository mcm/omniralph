import type { InboxAction, InboxItem } from "@/lib/api/inbox";

/** One decision on an Inbox item: a labeled button (Design rule 6). */
export interface InboxDecision {
  action: InboxAction;
  label: string;
  /** `primary` (lavender) only for the first: the action that clears the item. */
  variant: "primary" | "outline";
}

type Kind = InboxItem["kind"];

const SNOOZE: [InboxAction, string] = ["snooze", "Snooze"];
const DONE: [InboxAction, string] = ["done", "Done"];

/** Each kind's buttons, in order: the clearing action first. */
const DECISIONS: Record<Kind, readonly [InboxAction, string][]> = {
  manual_story: [["done", "Done, resume epic"], ["skip", "Skip story"], SNOOZE],
  blocked_epic: [["start_anyway", "Start anyway"], DONE, SNOOZE],
  question: [["answer", "Send answer"], DONE, SNOOZE],
  stopped_epic: [["resume", "Resume"], DONE, SNOOZE],
  prd_ready: [DONE, SNOOZE],
  pr_waiting: [DONE, SNOOZE],
  agent_offline: [DONE, SNOOZE],
  agent_update_failed: [DONE, SNOOZE],
  failed_run: [["retry", "Retry"], DONE, SNOOZE],
  failed_system: [["retry", "Retry"], DONE, SNOOZE],
  run: [],
};

/**
 * The item's decision buttons, in order: its kind's buttons whose action the item's
 * `actions` include. The first is the clearing action and the only `primary` one.
 */
export function inboxDecisions(item: Pick<InboxItem, "kind" | "actions">): InboxDecision[] {
  return DECISIONS[item.kind]
    .filter(([action]) => item.actions.includes(action))
    .map(([action, label], index) => ({
      action,
      label,
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
