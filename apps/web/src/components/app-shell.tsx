"use client";

import { SidebarProvider, SonnerToaster, TooltipProvider } from "@iamthemcmaster/ui";
import { AppSidebar, type OrganizationOption } from "./app-sidebar";
import { CurrentUserProvider, type SessionUser } from "./current-user";
import { OrganizationGuard } from "./organization-guard";
import { QueryProvider } from "./query-provider";
import { UnsavedChangesBar, UnsavedChangesProvider } from "./unsaved-changes";

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
      {/* Live data for every page (src/lib/api, README "Data fetching"). */}
      <QueryProvider organizationId={user.organization.id}>
        <OrganizationGuard
          organizationName={user.organization.name}
          renderedCookie={organizationCookie}
        >
          <TooltipProvider>
            {/* No AuroraField: this shell wraps the data surfaces, which sit on a flat page
            (DESIGN.md). Below 768px the sidebar is the library's navigation sheet, opened
            from the trigger in AppHeader. */}
            <UnsavedChangesProvider>
              <SidebarProvider>
                <div className="app-shell flex">
                  <AppSidebar organizations={organizations} />
                  <div className="flex flex-1 flex-col min-w-0">
                    {children}
                    <UnsavedChangesBar />
                  </div>
                </div>
              </SidebarProvider>
            </UnsavedChangesProvider>
            <SonnerToaster position="bottom-right" />
          </TooltipProvider>
        </OrganizationGuard>
      </QueryProvider>
    </CurrentUserProvider>
  );
}
