"use client";

import { usePathname, useRouter } from "next/navigation";
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
  IconGitPullRequest,
  IconHistory,
  IconListCheck,
  IconMessageCircleUser,
  IconPlugConnected,
  IconRepeat,
  IconServer,
  IconServerCog,
} from "@tabler/icons-react";
import { isNavItemActive, navGroupsForRole, type NavIcon } from "@/lib/navigation";
import { userDisplayName, userInitials } from "@/lib/user-display";
import { useCurrentUser } from "./current-user";
import { OrganizationSwitcher, type OrganizationOption } from "./organization-switcher";

export type { OrganizationOption };

const navIcons: Record<NavIcon, React.ElementType> = {
  repositories: IconGitPullRequest,
  reviews: IconHistory,
  ralph: IconRepeat,
  agents: IconServer,
  jobs: IconListCheck,
  analytics: IconChartBar,
  organization: IconBuildingCommunity,
  profiles: IconAdjustments,
  integrations: IconPlugConnected,
  agentSettings: IconServerCog,
  chatAccounts: IconMessageCircleUser,
};

export function AppSidebar({ organizations }: { organizations: OrganizationOption[] }) {
  const pathname = usePathname();
  const router = useRouter();
  const { collapsed } = useSidebar();
  const user = useCurrentUser();

  return (
    <SidebarRoot>
      {!collapsed && (
        <SidebarHeader
          style={{
            height: 52,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 12px",
            borderBottom: "1px solid var(--border-subtle)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
            <div
              style={{
                width: 24,
                height: 24,
                borderRadius: "var(--radius-sm)",
                background: "linear-gradient(135deg, var(--glacier-500), var(--glacier-700))",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--bg-page)",
                  fontWeight: 600,
                }}
              >
                O
              </span>
            </div>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
                color: "var(--glacier-300)",
                letterSpacing: ".12em",
              }}
            >
              OMNIRALPH
            </span>
          </div>
          <SidebarTrigger />
        </SidebarHeader>
      )}

      <SidebarContent>
        {collapsed && <SidebarTrigger style={{ margin: "var(--space-2) auto" }} />}

        <div
          style={{ padding: collapsed ? "var(--space-1) 0" : "var(--space-2) var(--space-2) 0" }}
        >
          <OrganizationSwitcher organizations={organizations} collapsed={collapsed} />
        </div>

        {navGroupsForRole(user.role).map((group) => (
          <SidebarGroup key={group.label} label={group.label}>
            {group.items.map(({ href, label, icon }) => {
              const Icon = navIcons[icon];
              return (
                <SidebarItem
                  key={href}
                  icon={<Icon size={16} />}
                  label={label}
                  active={isNavItemActive(href, pathname)}
                  onClick={() => router.push(href)}
                />
              );
            })}
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter
        style={{
          padding: "var(--space-3)",
          borderTop: "1px solid var(--border-subtle)",
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
        }}
      >
        <Avatar style={{ width: 28, height: 28, flexShrink: 0 }}>
          {user.image && <AvatarImage src={user.image} alt="" />}
          <AvatarFallback
            style={{ fontSize: 11, background: "var(--bg-raised)", color: "var(--text-secondary)" }}
          >
            {userInitials(user)}
          </AvatarFallback>
        </Avatar>
        {!collapsed && (
          <div style={{ overflow: "hidden", flex: 1 }}>
            <div
              style={{
                fontSize: "var(--text-sm)",
                color: "var(--text-primary)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {userDisplayName(user)}
            </div>
            <div
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--text-tertiary)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {user.role === "admin" ? "Admin" : "Member"}
            </div>
          </div>
        )}
      </SidebarFooter>
    </SidebarRoot>
  );
}
