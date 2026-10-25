import type { NavItem } from "@omniralph/ui";
import { IconGitFork, IconPlayerPlay, IconServer2, IconSettings } from "@tabler/icons-react";

/**
 * The 2.0 navigation (`AppFrame` from `@omniralph/ui`). Each entry points at its 2.0 URL,
 * never an old one kept for compatibility: Runs points at `/runs`, which Epic 5 builds, and
 * the other entries at today's pages until their epics replace them (TOOL-575,
 * "Coexistence with today's pages"); every entry is visible to members and admins.
 * Reviews, Triage, Jobs, Analytics and the other Settings pages have no entry of their
 * own: they light up Runs or Settings and stay reachable by URL and their in-page tabs.
 *
 * Inbox (first, a phone tab), Backlog (after Runs, a phone tab) and Ask (bottom, a phone
 * tab) are added by Epics 5, 8 and 9 with their pages.
 */
export const navItems: readonly NavItem[] = [
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
