/**
 * The Logs page's pure parts: the filter, matching live lines to it, which live lines a
 * loaded page already holds, and the 5,000-line cap.
 */
import type { LogEntry } from "../../../../src/logs/entries.js";
import type { LogPageLevel } from "../../../../src/ui/log-routes.js";

export type { LogPageLevel };

/** Most lines the page keeps (loaded pages, live lines and lines held by Pause). */
export const MAX_LOG_LINES = 5_000;

/** Lines per `GET /api/logs` page (`LOG_PAGE_LINES` on the agent). */
export const LOG_PAGE_SIZE = 200;

export const LEVEL_OPTIONS = [
  { value: "all", label: "All" },
  { value: "warn", label: "Warnings and errors" },
] as const satisfies readonly { value: LogPageLevel; label: string }[];

export const NOTHING_LOGGED = "Nothing logged yet";
export const NOTHING_MATCHES = "No lines match this filter";
export const AT_LINE_LIMIT = "Showing the newest 5,000 lines.";

export interface LogFilterValue {
  level: LogPageLevel;
  /** Trimmed; empty for none. */
  q: string;
}

/** A line on the page, with a key that stays put while lines come and go. */
export interface LogLine extends LogEntry {
  key: string;
}

const WARN = new Set<LogEntry["level"]>(["warn", "error", "fatal"]);

/** Whether a level is shown in the fail tone (and kept by "Warnings and errors"). */
export function isProblemLevel(level: LogEntry["level"]): boolean {
  return WARN.has(level);
}

/**
 * Whether a live line passes the filter, as the agent's `GET /api/logs` would (it matches
 * the line as written; here the message and fields stand in for it).
 */
export function lineMatches(entry: LogEntry, filter: LogFilterValue): boolean {
  if (filter.level === "warn" && !isProblemLevel(entry.level)) return false;
  const q = filter.q.toLowerCase();
  if (!q) return true;
  return `${entry.msg} ${JSON.stringify(entry.fields)}`.toLowerCase().includes(q);
}

function fingerprint(entry: LogEntry): string {
  return `${entry.time}\u0000${entry.level}\u0000${entry.msg}\u0000${JSON.stringify(entry.fields)}`;
}

/**
 * The live lines the newest loaded page doesn't hold yet: those after its newest line. A line
 * stamped the same millisecond is kept unless the page has the very same line.
 */
export function linesAfterPage<Line extends LogEntry>(
  live: readonly Line[],
  newestPage: readonly LogEntry[] | undefined,
): Line[] {
  const newest = newestPage?.[0];
  if (!newest) return [...live];
  const sameTime = new Set(
    newestPage.filter((entry) => entry.time === newest.time).map((entry) => fingerprint(entry)),
  );
  return live.filter(
    (line) =>
      line.time > newest.time || (line.time === newest.time && !sameTime.has(fingerprint(line))),
  );
}

/** The entries of `tail` after `seen` (all of them when `seen` has left the tail). */
export function entriesAfter(
  tail: readonly LogEntry[],
  seen: LogEntry | null,
): readonly LogEntry[] {
  if (seen === null) return tail;
  const index = tail.lastIndexOf(seen);
  return index === -1 ? tail : tail.slice(index + 1);
}

/**
 * How to fit the cap: how many of the oldest loaded pages to drop (the newest page always
 * stays, it places the live lines), then how many live lines may stay (the newest).
 */
export function fitToCap(
  pageSizes: readonly number[],
  liveCount: number,
  max = MAX_LOG_LINES,
): { dropPages: number; keepLive: number } {
  let total = pageSizes.reduce((sum, size) => sum + size, 0) + liveCount;
  let dropPages = 0;
  while (total > max && pageSizes.length - dropPages > 1) {
    total -= pageSizes[pageSizes.length - 1 - dropPages]!;
    dropPages += 1;
  }
  const kept = pageSizes.slice(0, pageSizes.length - dropPages).reduce((a, b) => a + b, 0);
  return { dropPages, keepLive: Math.min(liveCount, Math.max(0, max - kept)) };
}

/** A field's value as shown when a line is expanded. */
export function fieldText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? String(value);
}
