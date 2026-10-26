"use client";

import { Badge } from "@iamthemcmaster/ui";
import type { ReviewRow } from "@/lib/reviews/display";
import { REVIEW_STATUS_VARIANTS, SEVERITY_VARIANTS, stateLabel } from "@/lib/state-variants";

type Severity = keyof ReviewRow["findingCounts"];
type Status = ReviewRow["status"];

/**
 * The library variant gives the chip its shape; `.severity-<severity>` in globals.css sets
 * its fill, border and text so the five read as one ramp that only gets quieter in both
 * themes (measured in `severity-ramp.test.ts`).
 */
function severityBadgeProps(severity: Severity) {
  const variant = SEVERITY_VARIANTS[severity];
  return {
    variant: variant === "quiet" || variant === "strong" ? "neutral" : variant,
    className: `severity-${severity}`,
    dot: severity === "critical",
  } as const;
}

export function SeverityBadge({ severity, count }: { severity: Severity; count?: number }) {
  return (
    <Badge {...severityBadgeProps(severity)} size="sm">
      {count !== undefined && <span className="text-numeric">{count}</span>}
      {stateLabel(severity)}
    </Badge>
  );
}

export function ReviewStatusBadge({ status }: { status: Status }) {
  return (
    <Badge variant={REVIEW_STATUS_VARIANTS[status]} dot live={status === "running"}>
      {stateLabel(status)}
    </Badge>
  );
}
