import type { Role } from "@/lib/auth/roles";

export type NavIcon =
  | "repositories"
  | "reviews"
  | "ralph"
  | "harnesses"
  | "jobs"
  | "analytics"
  | "organization"
  | "agents"
  | "tasks"
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

/** Sidebar navigation. Harnesses and Jobs serve every task type. */
export const navGroups: NavGroup[] = [
  {
    label: "Navigation",
    items: [
      { href: "/repositories", label: "Repositories", icon: "repositories" },
      { href: "/reviews", label: "Reviews", icon: "reviews" },
      { href: "/ralph", label: "Ralph runs", icon: "ralph" },
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
      { href: "/settings/profiles", label: "Profiles", icon: "profiles", adminOnly: true },
      {
        href: "/settings/integrations",
        label: "Integrations",
        icon: "integrations",
        adminOnly: true,
      },
      {
        href: "/settings/harnesses",
        label: "Harnesses",
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
