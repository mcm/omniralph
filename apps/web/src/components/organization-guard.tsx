"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@iamthemcmaster/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import * as React from "react";
import { ApiError } from "@/lib/api/client";
import { ORGANIZATION_SWITCHED } from "@/lib/api/schemas";
import { ORGANIZATION_COOKIE } from "@/lib/auth/routes";

/** The organization this browser has picked, as the cookie says now. */
function deviceOrganizationId(): string | null {
  const prefix = `${ORGANIZATION_COOKIE}=`;
  const entry = document.cookie.split("; ").find((cookie) => cookie.startsWith(prefix));
  return entry ? decodeURIComponent(entry.slice(prefix.length)) : null;
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
 * it starts over from the dashboard.
 */
export function OrganizationGuard({
  organizationName,
  renderedCookie,
  children,
}: {
  organizationName: string;
  /** The organization cookie the server rendered this page with. */
  renderedCookie: string | null;
  children: React.ReactNode;
}) {
  const router = useRouter();
  // The render found stale; a refreshed layout brings a new cookie, which clears it.
  const [staleRender, setStaleRender] = React.useState<{ cookie: string | null } | null>(null);
  const stale = staleRender !== null && staleRender.cookie === renderedCookie;
  // This tab switched (the switcher, leaving): the cookie changes before the shell re-renders.
  const switchingHere = React.useRef(false);
  React.useEffect(() => {
    switchingHere.current = false;
  }, [renderedCookie]);
  const expectSwitch = React.useCallback(() => {
    switchingHere.current = true;
  }, []);
  const check = React.useCallback(() => {
    if (switchingHere.current) return false;
    const switched = deviceOrganizationId() !== renderedCookie;
    setStaleRender(switched ? { cookie: renderedCookie } : null);
    return switched;
  }, [renderedCookie]);

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
      <AlertDialog open={stale}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>You switched organizations in another tab</AlertDialogTitle>
            <AlertDialogDescription>
              This tab still shows {organizationName}. Continue from the dashboard so changes
              aren&apos;t made in the wrong organization.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction
              onClick={() => {
                // Like switching here: start over from the dashboard, in the new organization.
                router.push("/");
                router.refresh();
              }}
            >
              Go to dashboard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
