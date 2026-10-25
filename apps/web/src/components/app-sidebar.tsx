"use client";

import { Link } from "./link";
import { usePathname } from "next/navigation";
import {
  SidebarRoot,
  SidebarHeader,
  SidebarContent,
  SidebarGroup,
  SidebarItem,
  SidebarFooter,
  SidebarTrigger,
  useSidebar,
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@iamthemcmaster/ui";
import {
  IconAdjustments,
  IconBuildingCommunity,
  IconChartBar,
  IconClipboardText,
  IconGitPullRequest,
  IconHistory,
  IconListCheck,
  IconMessageCircleUser,
  IconPlugConnected,
  IconRobot,
  IconRoute,
  IconServer,
  IconSettingsAutomation,
  IconSubtask,
} from "@tabler/icons-react";
import { isNavItemActive, navGroupsForRole, type NavIcon } from "@/lib/navigation";
import { userDisplayName, userInitials } from "@/lib/user-display";
import { useCurrentUser } from "./current-user";
import { OrganizationPicker } from "./organization-picker";

const navIcons: Record<NavIcon, React.ElementType> = {
  repositories: IconGitPullRequest,
  reviews: IconHistory,
  triage: IconClipboardText,
  harnesses: IconServer,
  jobs: IconListCheck,
  analytics: IconChartBar,
  organization: IconBuildingCommunity,
  agents: IconRobot,
  tasks: IconSubtask,
  routing: IconRoute,
  profiles: IconAdjustments,
  integrations: IconPlugConnected,
  harnessSettings: IconSettingsAutomation,
  chatAccounts: IconMessageCircleUser,
};

export function AppSidebar() {
  const pathname = usePathname();
  const { collapsed } = useSidebar();
  const user = useCurrentUser();

  return (
    <SidebarRoot>
      {!collapsed && (
        <SidebarHeader className="sidebar-header">
          <div className="sidebar-brand">
            <div className="sidebar-brand-mark">
              <span className="font-mono font-semibold text-ui-xs text-accent-fg">O</span>
            </div>
            <span className="sidebar-brand-name">OMNIRALPH</span>
          </div>
          <SidebarTrigger />
        </SidebarHeader>
      )}

      <SidebarContent>
        {collapsed && <SidebarTrigger className="mx-auto my-2" />}

        {navGroupsForRole(user.role).map((group) => (
          <SidebarGroup key={group.label} label={group.label}>
            {group.items.map(({ href, label, icon }) => {
              const Icon = navIcons[icon];
              return (
                <SidebarItem
                  key={href}
                  asChild
                  icon={<Icon size={16} />}
                  active={isNavItemActive(href, pathname)}
                >
                  <Link href={href}>{label}</Link>
                </SidebarItem>
              );
            })}
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter
        className={collapsed ? "sidebar-footer sidebar-footer-collapsed" : "sidebar-footer"}
      >
        <OrganizationPicker />
        <div className="sidebar-user">
          <Avatar className="sidebar-avatar">
            {user.image && <AvatarImage src={user.image} alt="" />}
            <AvatarFallback className="sidebar-avatar-fallback">
              {userInitials(user)}
            </AvatarFallback>
          </Avatar>
          {!collapsed && (
            <div className="min-w-0 flex-1 overflow-hidden">
              <div className="truncate text-sm text-text-primary">{userDisplayName(user)}</div>
              <div className="truncate text-xs text-text-tertiary">
                {user.role === "admin" ? "Admin" : "Member"}
              </div>
            </div>
          )}
        </div>
      </SidebarFooter>
    </SidebarRoot>
  );
}
