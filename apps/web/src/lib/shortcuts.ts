import {
  useKeyShortcuts as useUiKeyShortcuts,
  useShortcut as useUiShortcut,
  type ListShortcutId,
  type ShortcutDefinition,
  type ShortcutGroup,
  type ShortcutHandler,
  type UseShortcutOptions,
} from "@omniralph/ui";

/** Every action with a key. The package's list actions (`ListShortcutId`) must be among them. */
export type ShortcutId =
  | "goInbox"
  | "goRuns"
  | "goBacklog"
  | "goRepos"
  | "goFleet"
  | "goAnalytics"
  | "goSettings"
  | "search"
  | "ask"
  | "help"
  | ListShortcutId
  | "done"
  | "skip"
  | "snooze"
  | "startAnyway"
  | "resume"
  | "retry"
  | "stop"
  | "newWorkItem"
  | "close";

/**
 * The app's keyboard shortcuts (Design rule 7): one key per action, the same everywhere.
 * Keys are `event.key` values; `mod` is ⌘ on Apple platforms and Ctrl elsewhere, and a plain
 * letter or digit fires only with no modifier held. Each key runs the handler of the control
 * that performs its action (`useShortcut`), only while it's shown and enabled; the Help page
 * (`/help`) lists them, and nothing else shows them.
 */
export const SHORTCUTS = {
  goInbox: { key: "1", label: "Go to Inbox", group: "goTo" },
  goRuns: { key: "2", label: "Go to Runs", group: "goTo" },
  goBacklog: { key: "3", label: "Go to Backlog", group: "goTo" },
  goRepos: { key: "4", label: "Go to Repos", group: "goTo" },
  goFleet: { key: "5", label: "Go to Fleet", group: "goTo" },
  goAnalytics: { key: "6", label: "Go to Analytics", group: "goTo" },
  goSettings: { key: "7", label: "Go to Settings", group: "goTo" },
  search: { key: "k", mod: true, label: "Search", group: "goTo" },
  ask: { key: "j", mod: true, label: "Open or close Ask", group: "goTo" },
  help: { key: "?", label: "Open Help", group: "goTo" },
  listNext: { key: "j", label: "Next item", group: "lists", repeat: true },
  listPrevious: { key: "k", label: "Previous item", group: "lists", repeat: true },
  listOpen: { key: "o", label: "Open the focused item", group: "lists" },
  back: { key: "u", label: "Back to the list", group: "lists" },
  done: { key: "e", label: "Done", group: "inbox" },
  skip: { key: "s", label: "Skip story", group: "inbox" },
  snooze: { key: "z", label: "Snooze", group: "inbox" },
  startAnyway: { key: "t", label: "Start anyway", group: "inbox" },
  resume: { key: "c", label: "Resume", group: "inbox" },
  retry: { key: "r", label: "Retry", group: "runs" },
  stop: { key: "x", label: "Stop run", group: "runs" },
  newWorkItem: { key: "n", label: "New work item", group: "workItems" },
  close: { key: "Escape", label: "Close", group: "panels", allowInFields: true },
} as const satisfies Record<ShortcutId, ShortcutDefinition>;

/** The Help page's groups, in order, with their headings. */
export const SHORTCUT_GROUPS: readonly { group: ShortcutGroup; label: string }[] = [
  { group: "goTo", label: "Go to" },
  { group: "lists", label: "Lists" },
  { group: "inbox", label: "Inbox" },
  { group: "runs", label: "Runs" },
  { group: "workItems", label: "Work items" },
  { group: "panels", label: "Panels" },
];

/**
 * Runs `handler` for action `id`'s key while the calling control is mounted and `enabled`
 * (pass the `enabled` it renders with, and the handler its click runs). A null `id`
 * registers nothing.
 */
export function useShortcut(
  id: ShortcutId | null,
  handler: ShortcutHandler,
  options?: UseShortcutOptions,
): void {
  useUiShortcut(id, handler, options);
}

/** Action `id`'s key in `aria-keyshortcuts` form, for the control that performs it. */
export function useKeyShortcuts(id: ShortcutId | null): string | undefined {
  return useUiKeyShortcuts(id);
}
