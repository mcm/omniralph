"use client";

import { Badge } from "@iamthemcmaster/ui";
import { IconAt, IconRefresh, IconWebhook } from "@tabler/icons-react";
import type { ReviewDetailView, ReviewRow } from "@/lib/reviews/display";
import {
  FINDING_STATUS_VARIANTS,
  REVIEW_STATUS_VARIANTS,
  SEVERITY_VARIANTS,
} from "@/lib/state-variants";

type Severity = keyof ReviewRow["findingCounts"];
type Status = ReviewRow["status"];
type FindingStatus = ReviewDetailView["files"][number]["findings"][number]["status"];

export function SeverityBadge({ severity, count }: { severity: Severity; count?: number }) {
  return (
    <Badge variant={SEVERITY_VARIANTS[severity]} size="sm">
      {count !== undefined ? `${count} ${severity}` : severity}
    </Badge>
  );
}

export function ReviewStatusBadge({ status }: { status: Status }) {
  return (
    <Badge variant={REVIEW_STATUS_VARIANTS[status]} dot live={status === "running"}>
      {status.replace("_", " ")}
    </Badge>
  );
}

export function TriggerBadge({ trigger }: { trigger: ReviewRow["trigger"] }) {
  const Icon = trigger === "mention" ? IconAt : trigger === "manual" ? IconRefresh : IconWebhook;
  return (
    <Badge variant="neutral">
      <Icon size={12} />
      {trigger}
    </Badge>
  );
}

export function FindingStatusBadge({ status }: { status: FindingStatus }) {
  return (
    <Badge variant={FINDING_STATUS_VARIANTS[status]} size="sm">
      {status}
    </Badge>
  );
}
