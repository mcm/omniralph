"use client";

import { Tooltip } from "../actions/tooltip.js";
import { StatusDot, StatusText, type StatusTone } from "./status.js";

export interface StatusIndicatorProps {
  tone: StatusTone;
  /** The status in words, e.g. "Idle": the dot's name, or the text shown after it. */
  label: string;
  /** Shown on hover, e.g. "Last seen 2 minutes ago"; also the status's accessible description. */
  tooltip?: string;
  /** `text` (the default): the dot followed by the label; `dot`: the dot alone, named by it. */
  variant?: "dot" | "text";
  className?: string;
}

/**
 * A status as Fleet and Repos show it (Design rule 15): a dot in its tone, alone or before its
 * label, with an optional tooltip. The trigger is the status itself and adds no tab stop, so
 * it can sit inside a link or a row; the tooltip's text stays available to screen readers as
 * the status's description.
 */
export function StatusIndicator({
  tone,
  label,
  tooltip,
  variant = "text",
  className,
}: StatusIndicatorProps) {
  // A tooltip that only repeats the label describes nothing new.
  const description = tooltip !== label ? tooltip : undefined;
  // A trigger takes this class so a linked row's stretched link doesn't cover it (lists.css).
  const classes =
    tooltip === undefined
      ? className
      : ["or-status-indicator", className].filter(Boolean).join(" ");
  const status =
    variant === "dot" ? (
      <StatusDot tone={tone} label={label} className={classes} aria-description={description} />
    ) : (
      <StatusText tone={tone} className={classes} aria-description={description}>
        {label}
      </StatusText>
    );
  if (tooltip === undefined) return status;
  return <Tooltip content={tooltip}>{status}</Tooltip>;
}
