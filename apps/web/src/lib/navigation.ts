import type { Role } from "@/lib/auth/roles";

export type NavIcon =
  | "repositories"
  | "reviews"
  | "ralph"
  | "triage"
  | "harnesses"
  | "jobs"
  | "analytics"
  | "organization"
  | "agents"
  | "tasks"
  | "routing"
  | "profiles"
  | "integrations"
  | "chatAccounts"
  | "harnessSettings";

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
  /** Hidden from members. */
  adminOnly?: boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * Sidebar navigation: what the fleet works on and did, then how it is configured. Harnesses and
 * Jobs serve every task type. Every label is unique, and a page's breadcrumbs start with the
 * label of the entry that is active for it, so each page names where it sits in the sidebar.
 */
export const navGroups: NavGroup[] = [
  {
    label: "Operations",
    items: [
      { href: "/repositories", label: "Repositories", icon: "repositories" },
      { href: "/reviews", label: "Reviews", icon: "reviews" },
      { href: "/coding", label: "Coding tasks", icon: "ralph" },
      { href: "/triage", label: "Triage", icon: "triage" },
      { href: "/harnesses", label: "Harnesses", icon: "harnesses" },
      { href: "/jobs", label: "Jobs", icon: "jobs" },
      { href: "/analytics", label: "Analytics", icon: "analytics" },
    ],
  },
  {
    label: "Settings",
    items: [
      { href: "/settings/organization", label: "Organization", icon: "organization" },
      { href: "/settings/agents", label: "Agents", icon: "agents" },
      { href: "/settings/tasks", label: "Tasks", icon: "tasks" },
      { href: "/settings/routing", label: "Routing", icon: "routing" },
      { href: "/settings/profiles", label: "Profiles", icon: "profiles", adminOnly: true },
      {
        href: "/settings/integrations",
        label: "Integrations",
        icon: "integrations",
        adminOnly: true,
      },
      {
        href: "/settings/harnesses",
        label: "Harness defaults",
        icon: "harnessSettings",
        adminOnly: true,
      },
      { href: "/settings/chat-accounts", label: "Chat accounts", icon: "chatAccounts" },
    ],
  },
];

/** True when `pathname` is the nav item's page or one of its sub-pages. */
export function isNavItemActive(href: string, pathname: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Nav groups visible to `role`; groups left without items are dropped. */
export function navGroupsForRole(role: Role): NavGroup[] {
  return navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => role === "admin" || !item.adminOnly),
    }))
    .filter((group) => group.items.length > 0);
}
