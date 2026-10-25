import type { NavItem } from "@omniralph/ui";
import { IconGitFork, IconPlayerPlay, IconServer2, IconSettings } from "@tabler/icons-react";

/**
 * The 2.0 navigation (`AppFrame` from `@omniralph/ui`). Each entry points at today's closest
 * page until the epic that replaces it repoints or replaces the entry (TOOL-575,
 * "Coexistence with today's pages"); every entry is visible to members and admins.
 * Reviews, Triage, Jobs, Analytics and the other Settings pages have no entry of their
 * own: they light up Runs or Settings and stay reachable by URL and their in-page tabs.
 *
 * Inbox (first, a phone tab), Backlog (after Runs, a phone tab) and Ask (bottom, a phone
 * tab) are added by Epics 5, 8 and 9 with their pages.
 */
export const navItems: readonly NavItem[] = [
  {
    // The old Coding pages redirect to /runs, which has no page yet: Reviews stands in.
    id: "runs",
    label: "Runs",
    href: "/reviews",
    icon: IconPlayerPlay,
    placement: "main",
    phone: "tab",
    activeFor: ["/runs", "/triage", "/jobs", "/analytics"],
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
    // Epic 4 renames the route to /agents.
    id: "fleet",
    label: "Fleet",
    href: "/harnesses",
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
