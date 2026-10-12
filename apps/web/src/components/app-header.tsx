"use client";

import * as React from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
  Cluster,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Avatar,
  AvatarFallback,
  AvatarImage,
  SidebarTrigger,
  notify,
  useSidebar,
} from "@iamthemcmaster/ui";
import { IconChevronDown, IconSun, IconMoon, IconLogout } from "@tabler/icons-react";
import { signOutAction } from "@/lib/auth/actions";
import type { Theme } from "@/lib/theme";
import { saveThemePreference } from "@/lib/theme-actions";
import { userDisplayName, userInitials } from "@/lib/user-display";
import { useCurrentUser } from "./current-user";

interface AppHeaderProps {
  breadcrumbs?: { label: string; href?: string }[];
}

// The theme lives on <html data-theme> (rendered from the user's saved theme,
// or set before paint by the bootstrap script in layout.tsx), so subscribe to that attribute instead of copying it
// into state.
function subscribeToTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

// Polar Night (dark) is the library's default: anything but "light" is dark.
function readTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

function useTheme() {
  const theme = React.useSyncExternalStore<Theme>(subscribeToTheme, readTheme, () => "dark");

  const toggle = React.useCallback(() => {
    const next = readTheme() === "light" ? "dark" : "light";
    const root = document.documentElement;
    // Opts into the library's body cross-fade for this switch only (not on page load).
    root.setAttribute("data-theme-transition", "");
    root.setAttribute("data-theme", next);
    // Saved server-side so the choice follows the user across reloads and devices.
    void saveThemePreference(next).then(
      (result) => {
        if (!result.ok) notify(result.error, { variant: "danger" });
      },
      () => notify("Couldn't save your theme preference.", { variant: "danger" }),
    );
  }, []);

  return { theme, toggle };
}

export function AppHeader({ breadcrumbs = [] }: AppHeaderProps) {
  const { theme, toggle } = useTheme();
  const user = useCurrentUser();
  const { isMobile } = useSidebar();
  const [signingOut, startSignOut] = React.useTransition();
  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: "var(--z-sticky)",
        height: 52,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 var(--space-6)",
        background: "color-mix(in srgb, var(--bg-page) 88%, transparent)",
        backdropFilter: "blur(12px)",
        borderBottom: "1px solid var(--border-subtle)",
        flexShrink: 0,
      }}
    >
      <Cluster gap={2} className="min-w-0">
        {/* Below 768px the sidebar is a sheet; this opens it. */}
        {isMobile && <SidebarTrigger />}
        {breadcrumbs.length > 0 && (
          <Breadcrumb>
            <BreadcrumbList>
              {breadcrumbs.map((crumb, i) => (
                <React.Fragment key={i}>
                  <BreadcrumbItem>
                    {i < breadcrumbs.length - 1 ? (
                      <BreadcrumbLink href={crumb.href ?? "#"}>{crumb.label}</BreadcrumbLink>
                    ) : (
                      <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                    )}
                  </BreadcrumbItem>
                  {i < breadcrumbs.length - 1 && <BreadcrumbSeparator />}
                </React.Fragment>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
        )}
      </Cluster>

      {/* Right controls */}
      <div
        style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginLeft: "auto" }}
      >
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
          title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
          onClick={toggle}
        >
          {theme === "light" ? <IconMoon size={16} /> : <IconSun size={16} />}
        </Button>

        <div
          style={{
            width: 1,
            height: 20,
            background: "var(--border-subtle)",
            margin: "0 var(--space-1)",
          }}
        />

        {/* User menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              style={{ gap: "var(--space-2)", paddingRight: "var(--space-2)" }}
            >
              <Avatar style={{ width: 24, height: 24 }}>
                {user.image && <AvatarImage src={user.image} alt="" />}
                <AvatarFallback
                  style={{
                    fontSize: 10,
                    background: "var(--bg-raised)",
                    color: "var(--text-secondary)",
                  }}
                >
                  {userInitials(user)}
                </AvatarFallback>
              </Avatar>
              <span style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
                {userDisplayName(user)}
              </span>
              <IconChevronDown size={12} style={{ color: "var(--text-tertiary)" }} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" style={{ minWidth: 200 }}>
            <DropdownMenuLabel>
              <div style={{ color: "var(--text-primary)" }}>{userDisplayName(user)}</div>
              {user.email && (
                <div
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--text-tertiary)",
                    fontFamily: "var(--font-mono)",
                    fontWeight: "normal",
                  }}
                >
                  {user.email}
                </div>
              )}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={signingOut}
              onSelect={() => startSignOut(() => signOutAction())}
            >
              <IconLogout size={14} />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
