/**
 * The daily window: every daily task that queries Postgres runs at 03:15 UTC, so an idle
 * day wakes the database once. The daily crons are scheduled at `15 3 * * *`
 * (`vercel.json`); ralph-reconcile's full pass runs at its first invocation in the window.
 */

const WINDOW_HOUR_UTC = 3;
const WINDOW_MINUTE_UTC = 15;
const DAY_MS = 24 * 60 * 60_000;

/** When the window starts on `day`'s UTC date (ms). */
export function dailyWindowStart(day: Date): number {
  return Date.UTC(
    day.getUTCFullYear(),
    day.getUTCMonth(),
    day.getUTCDate(),
    WINDOW_HOUR_UTC,
    WINDOW_MINUTE_UTC,
  );
}

/** The start of the latest window at or before `now` (ms). */
export function currentDailyWindow(now: Date): number {
  const today = dailyWindowStart(now);
  return today <= now.getTime() ? today : today - DAY_MS;
}

/** The start of the first window after `now` (ms). */
export function nextDailyWindow(now: Date): number {
  return currentDailyWindow(now) + DAY_MS;
}

/**
 * How long from `now` until the next window starts (ms, always > 0): the TTL of a cached key
 * whose expiry sends the next request to Postgres, so that request lands in the window.
 */
export function msUntilNextDailyWindow(now: Date): number {
  return nextDailyWindow(now) - now.getTime();
}
