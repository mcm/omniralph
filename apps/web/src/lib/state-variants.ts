import type { IntentVariant } from "@iamthemcmaster/ui";
import type { RalphStoryOutcome } from "@/lib/analytics/display";
import type { AuditEventName } from "@/lib/harnesses/display";
import type { JobRow } from "@/lib/harnesses/rows";
import type { HarnessUpdateStatus } from "@/lib/harnesses/update";
import type { RalphMessageState, RalphRunRow, RalphStoryView } from "@/lib/ralph/display";
import type { ReviewDetailView, ReviewRow } from "@/lib/reviews/display";

/**
 * The State Vocabulary Rule (apps/web/DESIGN.md): every run, story, job, review
 * and harness state maps to one library variant, the same way everywhere.
 * `success` completed or passed; `warning` blocked, waiting or needing a person;
 * `danger` failed or exhausted; `info` running or in progress; `neutral`
 * pending, cancelled or skipped. Nothing else picks a state's variant.
 */

export const RALPH_RUN_STATUS_VARIANTS: Record<RalphRunRow["status"], IntentVariant> = {
  pending: "neutral",
  running: "info",
  waiting: "warning",
  completed: "success",
  failed: "danger",
  stopped: "neutral",
};

export const RALPH_STORY_STATUS_VARIANTS: Record<RalphStoryView["status"], IntentVariant> = {
  pending: "neutral",
  running: "info",
  completed: "success",
  blocked: "warning",
  exhausted: "danger",
  manual: "warning",
  canceled: "neutral",
};

export const RALPH_MESSAGE_STATE_VARIANTS: Record<RalphMessageState, IntentVariant> = {
  waiting: "info",
  delivered: "success",
  guidance: "warning",
  undelivered: "neutral",
};

export const JOB_STATUS_VARIANTS: Record<JobRow["status"], IntentVariant> = {
  queued: "neutral",
  running: "info",
  completed: "success",
  failed: "danger",
  canceled: "neutral",
  expired: "danger",
  skipped: "neutral",
};

export const REVIEW_STATUS_VARIANTS: Record<ReviewRow["status"], IntentVariant> = {
  queued: "neutral",
  running: "info",
  completed: "success",
  failed: "danger",
  budget_exhausted: "danger",
  skipped: "neutral",
};

type FindingStatus = ReviewDetailView["files"][number]["findings"][number]["status"];

export const FINDING_STATUS_VARIANTS: Record<FindingStatus, IntentVariant> = {
  open: "warning",
  dismissed: "neutral",
  resolved: "success",
  superseded: "neutral",
  merged: "neutral",
};

export const SEVERITY_VARIANTS: Record<keyof ReviewRow["findingCounts"], IntentVariant> = {
  critical: "danger",
  high: "warning",
  medium: "info",
  low: "neutral",
  info: "neutral",
};

export type HarnessConnectionState = "online" | "offline" | "revoked";

export function harnessConnectionState(harness: {
  online: boolean;
  revoked: boolean;
}): HarnessConnectionState {
  if (harness.revoked) return "revoked";
  return harness.online ? "online" : "offline";
}

export const HARNESS_CONNECTION_VARIANTS: Record<HarnessConnectionState, IntentVariant> = {
  online: "success",
  offline: "neutral",
  revoked: "danger",
};

export const HARNESS_UPDATE_STATUS_VARIANTS: Record<HarnessUpdateStatus, IntentVariant> = {
  up_to_date: "success",
  updating: "info",
  failed: "danger",
  manual: "warning",
};

export const HARNESS_AUDIT_EVENT_VARIANTS: Record<AuditEventName, IntentVariant> = {
  enroll: "success",
  token_refresh: "neutral",
  refresh_reuse: "danger",
  revoke: "danger",
  delete: "danger",
  credential_issued: "info",
  result_submitted: "info",
  auth_failed: "warning",
};

/**
 * Story outcomes on the analytics chart. Both completions are `success` in
 * meaning; the one that needed retries takes `accent` so the two stay apart.
 */
export const RALPH_STORY_OUTCOME_VARIANTS: Record<RalphStoryOutcome, IntentVariant> = {
  firstAttempt: "success",
  afterRetries: "accent",
  exhausted: "danger",
  blocked: "warning",
};
