/** Sizes and relative times, as the pages write them (American English). */
import { useEffect, useState } from "react";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/** "120 GB", "4.2 GB", "512 KB": decimal units, one decimal under 10. */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const rounded = unit === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  // 999.6 KB rounds to 1000 KB: say 1 MB instead.
  if (rounded >= 1000 && unit < BYTE_UNITS.length - 1) return `1 ${BYTE_UNITS[unit + 1]}`;
  return `${rounded} ${BYTE_UNITS[unit]}`;
}

const RELATIVE = new Intl.RelativeTimeFormat("en-US", { numeric: "always" });

const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["minute", 60],
  ["hour", 60 * 60],
  ["day", 24 * 60 * 60],
  ["month", 30 * 24 * 60 * 60],
  ["year", 365 * 24 * 60 * 60],
];

/** "just now", "10 minutes ago", "3 days ago". */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.round((now - Date.parse(iso)) / 1000);
  if (Number.isNaN(seconds)) return iso;
  if (Math.abs(seconds) < 60) return "just now";
  let unit: Intl.RelativeTimeFormatUnit = "minute";
  let size = 60;
  for (const [name, length] of STEPS) {
    if (Math.abs(seconds) < length) break;
    unit = name;
    size = length;
  }
  return RELATIVE.format(-Math.trunc(seconds / size), unit);
}

/** The time now, updated every `intervalMs`, so relative times stay true on an open page. */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
