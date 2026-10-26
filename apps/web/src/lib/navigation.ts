import type { NavItem } from "@omniralph/ui";
import {
  IconGitFork,
  IconInbox,
  IconPlayerPlay,
  IconServer2,
  IconSettings,
} from "@tabler/icons-react";
import type { InboxCountsResponse } from "@/lib/api/inbox";

/**
 * The 2.0 navigation (`AppFrame` from `@omniralph/ui`). Each entry points at its 2.0 URL,
 * never an old one kept for compatibility: Runs points at `/runs`, which Epic 5 builds, and
 * the other entries at today's pages until their epics replace them (TOOL-575,
 * "Coexistence with today's pages"); every entry is visible to members and admins.
 * Reviews, Triage, Jobs, Analytics and the other Settings pages have no entry of their
 * own: they light up Runs or Settings and stay reachable by URL and their in-page tabs.
 *
 * Inbox comes first (a phone tab); Backlog (after Runs, a phone tab) and Ask (bottom, a
 * phone tab) are added by Epics 8 and 9 with their pages. The live indicators come from
 * `withNavIndicators`.
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
    activeFor: ["/reviews", "/triage", "/jobs", "/analytics"],
  },
  {
    id: "repos",
    label: "Repos",
    href: "/repositories",
    icon: IconGitFork,
    placement: "main",
    phone: "drawer",
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
    href: "/settings/organization",
    icon: IconSettings,
    placement: "bottom",
    phone: "drawer",
    activeFor: ["/settings"],
  },
];

/**
 * The entries with their live indicators from the Inbox counts (`useInboxCounts`): Inbox
 * counts what needs the user ("{n} need you"), Runs shows a mint dot while runs run
 * ("{n} running"). Neither shows at 0, nor before the counts load.
 */
export function withNavIndicators(
  items: readonly NavItem[],
  counts: InboxCountsResponse | undefined,
): readonly NavItem[] {
  if (!counts) return items;
  return items.map((item) => {
    if (item.id === "inbox" && counts.needsYou > 0) {
      return {
        ...item,
        indicator: { kind: "count", value: counts.needsYou, label: `${counts.needsYou} need you` },
      };
    }
    if (item.id === "runs" && counts.running > 0) {
      return {
        ...item,
        indicator: { kind: "dot", tone: "run", label: `${counts.running} running` },
      };
    }
    return item;
  });
}
