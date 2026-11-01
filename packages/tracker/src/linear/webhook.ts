/**
 * Linear webhook verification and event classification (ported from cyralph):
 * deliveries become neutral {@link TrackerEvent}s.
 *
 * Linear signs the raw request body with HMAC-SHA256 (hex) in the
 * `linear-signature` header and includes `webhookTimestamp` (ms) in the
 * payload for replay protection.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { isTriageLabel, type TrackerEvent } from "../events.js";
import { isWorkflowStateType } from "../types.js";

export const SIGNATURE_HEADER = "linear-signature";
export const DELIVERY_HEADER = "linear-delivery";
export const MAX_CLOCK_SKEW_MS = 60_000;

export function signBody(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export type VerifyResult =
  | { ok: true; payload: Record<string, unknown> }
  | {
      ok: false;
      reason: "missing_signature" | "invalid_signature" | "invalid_json" | "stale_timestamp";
    };

export function verifyWebhook(
  rawBody: string,
  signature: string | null | undefined,
  secret: string,
  now = Date.now(),
): VerifyResult {
  if (!signature) return { ok: false, reason: "missing_signature" };
  const expected = Buffer.from(signBody(rawBody, secret), "hex");
  const given = Buffer.from(signature.trim(), "hex");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: "invalid_signature" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: "invalid_json" };
  }
  const record = payload as Record<string, unknown>;
  const ts = record.webhookTimestamp;
  // A signed delivery without a timestamp can't be checked for replay.
  if (typeof ts !== "number" || Math.abs(now - ts) > MAX_CLOCK_SKEW_MS) {
    return { ok: false, reason: "stale_timestamp" };
  }
  return { ok: true, payload: record };
}

/**
 * Linear always fills `agentSession.comment.body`; for a delegation (not an
 * @mention) it holds a system note containing this marker (cyralph and Cyrus
 * tell the two apart the same way).
 */
export const AGENT_SESSION_MARKER = "This thread is for an agent session";

/** Whether a new agent session's comment is an @mention (not a delegation's system note). */
function isMentionComment(body: string | undefined): body is string {
  const trimmed = body?.trim();
  return !!trimmed && !trimmed.includes(AGENT_SESSION_MARKER);
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * The triage label's ID when the update added it: Linear sends the
 * issue's `labelIds` (and its `labels` with names) in `data`, and the previous
 * `labelIds` in `updatedFrom`.
 */
function addedTriageLabel(payload: Record<string, unknown>): string | undefined {
  const before = obj(payload.updatedFrom);
  if (payload.action !== "update" || !("labelIds" in before)) return undefined;
  const data = obj(payload.data);
  const previous = new Set(strings(before.labelIds));
  const added = new Set(strings(data.labelIds).filter((id) => !previous.has(id)));
  if (added.size === 0) return undefined;
  const labels = Array.isArray(data.labels) ? data.labels.map(obj) : [];
  const label = labels.find((l) => {
    const id = str(l.id);
    const name = str(l.name);
    return id !== undefined && added.has(id) && name !== undefined && isTriageLabel(name);
  });
  return label ? str(label.id) : undefined;
}

function classifyIssueWebhook(payload: Record<string, unknown>): TrackerEvent {
  const data = obj(payload.data);
  const issueId = str(data.id);
  if (!issueId)
    return { kind: "ignored", code: "issue_without_id", reason: "issue webhook without id" };
  const removed = payload.action === "remove";
  const stateChanged = payload.action === "update" && "stateId" in obj(payload.updatedFrom);
  if (!removed && !stateChanged) {
    const labelId = addedTriageLabel(payload);
    if (labelId) {
      return { kind: "triage_requested", issueId, identifier: str(data.identifier), labelId };
    }
    return {
      kind: "ignored",
      code: "issue_unchanged",
      reason: "issue update without state change",
    };
  }
  const triageLabelId = removed ? undefined : addedTriageLabel(payload);
  const stateType = str(obj(data.state).type);
  return {
    kind: "issue_state_changed",
    issueId,
    identifier: str(data.identifier),
    ...(stateType && isWorkflowStateType(stateType) && { stateType }),
    removed,
    ...(triageLabelId ? { triageLabelId } : {}),
  };
}

/**
 * A verified delivery as a neutral event: a new agent session is a delegation or a
 * mention, a reply in one is a prompt, an issue update is a state change or a triage
 * request; anything else is ignored with the delivery log's reason.
 */
export function classifyWebhook(payload: Record<string, unknown>): TrackerEvent {
  if (payload.type === "Issue") return classifyIssueWebhook(payload);
  if (payload.type !== "AgentSessionEvent") {
    return { kind: "ignored", code: "unsupported_event", reason: `type ${String(payload.type)}` };
  }
  const session = obj(payload.agentSession);
  const sessionId = str(session.id);
  if (!sessionId)
    return { kind: "ignored", code: "no_agent_session", reason: "no agent session id" };
  const issue = obj(session.issue);
  const issueId = str(session.issueId) ?? str(issue.id);

  if (payload.action === "created") {
    if (!issueId)
      return {
        kind: "ignored",
        code: "agent_session_without_issue",
        reason: "agent session without an issue",
      };
    const fields = {
      sessionId,
      issueId,
      issueIdentifier: str(issue.identifier),
      promptContext: str(payload.promptContext),
      creatorName: str(obj(session.creator).name),
    };
    const commentBody = str(obj(session.comment).body);
    return isMentionComment(commentBody)
      ? { kind: "issue_mentioned", ...fields, commentBody }
      : { kind: "issue_delegated", ...fields, commentBody };
  }
  if (payload.action === "prompted") {
    const activity = obj(payload.agentActivity);
    return {
      kind: "session_prompted",
      sessionId,
      issueId,
      body: str(obj(activity.content).body) ?? "",
      signal: str(activity.signal),
      authorName: str(obj(activity.user).name),
    };
  }
  return { kind: "ignored", code: "unsupported_event", reason: `action ${String(payload.action)}` };
}
