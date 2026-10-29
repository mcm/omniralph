"use client";

import { Button } from "../actions/button.js";
import { IconRetry } from "../actions/retry-icon.js";

/** What the notice says. */
export const LIVE_NOTICE_MESSAGE = "Live updates stopped. Retrying…";

export interface LiveNoticeProps {
  /** "Retry now": reconnect at once instead of waiting for the next automatic retry. */
  onRetry: () => void;
  className?: string;
}

/**
 * The one connection status the app ever shows (Design rule 9: status only when
 * abnormal): live updates have stopped. Render it above the page content only while the
 * connection is down; there is no "connected" or "Live" counterpart.
 */
export function LiveNotice({ onRetry, className }: LiveNoticeProps) {
  return (
    <div className={["or-live-notice", className].filter(Boolean).join(" ")} role="status">
      <span className="or-dot or-dot--neutral" aria-hidden="true" />
      <span className="or-live-notice__message">{LIVE_NOTICE_MESSAGE}</span>
      <Button variant="outline" size="sm" icon={IconRetry} onClick={onRetry}>
        Retry now
      </Button>
    </div>
  );
}
