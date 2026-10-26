import { useId, type ReactNode } from "react";
import { StatusDot, type StatusTone } from "./status.js";

/** What each tone's dot is named when the line doesn't name it. */
export const STATUS_LINE_DOT_LABELS: Readonly<Record<StatusTone, string>> = {
  need: "Needs you",
  run: "Running",
  good: "Done",
  fail: "Failed",
  neutral: "Status",
};

export interface StatusLineProps {
  tone: StatusTone;
  /** The sentence, e.g. "Waiting on you for 15 days"; it names the line. */
  children: ReactNode;
  /** The dot's accessible name; defaults to the tone's (`STATUS_LINE_DOT_LABELS`). */
  dotLabel?: string;
  className?: string;
}

/**
 * Where a run or item stands, as one sentence after a status dot: the line under a detail
 * header ("Waiting on you for 15 days", "Finished · merge request open"). The line is a
 * `status` region named by its sentence, so a change is announced.
 */
export function StatusLine({ tone, children, dotLabel, className }: StatusLineProps) {
  const textId = useId();
  return (
    <p
      className={["or-statusline", `or-statusline--${tone}`, className].filter(Boolean).join(" ")}
      role="status"
      aria-labelledby={textId}
    >
      <StatusDot tone={tone} label={dotLabel ?? STATUS_LINE_DOT_LABELS[tone]} />
      <span id={textId} className="or-statusline__text">
        {children}
      </span>
    </p>
  );
}
