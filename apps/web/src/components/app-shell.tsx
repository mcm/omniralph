"use client";

import { Toaster, type ThemePreference } from "@omniralph/ui";
import { CurrentUserProvider, type SessionUser } from "./current-user";
import { OrganizationGuard } from "./organization-guard";
import { ALL_ORGANIZATIONS_LABEL } from "./organization-picker";
import { QueryProvider } from "./query-provider";
import { SavedThemeProvider } from "./saved-theme";

export function AppShell({
  user,
  themePreference,
  organizationCookie,
  scopeCookie,
  children,
}: {
  /** The signed-in user, with their organizations and scope (for the organization picker). */
  user: SessionUser;
  /** The user's saved theme preference; System follows the OS as it changes. */
  themePreference: ThemePreference;
  /** The organization cookie this page was rendered with, to notice switches in other tabs. */
  organizationCookie: string | null;
  /** The organization scope cookie this page was rendered with, likewise. */
  scopeCookie: string | null;
  /** The page, in today's frame (`app/(app)/legacy-frame.tsx`) until the shell is rebuilt. */
  children: React.ReactNode;
}) {
  return (
    <SavedThemeProvider preference={themePreference}>
      <CurrentUserProvider user={user}>
        {/* Live data for every page (src/lib/api, README "Data fetching"). Keyed by the
      organization and scope: any change of either starts over with an empty cache. */}
        <QueryProvider
          key={`${user.organization.id}:${user.scope}`}
          organizationId={user.organization.id}
        >
          <OrganizationGuard
            organizationName={
              user.scope === "all" ? ALL_ORGANIZATIONS_LABEL : user.organization.name
            }
            renderedCookie={organizationCookie}
            renderedScopeCookie={scopeCookie}
          >
            {children}
            <Toaster />
          </OrganizationGuard>
        </QueryProvider>
      </CurrentUserProvider>
    </SavedThemeProvider>
  );
}
