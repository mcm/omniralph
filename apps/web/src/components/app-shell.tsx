"use client";

import { Toaster, UiProvider, type ThemePreference } from "@omniralph/ui";
import { usePathname } from "next/navigation";
import { navItems } from "@/lib/navigation";
import { userDisplayName, userInitials } from "@/lib/user-display";
import { CurrentUserProvider, type SessionUser } from "./current-user";
import { Link } from "./link";
import { LiveAppFrame } from "./live-app-frame";
import { LiveCurrentUser } from "./live-current-user";
import { LiveNoticeSlot } from "./live/live-notice-slot";
import { LiveProvider } from "./live/live-provider";
import { OrganizationGuard } from "./organization-guard";
import { ALL_ORGANIZATIONS_LABEL, OrganizationPicker } from "./organization-picker";
import { QueryProvider } from "./query-provider";
import { SavedThemeProvider } from "./saved-theme";
import { ShowAdvancedProvider } from "./show-advanced";
import { UserMenu } from "./user-menu";

/**
 * The signed-in app: the 2.0 frame from `@omniralph/ui` (sidebar, icon rail, phone top bar,
 * tab bar and drawer) around the page, with the session, live data, the saved theme and
 * toasts. One `OrganizationPicker` and one `UserMenu` serve every place the frame shows them.
 */
export function AppShell({
  user,
  themePreference,
  organizationCookie,
  scopeCookie,
  showAdvanced,
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
  /** The user's saved "Show advanced settings" preference (see `useShowAdvanced`). */
  showAdvanced: boolean;
  /**
   * The page. Today's pages come wrapped in `app/(app)/legacy-frame.tsx` (the library's
   * tooltips and the unsaved-changes guard and bar) until Epics 5–10 replace them.
   */
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const name = userDisplayName(user);
  return (
    <SavedThemeProvider preference={themePreference}>
      <CurrentUserProvider user={user}>
        <ShowAdvancedProvider initial={showAdvanced}>
          {/* Live data for every page (src/lib/api, src/lib/live, README "Data fetching").
      Keyed by the organization and scope: any change of either starts over with an empty
      cache, subscribed to the new scope's change channels. */}
          <QueryProvider
            key={`${user.organization.id}:${user.scope}`}
            organizationId={user.organization.id}
          >
            <LiveCurrentUser>
              <LiveProvider>
                <OrganizationGuard
                  organizationName={
                    user.scope === "all" ? ALL_ORGANIZATIONS_LABEL : user.organization.name
                  }
                  renderedCookie={organizationCookie}
                  renderedScopeCookie={scopeCookie}
                >
                  <UiProvider linkComponent={Link}>
                    <LiveAppFrame
                      currentPath={pathname}
                      brandHref="/"
                      nav={navItems}
                      orgPicker={<OrganizationPicker />}
                      user={{ name, image: user.image ?? undefined, initials: userInitials(user) }}
                      userMenu={(trigger) => <UserMenu trigger={trigger} />}
                    >
                      <LiveNoticeSlot />
                      {children}
                    </LiveAppFrame>
                    <Toaster />
                  </UiProvider>
                </OrganizationGuard>
              </LiveProvider>
            </LiveCurrentUser>
          </QueryProvider>
        </ShowAdvancedProvider>
      </CurrentUserProvider>
    </SavedThemeProvider>
  );
}
