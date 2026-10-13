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

/**
 * Finding counts per severity on one line, most severe first, skipping zeros:
 * mono count plus the severity's name ("2 critical") from 768px, its initial
 * ("2C") on phone (the full name is in the tooltip and read to screen readers). `only` limits the severities shown (the phone
 * row shows just critical and high). `wordsUpTo` caps the words' length in characters: a
 * longer set shows initials at every width, so it stays on one line in a fixed column.
 */
/** The characters "2 critical 1 high" takes: each count, a space and its severity's name. */
export function severityWordsLength(
  counts: ReviewRow["findingCounts"],
  present: readonly Severity[],
): number {
  return present.reduce((sum, s) => sum + String(counts[s]).length + 1 + s.length, 0);
}

export function SeverityCounts({
  counts,
  only = FINDING_SEVERITIES,
  wordsUpTo,
}: {
  counts: ReviewRow["findingCounts"];
  only?: readonly Severity[];
  wordsUpTo?: number;
}) {
  const present = FINDING_SEVERITIES.filter((s) => only.includes(s) && counts[s] > 0);
  if (present.length === 0) return null;
  const short = wordsUpTo !== undefined && severityWordsLength(counts, present) > wordsUpTo;
  return (
    <span className={short ? "severity-counts severity-counts-short" : "severity-counts"}>
      {present.map((severity) => (
        <Badge key={severity} {...severityBadgeProps(severity)} size="sm" title={severity}>
          <span className="text-numeric">{counts[severity]}</span>
          <span aria-hidden className="severity-short">
            {SEVERITY_SHORT[severity]}
          </span>
          <span aria-hidden className="severity-word">
            {severity}
          </span>
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
