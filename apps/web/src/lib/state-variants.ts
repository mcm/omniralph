import type { IntentVariant } from "@iamthemcmaster/ui";
import type { RalphStoryOutcome } from "@/lib/analytics/display";
import type { AuditEventName } from "@/lib/agents/display";
import type { JobRow } from "@/lib/agents/rows";
import type { AgentUpdateStatus } from "@/lib/agents/update";
import type { RalphMessageState, RalphRunRow, RalphStoryView } from "@/lib/ralph/display";
import type { ReviewDetailView, ReviewRow } from "@/lib/reviews/display";
import type { TriageRunStatus } from "@/lib/triage/display";

/**
 * The State Vocabulary Rule (apps/web/DESIGN.md): every run, story, job, review
 * and agent state maps to one library variant, the same way everywhere.
 * `success` completed or passed; `warning` blocked, waiting or needing a person;
 * `danger` failed or exhausted; `info` running or in progress; `neutral`
 * pending, cancelled or skipped. Nothing else picks a state's variant.
 */

/**
 * A state or category value as badge text: sentence case, underscores as spaces
 * ("in_progress" → "In progress"), so every badge in the panel reads the same way.
 */
export function stateLabel(value: string): string {
  const text = value.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const RALPH_RUN_STATUS_VARIANTS: Record<RalphRunRow["status"], IntentVariant> = {
  pending: "neutral",
  running: "info",
  waiting: "warning",
  completed: "success",
  failed: "danger",
  stopped: "neutral",
};

export const TRIAGE_RUN_STATUS_VARIANTS: Record<TriageRunStatus, IntentVariant> = {
  queued: "neutral",
  running: "info",
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

/**
 * How loud a finding severity reads: the library's tinted intents plus `strong`
 * (neutral well, secondary text, a border one step above `neutral`) and `quiet` (no
 * fill, dashed outline, tertiary text), so five severities get five looks. The exact
 * colours are `.severity-<severity>` in globals.css. Never `info`: that's the running
 * hue. Never `accent`: a solid fill would outshout `critical`.
 */
export type SeverityVariant = "danger" | "warning" | "strong" | "neutral" | "quiet";

/** Loudness of each severity variant, loudest first. */
export const SEVERITY_VARIANT_WEIGHT: Record<SeverityVariant, number> = {
  danger: 4,
  warning: 3,
  strong: 2,
  neutral: 1,
  quiet: 0,
};

/** Finding severities, most to least severe, on a ramp that only gets quieter. */
export const SEVERITY_VARIANTS: Record<keyof ReviewRow["findingCounts"], SeverityVariant> = {
  critical: "danger",
  high: "warning",
  medium: "strong",
  low: "neutral",
  info: "quiet",
};

/** A host tool's configured path as last checked, and whether it can run at all. */
export type HostToolPathState = "unchecked" | "exists" | "missing" | "unavailable";

export const HOST_TOOL_PATH_VARIANTS: Record<HostToolPathState, IntentVariant> = {
  unchecked: "neutral",
  exists: "success",
  missing: "danger",
  unavailable: "warning",
};

/** An integration's state: a saved connection the server can't use (app not configured) warns. */
export type IntegrationState = "connected" | "unconfigured" | "disconnected";

export function integrationState(connected: boolean, configured: boolean): IntegrationState {
  if (!connected) return "disconnected";
  return configured ? "connected" : "unconfigured";
}

export const INTEGRATION_STATE_VARIANTS: Record<IntegrationState, IntentVariant> = {
  connected: "success",
  unconfigured: "warning",
  disconnected: "neutral",
};

export const INTEGRATION_STATE_LABELS: Record<IntegrationState, string> = {
  connected: "Connected",
  unconfigured: "Connected · not configured",
  disconnected: "Not connected",
};

export type AgentConnectionState = "online" | "offline" | "revoked";

export function agentConnectionState(agent: {
  online: boolean;
  revoked: boolean;
}): AgentConnectionState {
  if (agent.revoked) return "revoked";
  return agent.online ? "online" : "offline";
}

export const AGENT_CONNECTION_VARIANTS: Record<AgentConnectionState, IntentVariant> = {
  online: "success",
  offline: "neutral",
  revoked: "danger",
};

export const AGENT_UPDATE_STATUS_VARIANTS: Record<AgentUpdateStatus, IntentVariant> = {
  up_to_date: "success",
  updating: "info",
  failed: "danger",
  manual: "warning",
};

export const AGENT_AUDIT_EVENT_VARIANTS: Record<AuditEventName, IntentVariant> = {
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
