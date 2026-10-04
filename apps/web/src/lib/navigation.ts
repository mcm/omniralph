export type NavIcon = "repositories" | "agents" | "jobs" | "admin";

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
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
    label: "Config",
    items: [{ href: "/admin", label: "Admin", icon: "admin" }],
  },
];

/** True when `pathname` is the nav item's page or one of its sub-pages. */
export function isNavItemActive(href: string, pathname: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
