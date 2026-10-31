import type { ReactNode } from "react";
import { StatusDot, type StatusTone } from "../status/status.js";

/** A row's state, as a dot on its avatar: its tone, and the label that names the dot. */
export interface RowStatus {
  tone: StatusTone;
  /** Names the dot with the row's kind and state, e.g. "Review, failed". */
  label: string;
}

export interface RowAvatarProps {
  /** What the row is: a kind icon or a brand mark. */
  children: ReactNode;
  /** The row's state as a dot on the avatar's corner; none when the row has no state. */
  status?: RowStatus;
  /** Replaces the dot `status` draws, e.g. a dot with a tooltip. */
  statusSlot?: ReactNode;
  className?: string;
}

/**
 * The circle that leads a list pane's row: what the row is (a run kind's icon, a tracker's or
 * code host's mark), with its state as a dot on the corner. The dot carries the state's name;
 * the circle itself is decoration unless its mark names itself (a `BrandMark` is `role="img"`).
 */
export function RowAvatar({ children, status, statusSlot, className }: RowAvatarProps) {
  const dot = statusSlot ?? (status ? <StatusDot tone={status.tone} label={status.label} /> : null);
  return (
    <span className={["or-row-avatar", className].filter(Boolean).join(" ")}>
      <span className="or-row-avatar__icon">{children}</span>
      {dot ? <span className="or-row-avatar__status">{dot}</span> : null}
    </span>
  );
}
