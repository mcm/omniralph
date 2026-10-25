"use client";

import { ConfirmDialog } from "@omniralph/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import * as React from "react";
import { ApiError } from "@/lib/api/client";
import { ORGANIZATION_SWITCHED } from "@/lib/api/schemas";
import { ORGANIZATION_COOKIE, ORGANIZATION_SCOPE_COOKIE } from "@/lib/auth/routes";

/** A cookie's value as this browser has it now (`null` when absent or empty). */
function deviceCookie(name: string): string | null {
  const prefix = `${name}=`;
  const entry = document.cookie.split("; ").find((cookie) => cookie.startsWith(prefix));
  return entry ? decodeURIComponent(entry.slice(prefix.length)) || null : null;
}

/** Checks for (and blocks the tab after) a switch made in another tab. */
const StaleContext = React.createContext<(() => boolean) | null>(null);
/** Tells the guard this tab is switching itself (until it re-renders in the new organization). */
const SwitchingContext = React.createContext<(() => void) | null>(null);

/**
 * Tabs share one active organization per browser (TOOL-210 would make it per tab), so a
 * switch in one tab leaves the others showing the old one while the server acts on the
 * new one. This notices the switch (the cookie changed since the page rendered) when
 * the tab regains focus, or when a query is refused because the active organization
 * changed (a visible tab polling next to the one that switched), and blocks the tab until
 * it starts over from the dashboard. A change of organization scope ("All organizations"
 * or one organization, its own cookie) counts as a switch too.
 */
export function OrganizationGuard({
  organizationName,
  renderedCookie,
  renderedScopeCookie = null,
  children,
}: {
  /** What the tab shows: the organization's name, or "All organizations". */
  organizationName: string;
  /** The organization cookie the server rendered this page with. */
  renderedCookie: string | null;
  /** The organization scope cookie the server rendered this page with. */
  renderedScopeCookie?: string | null;
  children: React.ReactNode;
}) {
  const router = useRouter();
  // The render found stale; a refreshed layout brings new cookies, which clears it.
  const rendered = `${renderedCookie ?? ""}|${renderedScopeCookie ?? ""}`;
  const [staleRender, setStaleRender] = React.useState<{ cookies: string } | null>(null);
  const stale = staleRender !== null && staleRender.cookies === rendered;
  // This tab switched (the switcher, leaving): the cookie changes before the shell re-renders.
  const switchingHere = React.useRef(false);
  React.useEffect(() => {
    switchingHere.current = false;
  }, [rendered]);
  const expectSwitch = React.useCallback(() => {
    switchingHere.current = true;
  }, []);
  const check = React.useCallback(() => {
    if (switchingHere.current) return false;
    const switched =
      deviceCookie(ORGANIZATION_COOKIE) !== (renderedCookie || null) ||
      deviceCookie(ORGANIZATION_SCOPE_COOKIE) !== (renderedScopeCookie || null);
    setStaleRender(switched ? { cookies: rendered } : null);
    return switched;
  }, [rendered, renderedCookie, renderedScopeCookie]);

  const client = useQueryClient();
  React.useEffect(
    () =>
      client.getQueryCache().subscribe((event) => {
        if (event.type !== "updated" || event.action.type !== "error") return;
        const { error } = event.action;
        if (error instanceof ApiError && error.code === ORGANIZATION_SWITCHED) check();
      }),
    [client, check],
  );

  React.useEffect(() => {
    // `pageshow`: restored from the back/forward cache.
    const events = ["focus", "pageshow", "visibilitychange"] as const;
    for (const event of events) window.addEventListener(event, check);
    return () => {
      for (const event of events) window.removeEventListener(event, check);
    };
  }, [check]);

  return (
    <StaleContext.Provider value={check}>
      <SwitchingContext.Provider value={expectSwitch}>{children}</SwitchingContext.Provider>
      {/* Required: no Cancel and no Escape, the tab must start over. */}
      <ConfirmDialog
        open={stale}
        onOpenChange={() => {}}
        title="You switched organizations in another tab"
        description={`This tab still shows ${organizationName}. Continue from the dashboard so changes aren't made in the wrong organization.`}
        confirmLabel="Go to dashboard"
        cancelLabel={null}
        onConfirm={() => {
          // Like switching here: start over from the dashboard, in the new organization.
          router.push("/");
          router.refresh();
        }}
      />
    </StaleContext.Provider>
  );
}

/**
 * Checks whether this tab is showing an organization another tab has switched away from
 * (and if so, blocks the tab); always `false` outside the app shell, where there's no
 * organization to protect.
 */
export function useIsOrganizationStale(): () => boolean {
  return React.useContext(StaleContext) ?? notStale;
}

const notStale = () => false;

/**
 * For a switch made in this tab (call it once the switch succeeded): the guard doesn't take the
 * changed cookie for another tab's switch while this tab re-renders in the new organization.
 */
export function useExpectOrganizationSwitch(): () => void {
  return React.useContext(SwitchingContext) ?? noop;
}

const noop = () => {};
