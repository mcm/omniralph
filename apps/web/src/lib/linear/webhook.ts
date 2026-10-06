/**
 * Linear webhook verification and event classification (ported from cyralph).
 *
 * Linear signs the raw request body with HMAC-SHA256 (hex) in the
 * `linear-signature` header and includes `webhookTimestamp` (ms) in the
 * payload for replay protection.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

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

export type LinearWebhookEvent =
  | {
      kind: "session_created";
      sessionId: string;
      issueId: string;
      issueIdentifier?: string;
      /** Linear's formatted context for the agent (issue, comments, guidance). */
      promptContext?: string;
      /** The comment that started the session (a mention), if any. */
      commentBody?: string;
      creatorName?: string;
    }
  | {
      kind: "session_prompted";
      sessionId: string;
      issueId?: string;
      body: string;
      /** e.g. `stop` when the user pressed Stop. */
      signal?: string;
      authorName?: string;
    }
  | {
      /** An issue changed workflow state (or was removed); may unblock waiting runs. */
      kind: "issue_state";
      issueId: string;
      identifier?: string;
      /** Workflow state type from the payload, when present (`completed`, `canceled`, …). */
      stateType?: string;
      removed: boolean;
    }
  | { kind: "ignored"; reason: string };

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function classifyIssueWebhook(payload: Record<string, unknown>): LinearWebhookEvent {
  const data = obj(payload.data);
  const issueId = str(data.id);
  if (!issueId) return { kind: "ignored", reason: "issue webhook without id" };
  const removed = payload.action === "remove";
  const stateChanged = payload.action === "update" && "stateId" in obj(payload.updatedFrom);
  if (!removed && !stateChanged) {
    return { kind: "ignored", reason: "issue update without state change" };
  }
  return {
    kind: "issue_state",
    issueId,
    identifier: str(data.identifier),
    stateType: str(obj(data.state).type),
    removed,
  };
}

export function classifyWebhook(payload: Record<string, unknown>): LinearWebhookEvent {
  if (payload.type === "Issue") return classifyIssueWebhook(payload);
  if (payload.type !== "AgentSessionEvent") {
    return { kind: "ignored", reason: `type ${String(payload.type)}` };
  }
  const session = obj(payload.agentSession);
  const sessionId = str(session.id);
  if (!sessionId) return { kind: "ignored", reason: "no agent session id" };
  const issue = obj(session.issue);
  const issueId = str(session.issueId) ?? str(issue.id);

  if (payload.action === "created") {
    if (!issueId) return { kind: "ignored", reason: "agent session without an issue" };
    return {
      kind: "session_created",
      sessionId,
      issueId,
      issueIdentifier: str(issue.identifier),
      promptContext: str(payload.promptContext),
      commentBody: str(obj(session.comment).body),
      creatorName: str(obj(session.creator).name),
    };
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
  return { kind: "ignored", reason: `action ${String(payload.action)}` };
}
