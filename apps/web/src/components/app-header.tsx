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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Avatar,
  AvatarFallback,
} from "@iamthemcmaster/ui";
import { IconBell, IconSearch, IconChevronDown, IconSun, IconMoon } from "@tabler/icons-react";

interface AppHeaderProps {
  breadcrumbs?: { label: string; href?: string }[];
}

type Theme = "light" | "dark";

// The theme lives on <html data-theme> (set before paint by the bootstrap
// script in layout.tsx), so subscribe to that attribute instead of copying it
// into state.
function subscribeToTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

function readTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function useTheme() {
  const theme = React.useSyncExternalStore<Theme>(subscribeToTheme, readTheme, () => "light");

  const toggle = React.useCallback(() => {
    const next = readTheme() === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("mcmaster-theme", next);
    } catch {
      /* storage unavailable */
    }
  }, []);

  return { theme, toggle };
}

export function AppHeader({ breadcrumbs = [] }: AppHeaderProps) {
  const { theme, toggle } = useTheme();
  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 30,
        height: 52,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 var(--space-5)",
        background: "color-mix(in srgb, var(--bg-page) 88%, transparent)",
        backdropFilter: "blur(12px)",
        borderBottom: "1px solid var(--border-subtle)",
        flexShrink: 0,
      }}
    >
      {/* Breadcrumbs */}
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

        <Button variant="ghost" size="icon" aria-label="Search">
          <IconSearch size={16} />
        </Button>

        {/* Notification bell with badge */}
        <div style={{ position: "relative" }}>
          <Button variant="ghost" size="icon" aria-label="Notifications">
            <IconBell size={16} />
          </Button>
          <span
            style={{
              position: "absolute",
              top: 6,
              right: 6,
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "var(--glacier-500)",
              border: "2px solid var(--bg-page)",
            }}
          />
        </div>

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
                <AvatarFallback
                  style={{
                    fontSize: 10,
                    background: "var(--bg-raised)",
                    color: "var(--text-secondary)",
                  }}
                >
                  ?
                </AvatarFallback>
              </Avatar>
              <span style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
                Guest
              </span>
              <IconChevronDown size={12} style={{ color: "var(--text-tertiary)" }} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" style={{ minWidth: 180 }}>
            <DropdownMenuLabel>My Account</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled>Sign-in arrives with multi-user auth</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
