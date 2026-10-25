"use client";

import { SidebarProvider, SonnerToaster, TooltipProvider } from "@iamthemcmaster/ui";
import { AppSidebar } from "./app-sidebar";
import { CurrentUserProvider, type SessionUser } from "./current-user";
import { OrganizationGuard } from "./organization-guard";
import { ALL_ORGANIZATIONS_LABEL } from "./organization-picker";
import { QueryProvider } from "./query-provider";
import { UnsavedChangesBar, UnsavedChangesProvider } from "./unsaved-changes";

export function AppShell({
  user,
  organizationCookie,
  scopeCookie,
  children,
}: {
  /** The signed-in user, with their organizations and scope (for the organization picker). */
  user: SessionUser;
  /** The organization cookie this page was rendered with, to notice switches in other tabs. */
  organizationCookie: string | null;
  /** The organization scope cookie this page was rendered with, likewise. */
  scopeCookie: string | null;
  children: React.ReactNode;
}) {
  return (
    <CurrentUserProvider user={user}>
      {/* Live data for every page (src/lib/api, README "Data fetching"). Keyed by the
      organization and scope: any change of either starts over with an empty cache. */}
      <QueryProvider
        key={`${user.organization.id}:${user.scope}`}
        organizationId={user.organization.id}
      >
        <OrganizationGuard
          organizationName={user.scope === "all" ? ALL_ORGANIZATIONS_LABEL : user.organization.name}
          renderedCookie={organizationCookie}
          renderedScopeCookie={scopeCookie}
        >
          <TooltipProvider>
            {/* No AuroraField: this shell wraps the data surfaces, which sit on a flat page
            (DESIGN.md). Below 768px the sidebar is the library's navigation sheet, opened
            from the trigger in AppHeader. */}
            <UnsavedChangesProvider>
              <SidebarProvider>
                <div className="app-shell flex">
                  <AppSidebar />
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
