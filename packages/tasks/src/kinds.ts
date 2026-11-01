/**
 * The fixed vocabularies agent and task definitions are built from. Adding
 * a value here is an agent or control-panel change; definitions only pick
 * from them.
 */

/**
 * How the agent runs a task: `query` (one read-only session whose output
 * goes to a sink), `review` (a review run) or `coding` (a session that
 * changes code and ships it).
 */
export const TASK_TYPES = ["query", "review", "coding"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** Events that can start a task. */
export const TRIGGER_KINDS = [
  "pr.updated",
  "pr.mention",
  "review.rerun",
  "finding.mention",
  "finding.dismissed",
  "chat.request",
  "tracker.delegated",
  "tracker.triage",
  "tracker.mention",
  "pr.review-findings",
  "pr.ci-failed",
  "pr.fix-command",
  "run.invoked",
] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/** The trigger of a story run: an epic (or single work item) delegated in the tracker. */
export const STORY_TRIGGERS = ["tracker.delegated"] as const satisfies readonly TriggerKind[];

/**
 * Triggers of a request run: a mention in the tracker, a chat request, review
 * findings, a failed CI run or a fix command on the PR. Their runs need not
 * have an epic, so their prompts can't count on a PRD or a story.
 */
export const REQUEST_TRIGGERS = [
  "tracker.mention",
  "chat.request",
  "pr.review-findings",
  "pr.ci-failed",
  "pr.fix-command",
] as const satisfies readonly TriggerKind[];

/** Control-panel code that applies a run's output, keyed by kind. */
export const SINK_KINDS = [
  "chat-thread",
  "finding-thread",
  "learned-rule",
  "triage",
  "review",
  "sticky-comment",
  "run-result",
  "ralph-run",
] as const;
export type SinkKind = (typeof SINK_KINDS)[number];

/** Agent primitives served to sessions by the in-process `omniralph` MCP server. */
export const AGENT_TOOLS = ["post_activity", "ask_permission", "get_attachment", "ship"] as const;
export type AgentTool = (typeof AGENT_TOOLS)[number];

/** Read-only issue tracker tools, served by the control panel through the same MCP server. */
export const TRACKER_TOOLS = [
  "tracker_get_issue",
  "tracker_list_comments",
  "tracker_search_issues",
  "tracker_get_document",
] as const;
export type TrackerTool = (typeof TRACKER_TOOLS)[number];

/** The agent tools each task type allows; `ship` is for coding runs only. */
export const AGENT_TOOLS_BY_TASK_TYPE: Record<TaskType, readonly AgentTool[]> = {
  query: ["post_activity", "ask_permission", "get_attachment"],
  review: ["post_activity", "ask_permission", "get_attachment"],
  coding: AGENT_TOOLS,
};

/**
 * The trigger kinds each task type accepts: the events the control panel
 * starts a run of that type for. Review runs start on PR/MR events; coding
 * runs on story and request triggers; query runs on everything else they
 * answer (finding threads, chat, triage, a run that invokes them).
 */
export const TRIGGERS_BY_TASK_TYPE: Record<TaskType, readonly TriggerKind[]> = {
  query: ["finding.mention", "finding.dismissed", "chat.request", "tracker.triage", "run.invoked"],
  review: ["pr.updated", "pr.mention", "review.rerun"],
  coding: [...STORY_TRIGGERS, ...REQUEST_TRIGGERS],
};
