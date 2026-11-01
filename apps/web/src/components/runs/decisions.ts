import type { InboxAction, InboxItem } from "@/lib/api/inbox";
import { agentHref, runHref } from "@/lib/runs/hrefs";
import { workItemHref } from "@/components/work-items/work-item-links";

/** A step that leads somewhere rather than deciding: a link, or the PRD sheet. */
export type InboxStep = "open_pr" | "view_prd" | "open_work_item" | "open_run" | "open_agent";

/**
 * `primary` (lavender) for the one thing to do next, `outline` for the other ways forward,
 * `ghost` for Dismiss and Snooze (they only take the item out of the Inbox).
 */
export type InboxCtaVariant = "primary" | "outline" | "ghost";

/** One decision on an Inbox item: a labeled button that posts its action (Design rule 6). */
export interface InboxDecision {
  type: "decision";
  action: InboxAction;
  label: string;
  variant: InboxCtaVariant;
}

/** A link from the item: its PR/MR (a new tab), work item, run or agent. */
export interface InboxLink {
  type: "link";
  step: Exclude<InboxStep, "view_prd">;
  label: string;
  href: string;
  /** Opens in a new tab (the code host). */
  external: boolean;
  variant: InboxCtaVariant;
}

/** View PRD: the PRD in a sheet over the Inbox (`ViewPrdSheet`), no navigation. */
export interface InboxPrd {
  type: "prd";
  step: "view_prd";
  label: string;
  runId: string;
  workItem: { id: string; identifier: string };
  variant: InboxCtaVariant;
}

/** What an Inbox item offers, in order: the next thing to do first. */
export type InboxCta = InboxDecision | InboxLink | InboxPrd;

type Kind = InboxItem["kind"];
type Slot = InboxAction | InboxStep;

/**
 * Each kind's calls to action, in order. The first is what's next: the item's lead step
 * when it has one (a PR/MR to review, a PRD to read, an agent to fix), else its clearing
 * decision. Dismiss and Snooze come last.
 */
const SLOTS: Record<Kind, readonly Slot[]> = {
  manual_story: ["done", "skip", "view_prd", "snooze"],
  blocked_epic: ["start_anyway", "view_prd", "done", "snooze"],
  broken_relations: ["open_run", "view_prd", "done", "snooze"],
  question: ["answer", "view_prd", "done", "snooze"],
  stopped_epic: ["resume", "open_run", "view_prd", "done", "snooze"],
  prd_ready: ["view_prd", "open_work_item", "done", "snooze"],
  pr_waiting: ["open_pr", "view_prd", "done", "snooze"],
  failed_run: ["retry", "open_run", "view_prd", "done", "snooze"],
  failed_system: ["retry", "done", "snooze"],
  agent_offline: ["open_agent", "done", "snooze"],
  agent_update_failed: ["open_agent", "done", "snooze"],
  run: ["view_prd", "open_run"],
};

/** The step that is what's next for the kind (primary); others lead with a decision. */
const LEAD_STEP: Partial<Record<Kind, InboxStep>> = {
  broken_relations: "open_run",
  prd_ready: "view_prd",
  pr_waiting: "open_pr",
  agent_offline: "open_agent",
  agent_update_failed: "open_agent",
};

/** Kinds with nothing to decide: every call to action is secondary (Running). */
const NO_PRIMARY: ReadonlySet<Kind> = new Set(["run"]);

function decisionLabel(kind: Kind, action: InboxAction): string {
  switch (action) {
    case "done":
      return kind === "manual_story" ? "Done, resume epic" : "Dismiss";
    case "skip":
      return "Skip story";
    case "snooze":
      return "Snooze";
    case "answer":
      return "Send answer";
    case "start_anyway":
      return "Start anyway";
    case "resume":
      return "Resume";
    case "retry":
      return "Retry";
  }
}

/** The work item whose PRD View PRD opens: a manual story's epic, else the item's own. */
export function prdWorkItem(
  item: Pick<InboxItem, "kind" | "workItem" | "epic">,
): { id: string; identifier: string } | null {
  const workItem = item.kind === "manual_story" ? item.epic : item.workItem;
  return workItem ? { id: workItem.id, identifier: workItem.identifier } : null;
}

type Unstyled<T> = T extends InboxCta ? Omit<T, "variant"> : never;

/** The slot as a call to action, or null when the item can't offer it. */
function ctaOf(item: InboxItem, slot: Slot): Unstyled<InboxCta> | null {
  switch (slot) {
    case "open_pr": {
      const url = item.pullRequest?.url;
      if (!url) return null;
      const gitlab = (item.pullRequest?.provider ?? item.repository?.provider) === "gitlab";
      return {
        type: "link",
        step: slot,
        label: gitlab ? "Open MR" : "Open PR",
        href: url,
        external: true,
      };
    }
    case "view_prd": {
      const workItem = prdWorkItem(item);
      if (!workItem || !item.run) return null;
      return {
        type: "prd",
        step: slot,
        label: item.kind === "prd_ready" ? "Review PRD" : "View PRD",
        runId: item.run.id,
        workItem,
      };
    }
    case "open_work_item":
      return item.workItem
        ? {
            type: "link",
            step: slot,
            label: "Open work item",
            href: workItemHref(item.workItem.id),
            external: false,
          }
        : null;
    case "open_run":
      return item.run
        ? {
            type: "link",
            step: slot,
            label: "Open run",
            href: runHref(item.run.id),
            external: false,
          }
        : null;
    case "open_agent":
      return item.agent
        ? {
            type: "link",
            step: slot,
            label: "Open agent",
            href: agentHref(item.agent.id),
            external: false,
          }
        : null;
    default:
      return item.actions.includes(slot)
        ? { type: "decision", action: slot, label: decisionLabel(item.kind, slot) }
        : null;
  }
}

const isDemoted = (cta: Unstyled<InboxCta>) =>
  cta.type === "decision" && (cta.action === "done" || cta.action === "snooze");

/**
 * The item's calls to action, in order (`SLOTS`), only those it can offer. The primary,
 * always first, is the kind's lead step when the item has it (its PR/MR's URL, its agent…),
 * else its first decision; Running has none. Dismiss and Snooze are `ghost` unless one of
 * them is the primary.
 */
export function inboxCtas(item: InboxItem): InboxCta[] {
  const ctas = SLOTS[item.kind].flatMap((slot) => {
    const cta = ctaOf(item, slot);
    return cta ? [cta] : [];
  });
  const lead = LEAD_STEP[item.kind];
  const leadIndex = ctas.findIndex((cta) => cta.type !== "decision" && cta.step === lead);
  const chosen =
    leadIndex >= 0 || NO_PRIMARY.has(item.kind)
      ? leadIndex
      : ctas.findIndex((cta) => cta.type === "decision");
  const styled = ctas.map(
    (cta, index) =>
      ({
        ...cta,
        variant: index === chosen ? "primary" : isDemoted(cta) ? "ghost" : "outline",
      }) as InboxCta,
  );
  // What's next always comes first.
  return chosen > 0 ? [styled[chosen]!, ...styled.filter((_, i) => i !== chosen)] : styled;
}

/** The item's decisions alone (what posts an action), in `inboxCtas` order. */
export function inboxDecisions(item: InboxItem): InboxDecision[] {
  return inboxCtas(item).filter((cta): cta is InboxDecision => cta.type === "decision");
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
