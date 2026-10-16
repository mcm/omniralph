"use client";

import * as React from "react";
import { formatRelative } from "@/lib/format-date";
import { Timestamp } from "./list-table";

/**
 * The browser's clock, ticking every `intervalMs`: relative times ("20s ago") are computed
 * against it, never against a server render time, so they keep moving while the page is open.
 */
export function useNow(intervalMs = 1_000): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * `iso` relative to the ticking clock ("12s ago", "5 min ago"), for strings such as titles
 * and labels. Rendered as text, use `<RelativeTime>` (mono, one line) instead.
 */
export function useRelativeTime(iso: string, intervalMs?: number): string {
  return formatRelative(iso, useNow(intervalMs));
}

/** A `Timestamp` that shows `iso` relative to the ticking clock, with the exact time in its title. */
export function RelativeTime({ iso, inline }: { iso: string; inline?: boolean }) {
  return <Timestamp iso={iso} now={useNow()} inline={inline} />;
}
