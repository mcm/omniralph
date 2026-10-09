"use client";

import {
  AuroraField,
  SidebarProvider,
  ToastProvider,
  ToastViewport,
  TooltipProvider,
} from "@iamthemcmaster/ui";
import { SonnerToaster } from "@iamthemcmaster/ui";
import { AppSidebar, type OrganizationOption } from "./app-sidebar";
import { CurrentUserProvider, type SessionUser } from "./current-user";
import { OrganizationGuard } from "./organization-guard";

export function AppShell({
  user,
  organizations,
  organizationCookie,
  children,
}: {
  user: SessionUser;
  /** The user's organizations, for the switcher. */
  organizations: OrganizationOption[];
  /** The organization cookie this page was rendered with, to notice switches in other tabs. */
  organizationCookie: string | null;
  children: React.ReactNode;
}) {
  return (
    <CurrentUserProvider user={user}>
      <OrganizationGuard
        organizationName={user.organization.name}
        renderedCookie={organizationCookie}
      >
        <TooltipProvider>
          <ToastProvider>
            <SidebarProvider>
              {/* Ambient identity layer — fixed, non-interactive, sits at z-0.
              Renders nothing under prefers-reduced-motion. Dialed to 0.6 because
              this shell wraps dense data surfaces (tables, charts). */}
              <AuroraField intensity={0.6} />
              {/* The field lives at z-0, so the shell must establish its own
              stacking context above it. */}
              <div style={{ display: "flex", minHeight: "100vh", position: "relative", zIndex: 1 }}>
                <AppSidebar organizations={organizations} />
                <div
                  style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}
                >
                  {children}
                </div>
              </div>
            </SidebarProvider>
            <ToastViewport />
            <SonnerToaster position="bottom-right" richColors />
          </ToastProvider>
        </TooltipProvider>
      </OrganizationGuard>
    </CurrentUserProvider>
  );
}
