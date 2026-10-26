import type { NavItem } from "@omniralph/ui";
import {
  IconGitFork,
  IconInbox,
  IconLayoutList,
  IconPlayerPlay,
  IconServer2,
  IconSettings,
} from "@tabler/icons-react";
import type { BacklogCounts } from "@/lib/api/backlog";
import type { InboxCountsResponse } from "@/lib/api/inbox";

/**
 * The 2.0 navigation (`AppFrame` from `@omniralph/ui`). Each entry points at its 2.0 URL,
 * never an old one kept for compatibility: Runs points at `/runs` (every run of every
 * kind), Repos at `/repos` (every repo's settings), the other entries at today's pages
 * until their epics replace them (TOOL-575, "Coexistence with today's pages"); every entry
 * is visible to members and admins. Runs lights up for `/runs/**` only, Repos for
 * `/repos/**` only. Analytics (its own entry in Epic 10) has no entry and
 * stays reachable by URL; the other Settings pages light up Settings.
 *
 * Settings points at `/settings` (its section list on phone, General beside the section nav
 * when wide) and lights up for every `/settings/**` page, today's included.
 *
 * Inbox comes first (a phone tab), then Runs and Backlog (`/backlog/**`, work that hasn't
 * started; phone tabs); Ask (bottom, a phone tab) is added by Epic 9 with its page. The
 * live indicators come from `withNavIndicators`.
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
    id: "agents",
    label: "Agents",
    href: "/agents",
    icon: IconServer2,
    placement: "main",
    phone: "drawer",
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

/**
 * The entries with their live indicators: from the Inbox counts (`useInboxCounts`), Inbox
 * counts what needs the user ("{n} need you") and Runs shows a mint dot while runs run
 * ("{n} running"); from the Backlog counts (`useBacklogCounts`), Backlog shows its items as
 * a neutral count ("{n} items", never lavender, Design rule 15; full sidebar only). None
 * shows at 0, nor before its counts load.
 */
export function withNavIndicators(
  items: readonly NavItem[],
  counts: InboxCountsResponse | undefined,
  backlog?: BacklogCounts,
): readonly NavItem[] {
  if (!counts && !backlog) return items;
  return items.map((item) => {
    if (item.id === "inbox" && counts && counts.needsYou > 0) {
      return {
        ...item,
        indicator: { kind: "count", value: counts.needsYou, label: `${counts.needsYou} need you` },
      };
    }
    if (item.id === "runs" && counts && counts.running > 0) {
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
    return item;
  });
}
