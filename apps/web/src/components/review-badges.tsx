"use client";

import { Badge } from "@iamthemcmaster/ui";
import { IconAt, IconRefresh, IconWebhook } from "@tabler/icons-react";
import { FINDING_SEVERITIES, type ReviewDetailView, type ReviewRow } from "@/lib/reviews/display";
import {
  FINDING_STATUS_VARIANTS,
  REVIEW_STATUS_VARIANTS,
  SEVERITY_VARIANTS,
  stateLabel,
} from "@/lib/state-variants";

type Severity = keyof ReviewRow["findingCounts"];
type Status = ReviewRow["status"];
type FindingStatus = ReviewDetailView["files"][number]["findings"][number]["status"];

const SEVERITY_SHORT: Record<Severity, string> = {
  critical: "C",
  high: "H",
  medium: "M",
  low: "L",
  info: "I",
};

function severityBadgeProps(severity: Severity) {
  const variant = SEVERITY_VARIANTS[severity];
  return variant === "quiet"
    ? ({ variant: "neutral", className: "severity-quiet" } as const)
    : { variant, dot: severity === "critical" };
}

export function SeverityBadge({ severity, count }: { severity: Severity; count?: number }) {
  return (
    <Badge {...severityBadgeProps(severity)} size="sm">
      {count !== undefined && <span className="text-numeric">{count}</span>}
      {stateLabel(severity)}
    </Badge>
  );
}

/**
 * Finding counts per severity on one line, most severe first, skipping zeros:
 * mono count plus the severity's initial ("2C"; the full name is in the tooltip
 * and read to screen readers). `only` limits the severities shown (the phone
 * row shows just critical and high).
 */
export function SeverityCounts({
  counts,
  only = FINDING_SEVERITIES,
}: {
  counts: ReviewRow["findingCounts"];
  only?: readonly Severity[];
}) {
  const present = FINDING_SEVERITIES.filter((s) => only.includes(s) && counts[s] > 0);
  if (present.length === 0) return null;
  return (
    <span className="severity-counts">
      {present.map((severity) => (
        <Badge key={severity} {...severityBadgeProps(severity)} size="sm" title={severity}>
          <span className="text-numeric">{counts[severity]}</span>
          <span aria-hidden>{SEVERITY_SHORT[severity]}</span>
          <span className="sr-only">{severity}</span>
        </Badge>
      ))}
    </span>
  );
}

export function ReviewStatusBadge({ status }: { status: Status }) {
  return (
    <Badge variant={REVIEW_STATUS_VARIANTS[status]} dot live={status === "running"}>
      {stateLabel(status)}
    </Badge>
  );
}

export function TriggerBadge({ trigger }: { trigger: ReviewRow["trigger"] }) {
  const Icon = trigger === "mention" ? IconAt : trigger === "manual" ? IconRefresh : IconWebhook;
  return (
    <Badge variant="neutral">
      <Icon size={12} />
      {stateLabel(trigger)}
    </Badge>
  );
}

export function FindingStatusBadge({ status }: { status: FindingStatus }) {
  return (
    <Badge variant={FINDING_STATUS_VARIANTS[status]} size="sm">
      {stateLabel(status)}
    </Badge>
  );
}
