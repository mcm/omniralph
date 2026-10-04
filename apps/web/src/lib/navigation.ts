import type { Role } from "@/lib/auth/roles";

export type NavIcon = "repositories" | "agents" | "jobs" | "users";

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
      { href: "/agents", label: "Agents", icon: "agents" },
      { href: "/jobs", label: "Jobs", icon: "jobs" },
    ],
  },
  {
    label: "Admin",
    items: [{ href: "/admin/users", label: "Users", icon: "users", adminOnly: true }],
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
