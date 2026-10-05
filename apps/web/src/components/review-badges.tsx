"use client";

import { Badge } from "@iamthemcmaster/ui";
import { IconAt, IconRefresh, IconWebhook } from "@tabler/icons-react";
import type { ReviewDetailView, ReviewRow } from "@/lib/reviews/display";

type Variant = "success" | "warning" | "info" | "danger" | "neutral" | "emphasis" | "outline";
type Severity = keyof ReviewRow["findingCounts"];
type Status = ReviewRow["status"];
type FindingStatus = ReviewDetailView["files"][number]["findings"][number]["status"];

/** One mapping for every page that shows finding severities. */
export const SEVERITY_BADGES: Record<Severity, Variant> = {
  critical: "danger",
  high: "warning",
  medium: "info",
  low: "neutral",
  info: "outline",
};

const STATUS_BADGES: Record<Status, Variant> = {
  queued: "neutral",
  running: "info",
  completed: "success",
  failed: "danger",
  budget_exhausted: "warning",
  skipped: "neutral",
};

const FINDING_STATUS_BADGES: Record<FindingStatus, Variant> = {
  open: "emphasis",
  dismissed: "neutral",
  resolved: "success",
  superseded: "outline",
};

export function SeverityBadge({ severity, count }: { severity: Severity; count?: number }) {
  return (
    <Badge variant={SEVERITY_BADGES[severity]} size="sm">
      {count !== undefined ? `${count} ${severity}` : severity}
    </Badge>
  );
}

export function ReviewStatusBadge({ status }: { status: Status }) {
  return (
    <Badge variant={STATUS_BADGES[status]} dot live={status === "running"}>
      {status.replace("_", " ")}
    </Badge>
  );
}

export function TriggerBadge({ trigger }: { trigger: ReviewRow["trigger"] }) {
  const Icon = trigger === "mention" ? IconAt : trigger === "manual" ? IconRefresh : IconWebhook;
  return (
    <Badge variant="outline">
      <Icon size={12} />
      {trigger}
    </Badge>
  );
}

export function FindingStatusBadge({ status }: { status: FindingStatus }) {
  return (
    <Badge variant={FINDING_STATUS_BADGES[status]} size="sm">
      {status}
    </Badge>
  );
}
