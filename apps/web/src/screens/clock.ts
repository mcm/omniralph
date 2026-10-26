"use client";

import * as React from "react";

/**
 * The browser's clock in ms, ticking every `intervalMs` (a minute by default), so ages
 * and "Waiting on you for …" keep moving while a screen is open. It refetches nothing.
 */
export function useClock(intervalMs = 60_000): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
