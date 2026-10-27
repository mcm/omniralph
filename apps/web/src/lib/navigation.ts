import type { NavItem } from "@omniralph/ui";
import {
  IconChartBar,
  IconGitFork,
  IconInbox,
  IconLayoutList,
  IconPlayerPlay,
  IconServer2,
  IconSettings,
} from "@tabler/icons-react";
import type { BacklogCounts } from "@/lib/api/backlog";
import type { InboxCountsResponse } from "@/lib/api/inbox";
import type { NavIndicators } from "@/lib/api/nav-indicators";

/**
 * The 2.0 navigation (`AppFrame` from `@omniralph/ui`). Each entry points at its 2.0 URL,
 * never an old one kept for compatibility: Runs points at `/runs` (every run of every
 * kind), Repos at `/repos` (every repo's settings), Fleet at `/fleet` (every agent);
 * every entry is visible to members and admins. Runs lights up for `/runs/**` only, Repos
 * for `/repos/**` only, Fleet for `/fleet/**`.
 *
 * The bottom group holds Analytics (`/analytics`, in the phone drawer, no indicator) and then
 * Settings, which points at `/settings` (its section list on phone, General beside the
 * section nav when wide) and lights up for every `/settings/**` page.
 *
 * Inbox comes first (a phone tab), then Runs and Backlog (`/backlog/**`, work that hasn't
 * started; phone tabs); Ask (bottom, before Analytics, a phone tab) is added by Epic 9 with
 * its page. The live indicators come from `withNavIndicators`.
 */
export const navItems: readonly NavItem[] = [
  {
    id: "inbox",
    label: "Inbox",
    href: "/",
    icon: IconInbox,
    placement: "main",
    phone: "tab",
  },
  {
    id: "runs",
    label: "Runs",
    href: "/runs",
    icon: IconPlayerPlay,
    placement: "main",
    phone: "tab",
    activeFor: ["/runs"],
  },
  {
    id: "backlog",
    label: "Backlog",
    href: "/backlog",
    icon: IconLayoutList,
    placement: "main",
    phone: "tab",
    activeFor: ["/backlog"],
  },
  {
    id: "repos",
    label: "Repos",
    href: "/repos",
    icon: IconGitFork,
    placement: "main",
    phone: "drawer",
    activeFor: ["/repos"],
  },
  {
    id: "fleet",
    label: "Fleet",
    href: "/fleet",
    icon: IconServer2,
    placement: "main",
    phone: "drawer",
    activeFor: ["/fleet"],
  },
  {
    id: "analytics",
    label: "Analytics",
    href: "/analytics",
    icon: IconChartBar,
    placement: "bottom",
    phone: "drawer",
    activeFor: ["/analytics"],
  },
  {
    id: "settings",
    label: "Settings",
    href: "/settings",
    icon: IconSettings,
    placement: "bottom",
    phone: "drawer",
    activeFor: ["/settings"],
  },
];

/** "1 agent needs attention", "3 agents need attention". */
export function agentsNeedAttentionLabel(count: number): string {
  return count === 1 ? "1 agent needs attention" : `${count} agents need attention`;
}

/** "1 failed delivery", "3 failed deliveries". */
export function failedDeliveriesLabel(count: number): string {
  return count === 1 ? "1 failed delivery" : `${count} failed deliveries`;
}

/**
 * The entries with their live indicators. From the Inbox counts (`useInboxCounts`): Inbox
 * counts what needs the user ("{n} need you"), Runs shows a mint dot while runs run
 * ("{n} running"). From the Backlog counts (`useBacklogCounts`): Backlog shows its items as
 * a neutral count ("{n} items", never lavender, Design rule 15; full sidebar only). From the
 * nav indicators (`useNavIndicators`): Fleet shows a coral dot while agents of the scope are
 * offline or failed their update ("{n} agents need attention"), Settings while the active
 * organization has failed deliveries not yet replayed ("{n} failed deliveries"). None shows
 * at 0, nor before its counts load.
 */
export function withNavIndicators(
  items: readonly NavItem[],
  counts: InboxCountsResponse | undefined,
  backlog?: BacklogCounts,
  indicators?: NavIndicators,
): readonly NavItem[] {
  if (!counts && !backlog && !indicators) return items;
  return items.map((item): NavItem => {
    if (counts && item.id === "inbox" && counts.needsYou > 0) {
      return {
        ...item,
        indicator: { kind: "count", value: counts.needsYou, label: `${counts.needsYou} need you` },
      };
    }
    if (counts && item.id === "runs" && counts.running > 0) {
      return {
        ...item,
        indicator: { kind: "dot", tone: "run", label: `${counts.running} running` },
      };
    }
    if (item.id === "backlog" && backlog && backlog.total > 0) {
      return {
        ...item,
        indicator: {
          kind: "count",
          tone: "neutral",
          value: backlog.total,
          label: `${backlog.total} ${backlog.total === 1 ? "item" : "items"}`,
        },
      };
    }
    if (indicators && item.id === "fleet") {
      const attention = indicators.fleet.offline + indicators.fleet.updateFailed;
      if (attention > 0) {
        return {
          ...item,
          indicator: { kind: "dot", tone: "fail", label: agentsNeedAttentionLabel(attention) },
        };
      }
    }
    if (indicators && item.id === "settings" && indicators.settings.failedDeliveries > 0) {
      return {
        ...item,
        indicator: {
          kind: "dot",
          tone: "fail",
          label: failedDeliveriesLabel(indicators.settings.failedDeliveries),
        },
      };
    }
    return item;
  });
}
