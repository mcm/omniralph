"use client";

import { Toaster, UiProvider, type ThemePreference } from "@omniralph/ui";
import { usePathname } from "next/navigation";
import * as React from "react";
import { navItems } from "@/lib/navigation";
import { userDisplayName, userInitials } from "@/lib/user-display";
import { AskContextProvider } from "./ask/ask-context";
import { isAskFullScreenPath } from "./ask/ask-pages";
import { AskPanel, AskPanelProvider, useAskPanel, withAskEntry } from "./ask/ask-panel";
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
import { SearchProvider, useSearch } from "./search/search-palette";
import { ShowAdvancedProvider } from "./show-advanced";
import { UserMenu } from "./user-menu";

/**
 * The signed-in app: the 2.0 frame from `@omniralph/ui` (sidebar, icon rail, phone top bar,
 * tab bar and drawer) around the page, with the session, live data, the saved theme and
 * toasts. One `OrganizationPicker` and one `UserMenu` serve every place the frame shows them.
 * On desktop the Ask entry opens the Ask panel beside the page (`AskPanelProvider`); this
 * layout persists across client-side navigation, so the panel does too. On a phone, New chat
 * and a chat (`/ask/new`, `/ask/{id}`) open full screen, without the tab bar. Search and
 * jump (`SearchProvider`) opens from the frame's search buttons or ⌘K / Ctrl+K.
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
                    <AskContextProvider>
                      <AskPanelProvider>
                        <SearchProvider>
                          <AskFrame
                            currentPath={pathname}
                            hideTabBar={isAskFullScreenPath(pathname)}
                            brandHref="/"
                            nav={navItems}
                            orgPicker={<OrganizationPicker />}
                            user={{
                              name,
                              image: user.image ?? undefined,
                              initials: userInitials(user),
                            }}
                            userMenu={(trigger) => <UserMenu trigger={trigger} />}
                          >
                            <LiveNoticeSlot />
                            {children}
                          </AskFrame>
                        </SearchProvider>
                      </AskPanelProvider>
                    </AskContextProvider>
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

/**
 * The live frame with the Ask entry wired to the panel, the panel beside the page while
 * open, and the search buttons opening the search palette.
 */
function AskFrame({ nav, ...props }: React.ComponentProps<typeof LiveAppFrame>) {
  const panel = useAskPanel();
  const { open, toggle } = panel;
  const { openSearch } = useSearch();
  const items = React.useMemo(() => withAskEntry(nav, { open, toggle }), [nav, open, toggle]);
  const search = React.useMemo(() => ({ onOpen: openSearch }), [openSearch]);
  return (
    <LiveAppFrame {...props} nav={items} search={search} aside={open ? <AskPanel /> : undefined} />
  );
}
