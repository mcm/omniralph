"use client";

import { ariaKeyShortcuts, useNavigate, type NavItem, type ShortcutPlatform } from "@omniralph/ui";
import { navItems } from "@/lib/navigation";
import { SHORTCUTS, useShortcut, type ShortcutId } from "@/lib/shortcuts";
import { newWorkItemHref } from "@/screens/backlog/url";

/** The Help page, opened from the user menu. */
export const HELP_PATH = "/help";

/** The key of each nav entry (`navigation.ts`), in the sidebar's order: 1–7, and Mod+J for Ask. */
export const NAV_SHORTCUTS = {
  inbox: "goInbox",
  runs: "goRuns",
  backlog: "goBacklog",
  repos: "goRepos",
  fleet: "goFleet",
  ask: "ask",
  analytics: "goAnalytics",
  settings: "goSettings",
} as const satisfies Record<string, ShortcutId>;

function navShortcut(navId: string): ShortcutId | undefined {
  return NAV_SHORTCUTS[navId as keyof typeof NAV_SHORTCUTS];
}

/** The entries with their keys (`NAV_SHORTCUTS`) in `aria-keyshortcuts` form, for every placement. */
export function withNavKeyShortcuts(
  nav: readonly NavItem[],
  platform: ShortcutPlatform,
): readonly NavItem[] {
  return nav.map((item) => {
    const id = navShortcut(item.id);
    return id ? { ...item, keyShortcuts: ariaKeyShortcuts(SHORTCUTS[id], platform) } : item;
  });
}

/**
 * Clicks the nav entry `id` where the sidebar (or the rail) draws it, so the key does what
 * the entry does: its link (through the unsaved-changes guard), or Ask's panel above 768 px.
 */
function selectNavEntry(id: string): boolean {
  const entry =
    document.querySelector<HTMLElement>(`.or-sidebar [data-nav-id="${id}"]`) ??
    document.querySelector<HTMLElement>(`[data-nav-id="${id}"]`);
  if (!entry) return false;
  entry.click();
  return true;
}

/** One nav entry's key: 1–7 for the screens, Mod+J for Ask. */
function NavShortcut({ navId, id }: { navId: string; id: ShortcutId }) {
  useShortcut(id, () => selectNavEntry(navId));
  return null;
}

/**
 * The shell's own shortcuts, registered in one place: each nav entry's key (from
 * `navigation.ts`, so it opens the entry as a click on it does), Open Help (`/help`, the user
 * menu's Help) and New work item (the Backlog's sheet, `?new=1`, from any page).
 */
export function AppShortcuts() {
  const navigate = useNavigate();
  useShortcut("help", () => navigate(HELP_PATH));
  useShortcut("newWorkItem", () =>
    navigate(newWorkItemHref(window.location.pathname, window.location.search)),
  );
  return (
    <>
      {navItems.map((item) => {
        const id = navShortcut(item.id);
        return id ? <NavShortcut key={item.id} navId={item.id} id={id} /> : null;
      })}
    </>
  );
}
