import { roleTaskType, type PlaybookRole } from "@omniralph/tasks";
import type { PlaybookUsedBy } from "@/lib/api/playbooks";
import { pinBadges } from "@/lib/fleet/status";

/** Advanced › Playbooks. */
export const PLAYBOOKS_PATH = "/settings/advanced/playbooks";

/** A playbook's page (`builtin:` IDs keep their colon encoded). */
export function playbookHref(id: string): string {
  return `${PLAYBOOKS_PATH}/${encodeURIComponent(id)}`;
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
};

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
