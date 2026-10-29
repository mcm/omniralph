"use client";

import { ariaKeyShortcuts, useNavigate, type NavItem, type ShortcutPlatform } from "@omniralph/ui";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { navItems } from "@/lib/navigation";
import { SHORTCUTS, useShortcut, type ShortcutId } from "@/lib/shortcuts";
import { NewWorkItemSheet } from "@/screens/backlog/new-work-item-sheet";

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

/** Whether `pathname` is a Backlog page, whose own + handles New work item. */
function isBacklogPath(pathname: string): boolean {
  return pathname === "/backlog" || pathname.startsWith("/backlog/");
}

/**
 * The shell's own shortcuts, registered in one place: each nav entry's key (from
 * `navigation.ts`, so it opens the entry as a click on it does), Open Help (`/help`, the user
 * menu's Help) and, off the Backlog, New work item: the New work item sheet over the current
 * page, which stays put (the create's toast reports the new item). On the Backlog, its own +
 * takes the key, so the sheet starts at the Repo filter and selects the new item.
 */
export function AppShortcuts() {
  const navigate = useNavigate();
  const pathname = usePathname();
  const [creating, setCreating] = useState(false);
  useShortcut("help", () => navigate(HELP_PATH));
  useShortcut("newWorkItem", () => setCreating(true), { enabled: !isBacklogPath(pathname) });
  return (
    <>
      {navItems.map((item) => {
        const id = navShortcut(item.id);
        return id ? <NavShortcut key={item.id} navId={item.id} id={id} /> : null;
      })}
      {creating ? (
        <NewWorkItemSheet onClose={() => setCreating(false)} onCreated={() => {}} />
      ) : null}
    </>
  );
}
