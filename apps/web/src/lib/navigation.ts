import type { Role } from "@/lib/auth/roles";

export type NavIcon =
  | "repositories"
  | "reviews"
  | "ralph"
  | "agents"
  | "jobs"
  | "analytics"
  | "users"
  | "profiles"
  | "integrations"
  | "agentSettings";

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

/** Sidebar navigation. Capability-agnostic: Agents and Jobs serve every capability. */
export const navGroups: NavGroup[] = [
  {
    label: "Navigation",
    items: [
      { href: "/repositories", label: "Repositories", icon: "repositories" },
      { href: "/reviews", label: "Reviews", icon: "reviews" },
      { href: "/ralph", label: "Ralph runs", icon: "ralph" },
      { href: "/agents", label: "Agents", icon: "agents" },
      { href: "/jobs", label: "Jobs", icon: "jobs" },
      { href: "/analytics", label: "Analytics", icon: "analytics" },
    ],
  },
  {
    label: "Admin",
    items: [
      { href: "/admin/users", label: "Users", icon: "users", adminOnly: true },
      { href: "/settings/profiles", label: "Profiles", icon: "profiles", adminOnly: true },
      {
        href: "/settings/integrations",
        label: "Integrations",
        icon: "integrations",
        adminOnly: true,
      },
      {
        href: "/settings/agents",
        label: "Agent settings",
        icon: "agentSettings",
        adminOnly: true,
      },
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
