/** Locale date and time, e.g. "Oct 5, 2026, 3:04 PM". */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Locale date and time without the parts it shares with an earlier instant shown
 * beside it: "3:09 PM" on the same day, "Oct 6, 3:09 PM" in the same year, else the
 * full `formatDateTime`.
 */
export function formatDateTimeAfter(iso: string, earlier: string): string {
  const date = new Date(iso);
  const before = new Date(earlier);
  if (date.toDateString() === before.toDateString()) {
    return date.toLocaleTimeString(undefined, { timeStyle: "short" });
  }
  return formatDateTimeInYear(iso, before.getFullYear());
}

/**
 * Locale date and time without the year when it is `year` (e.g. the current one):
 * "Oct 6, 3:09 PM", else the full `formatDateTime`.
 */
export function formatDateTimeInYear(iso: string, year: number): string {
  const date = new Date(iso);
  if (date.getFullYear() !== year) return formatDateTime(iso);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Short relative time, e.g. "12s ago", "5 min ago", "3 h ago", else the date. */
export function formatRelative(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return formatDateTime(iso);
}
