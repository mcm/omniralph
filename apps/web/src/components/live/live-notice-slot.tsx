"use client";

import { LiveNotice } from "@omniralph/ui";
import * as React from "react";
import { useLiveRetry, useLiveStatus } from "./live-provider";

/** How long live updates must have been down before the shell says so. */
export const LIVE_NOTICE_DELAY_MS = 5_000;

/**
 * The shell's one connection status (Design rule 9): `LiveNotice` above the page content
 * once live updates have been down for more than `LIVE_NOTICE_DELAY_MS`, gone again on
 * reconnect. Nothing while connected, connecting, briefly down, or when realtime is off.
 */
export function LiveNoticeSlot() {
  const status = useLiveStatus();
  const retry = useLiveRetry();
  const down = status === "down";
  const [shown, setShown] = React.useState(false);
  React.useEffect(() => {
    if (!down) return;
    const timer = setTimeout(() => setShown(true), LIVE_NOTICE_DELAY_MS);
    return () => {
      clearTimeout(timer);
      setShown(false);
    };
  }, [down]);
  return down && shown ? <LiveNotice onRetry={retry} /> : null;
}
