import type { TablerIcon } from "@tabler/icons-react";
import type { MouseEvent } from "react";

/**
 * A live mark on a nav entry: a count or a dot in its tone. A count is the accent pill
 * (`accent`, the default: it needs you) or plain neutral text (`neutral`, e.g. Backlog's
 * item count, Design rule 15), which shows on the full sidebar only.
 */
export type NavIndicator =
  | { kind: "count"; value: number; label: string; tone?: "accent" | "neutral" }
  | { kind: "dot"; tone: "run" | "fail"; label: string };

/** One navigation entry, shown in the sidebar, the rail and (by `phone`) the tab bar or drawer. */
export interface NavItem {
  id: string;
  label: string;
  href: string;
  icon: TablerIcon;
  /** `main` entries sit under the picker; `bottom` entries sit above the user footer. */
  placement: "main" | "bottom";
  /** Where the entry goes on a phone: the bottom tab bar or the drawer. */
  phone: "tab" | "drawer";
  /** Further path prefixes the entry is active for (e.g. `/reviews` for Runs). */
  activeFor?: readonly string[];
  indicator?: NavIndicator;
  /**
   * Called instead of navigating when the entry is clicked above 768 px (the sidebar and the
   * rail; e.g. Ask opens its panel). At phone widths, and for modified clicks, the link
   * navigates to `href` as usual.
   */
  onSelect?: (event: MouseEvent<HTMLAnchorElement>) => void;
  /** For an entry with `onSelect` that opens something: whether it's open (`aria-expanded`). */
  expanded?: boolean;
}

function matchesPrefix(path: string, prefix: string): boolean {
  if (path === prefix) return true;
  // The root only matches itself, or every page would light up a home entry.
  if (prefix === "/") return false;
  const base = prefix.endsWith("/") ? prefix : `${prefix}/`;
  return path.startsWith(base);
}

/**
 * Whether `currentPath` is the entry's page: it equals the `href` or an `activeFor`
 * prefix, or starts with one of them followed by `/` (so `/settings` never matches
 * `/settingsx`). An `href` of `/` is active only on `/`.
 */
export function isNavActive(
  currentPath: string,
  item: Pick<NavItem, "href" | "activeFor">,
): boolean {
  const path = currentPath.split(/[?#]/, 1)[0] ?? currentPath;
  return [item.href, ...(item.activeFor ?? [])].some((prefix) => matchesPrefix(path, prefix));
}

/** The entry's accessible name: its label, plus the indicator's label when it has one. */
export function navAccessibleName(item: Pick<NavItem, "label" | "indicator">): string {
  return item.indicator ? `${item.label}, ${item.indicator.label}` : item.label;
}

/** Whether the indicator is an alert (counted on the hamburger), not just information. */
export function isNavAlert(indicator: NavIndicator | undefined): boolean {
  return indicator !== undefined && !(indicator.kind === "count" && indicator.tone === "neutral");
}

/** The hamburger's accessible name: "Open menu", plus ", N alerts" for drawer indicators. */
export function menuButtonName(alerts: number): string {
  if (alerts <= 0) return "Open menu";
  return `Open menu, ${alerts} ${alerts === 1 ? "alert" : "alerts"}`;
}
