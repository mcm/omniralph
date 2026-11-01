/**
 * Tracker-neutral webhook events. Each adapter's webhook parser normalizes its
 * tracker's deliveries into these, and the control panel dispatches them
 * without knowing which tracker sent them.
 */
import type { WorkflowStateType } from "./types.js";

/** What an issue delegation and a mention both carry: the agent session the tracker opened. */
interface SessionStartFields {
  /** The agent session the tracker opened for it. */
  sessionId: string;
  issueId: string;
  issueIdentifier?: string;
  /** The tracker's formatted context for the agent (issue, comments, guidance), if it sends one. */
  promptContext?: string;
  /** The comment that started the session, if any. */
  commentBody?: string;
  creatorName?: string;
}

/** An issue was delegated to Om (the app user), which opened an agent session on it. */
export interface IssueDelegatedEvent extends SessionStartFields {
  kind: "issue_delegated";
}

/** Om was @mentioned in a comment on an issue, which opened an agent session on it. */
export interface IssueMentionedEvent extends SessionStartFields {
  kind: "issue_mentioned";
  /** The comment that mentioned Om. */
  commentBody: string;
}

/** An agent session started on an issue: by a delegation or a mention. */
export type SessionStartedEvent = IssueDelegatedEvent | IssueMentionedEvent;

/** Someone wrote in (or signalled) an agent session. */
export interface SessionPromptedEvent {
  kind: "session_prompted";
  sessionId: string;
  issueId?: string;
  body: string;
  /** e.g. `stop` when the user pressed Stop. */
  signal?: string;
  authorName?: string;
}

/** An issue changed workflow state (or was removed); may unblock waiting runs. */
export interface IssueStateChangedEvent {
  kind: "issue_state_changed";
  issueId: string;
  identifier?: string;
  /** The new state's type, when the delivery says. */
  stateType?: WorkflowStateType;
  removed: boolean;
  /**
   * The same update also added a triage label (a bulk edit, or moving and
   * labelling at once): triage starts after the state change.
   */
  triageLabelId?: string;
}

/** An issue update added a triage label (`coding:triage`): triage the issue. */
export interface TriageRequestedEvent {
  kind: "triage_requested";
  issueId: string;
  identifier?: string;
  labelId: string;
}

/** Why a parser ignores a delivery (the delivery log's reason codes). */
export const TRACKER_IGNORE_REASONS = [
  "issue_without_id",
  "issue_unchanged",
  "unsupported_event",
  "no_agent_session",
  "agent_session_without_issue",
] as const;

export type TrackerIgnoreReason = (typeof TRACKER_IGNORE_REASONS)[number];

/** A delivery orchestration doesn't act on. */
export interface IgnoredTrackerEvent {
  kind: "ignored";
  code: TrackerIgnoreReason;
  /** What the webhook answers. */
  reason: string;
}

export type TrackerEvent =
  | IssueDelegatedEvent
  | IssueMentionedEvent
  | SessionPromptedEvent
  | IssueStateChangedEvent
  | TriageRequestedEvent
  | IgnoredTrackerEvent;

/** An event orchestration acts on. */
export type HandledTrackerEvent = Exclude<TrackerEvent, IgnoredTrackerEvent>;

/** The label that asks for triage (matched ignoring case). */
export const TRIAGE_LABEL = "coding:triage";

/** Every name of the triage label, current first: workspaces may still use the old one. */
export const TRIAGE_LABEL_NAMES = [TRIAGE_LABEL, "ralph:triage"] as const;

/**
 * A label that asks for triage: `coding:triage`, or the label's name from
 * before the rename to Coding, which workspaces may still use.
 */
const TRIAGE_LABEL_NAME = /^(coding|ralph):triage$/i;

export const isTriageLabel = (name: string) => TRIAGE_LABEL_NAME.test(name);
