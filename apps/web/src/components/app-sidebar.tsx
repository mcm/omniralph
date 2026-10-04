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
} from "@iamthemcmaster/ui";
import { IconGitPullRequest, IconListCheck, IconServer, IconShieldLock } from "@tabler/icons-react";
import { isNavItemActive, navGroups, type NavIcon } from "@/lib/navigation";

const navIcons: Record<NavIcon, React.ElementType> = {
  repositories: IconGitPullRequest,
  agents: IconServer,
  jobs: IconListCheck,
  admin: IconShieldLock,
};

export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { collapsed } = useSidebar();

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

        {navGroups.map((group) => (
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
          <AvatarFallback
            style={{ fontSize: 11, background: "var(--bg-raised)", color: "var(--text-secondary)" }}
          >
            ?
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
              Guest
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
              Not signed in
            </div>
          </div>
        )}
      </SidebarFooter>
    </SidebarRoot>
  );
}
