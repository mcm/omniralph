import {
  PLAYBOOK_ROLES,
  roleTaskType,
  type PlaybookRole,
  type TrackerTool,
  type TriggerKind,
} from "@omniralph/tasks";
import type { PlaybookUsedBy } from "@/lib/api/playbooks";
import { pinBadges } from "@/lib/fleet/status";

/** Advanced › Playbooks. */
export const PLAYBOOKS_PATH = "/settings/advanced/playbooks";

/** A playbook's page (`builtin:` IDs keep their colon encoded). */
export function playbookHref(id: string): string {
  return `${PLAYBOOKS_PATH}/${encodeURIComponent(id)}`;
}

/** Advanced › Playbooks › New playbook. */
export const NEW_PLAYBOOK_PATH = `${PLAYBOOKS_PATH}/new`;

/** A custom playbook's editor. */
export function playbookEditHref(id: string): string {
  return `${playbookHref(id)}/edit`;
}

/** Each role in plain words. */
export const PLAYBOOK_ROLE_LABELS: Record<PlaybookRole, string> = {
  review: "Review",
  "review-summary": "Review summary",
  correlation: "Correlation",
  story: "Story",
  request: "Request",
  "pr-description": "Pull request description",
  "chat-ask": "Chat answer",
  triage: "Triage",
  "learn-rule": "Learn rule",
  "reply-to-finding": "Reply to finding",
  verifier: "Verifier",
  audit: "Epic audit",
};

/** Each trigger kind in plain words: what starts a run. */
export const TRIGGER_KIND_LABELS: Record<TriggerKind, string> = {
  "pr.updated": "Pull request opened or updated",
  "pr.mention": "Mention on a pull request",
  "review.rerun": "Review rerun",
  "finding.mention": "Reply to a finding",
  "finding.dismissed": "Finding dismissed",
  "chat.request": "Chat request",
  "tracker.delegated": "Work item delegated to Om",
  "tracker.triage": "Work item sent to triage",
  "tracker.mention": "Mention on a work item",
  "pr.review-findings": "Review findings on a pull request",
  "pr.ci-failed": "CI failed on a pull request",
  "pr.fix-command": "Fix command on a pull request",
  "run.invoked": "Started by another run",
};

/** The events that start a role's runs, in plain words. */
export function roleTriggerLabels(role: PlaybookRole): string[] {
  return PLAYBOOK_ROLES[role].triggers.map((kind) => TRIGGER_KIND_LABELS[kind]);
}

/** Each tracker tool in plain words. */
export const TRACKER_TOOL_LABELS: Record<TrackerTool, string> = {
  tracker_get_issue: "Read a work item",
  tracker_list_comments: "Read a work item's comments",
  tracker_search_issues: "Search work items",
  tracker_get_document: "Read a document",
};

/** A tracker tool's label; a name the labels don't know (saved before a rename) as is. */
export function trackerToolLabel(name: string): string {
  return Object.hasOwn(TRACKER_TOOL_LABELS, name) ? TRACKER_TOOL_LABELS[name as TrackerTool] : name;
}

/** What the repo binding roles and chat playbooks are called where a playbook is used. */
export const REPOSITORY_BINDING_LABELS: Record<
  PlaybookUsedBy["repositories"][number]["roles"][number],
  string
> = {
  review: "Review",
  correlation: "Correlation",
  story: "Story",
  request: "Request",
};
export const CHAT_PLAYBOOK_LABELS: Record<PlaybookUsedBy["chatPlaybooks"][number], string> = {
  ask: "Ask about code",
  startWork: "Start work",
};

export const DEFAULT_MODEL_LABEL = "Claude Code default";
export const REVIEW_MODEL_LABEL = "Set by the review depth";

/**
 * A playbook's model in words: its model, else the Claude Code default. Review playbooks
 * never set one: the repo's review depth picks it.
 */
export function modelLabel(role: PlaybookRole, model: string | null): string {
  if (model !== null) return model;
  return roleTaskType(role) === "review" ? REVIEW_MODEL_LABEL : DEFAULT_MODEL_LABEL;
}

/** Whether a chat playbook or a chat channel override runs the playbook. */
export function usedByChat(usedBy: PlaybookUsedBy): boolean {
  return usedBy.chatPlaybooks.length > 0 || usedBy.chatChannels.length > 0;
}

/** The list's "Used by": one or two repos (or the first and "+N"), and whether chat uses it. */
export function usedBySummary(usedBy: PlaybookUsedBy) {
  return { ...pinBadges(usedBy.repositories), chat: usedByChat(usedBy) };
}

/** Whether nothing uses the playbook. */
export function isUnused(usedBy: PlaybookUsedBy): boolean {
  return usedBy.repositories.length === 0 && !usedByChat(usedBy) && usedBy.playbooks.length === 0;
}
