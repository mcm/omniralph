"use client";

import * as React from "react";
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
  cn,
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
import { Link } from "./link";

/** A breadcrumb; `href` only when the crumb has a page of its own. */
export interface Crumb {
  label: string;
  href?: string;
}

interface AppHeaderProps {
  /** Starts with the sidebar entry that is active for this page. */
  breadcrumbs?: Crumb[];
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
  const name = userDisplayName(user);
  return (
    <header className="app-header">
      <div className="app-header-start">
        {/* Below 768px the sidebar is a sheet; this opens it. */}
        {isMobile && <SidebarTrigger className="shrink-0" />}
        {breadcrumbs.length > 0 && <HeaderBreadcrumbs crumbs={breadcrumbs} />}
      </div>

      <div className="app-header-end">
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
          title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
          onClick={toggle}
        >
          {theme === "light" ? <IconMoon size={16} /> : <IconSun size={16} />}
        </Button>

        <div className="app-header-divider" aria-hidden="true" />

        {/* User menu. Below 768px the name is hidden and the avatar alone opens it. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="app-header-user"
              aria-label={`Account menu for ${name}`}
            >
              <Avatar className="app-header-avatar">
                {user.image && <AvatarImage src={user.image} alt="" />}
                <AvatarFallback>{userInitials(user)}</AvatarFallback>
              </Avatar>
              <span className="app-header-user-name">{name}</span>
              <IconChevronDown size={12} className="app-header-chevron" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="app-header-menu">
            <DropdownMenuLabel>
              <div className="app-header-menu-name">{name}</div>
              {user.email && <div className="app-header-menu-email">{user.email}</div>}
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

/**
 * One line of crumbs that never wraps: every label truncates, and below 768px the middle
 * crumbs collapse into an ellipsis (globals.css). Parents without a page are plain text.
 */
function HeaderBreadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  const last = crumbs.length - 1;
  // Only a current page longer than the width it is guaranteed on phone (9ch) reserves
  // it; a short one ("Rules") takes its own width and leaves the rest to its parents.
  const longCurrent = (crumbs[last]?.label.length ?? 0) > 9;
  return (
    <Breadcrumb className="app-crumbs">
      <BreadcrumbList className="app-crumbs-list">
        {crumbs.map((crumb, i) => {
          const middle = i > 0 && i < last;
          return (
            <React.Fragment key={i}>
              {i === 1 && last > 1 && (
                <>
                  <BreadcrumbItem className="app-crumb-ellipsis">
                    <BreadcrumbEllipsis className="app-crumb-ellipsis-icon" />
                  </BreadcrumbItem>
                  <BreadcrumbSeparator className="app-crumb-ellipsis" />
                </>
              )}
              <BreadcrumbItem
                className={cn(
                  "app-crumb",
                  middle && "app-crumb-middle",
                  i === last && longCurrent && "app-crumb-long",
                )}
              >
                {i === last ? (
                  <BreadcrumbPage className="app-crumb-label">{crumb.label}</BreadcrumbPage>
                ) : crumb.href ? (
                  <BreadcrumbLink asChild className="app-crumb-label">
                    <Link href={crumb.href}>{crumb.label}</Link>
                  </BreadcrumbLink>
                ) : (
                  <span className="app-crumb-label">{crumb.label}</span>
                )}
              </BreadcrumbItem>
              {i < last && (
                <BreadcrumbSeparator className={middle ? "app-crumb-middle" : undefined} />
              )}
            </React.Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
