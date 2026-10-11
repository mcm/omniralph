/**
 * The fixed vocabularies agent and task definitions are built from. Adding
 * a value here is a harness or control-panel change; definitions only pick
 * from them.
 */

/**
 * How the harness runs a task: `query` (one read-only session whose output
 * goes to a sink), `review` (a review run) or `coding` (a session that
 * changes code and ships it).
 */
export const TASK_TYPES = ["query", "review", "coding"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** Concurrency pools: `short` for query and review runs, `long` for coding runs. */
export const POOLS = ["short", "long"] as const;
export type PoolName = (typeof POOLS)[number];

/** Events that can start a task. */
export const TRIGGER_KINDS = [
  "pr.updated",
  "pr.mention",
  "review.rerun",
  "finding.mention",
  "finding.dismissed",
  "chat.request",
  "linear.delegated",
  "linear.triage",
  "linear.mention",
  "pr.review-findings",
  "pr.ci-failed",
  "pr.fix-command",
  "run.invoked",
] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/** The trigger of a story run: an epic (or single issue) delegated in Linear. */
export const STORY_TRIGGERS = ["linear.delegated"] as const satisfies readonly TriggerKind[];

/**
 * Triggers of a request run: a mention in Linear, a chat request, review
 * findings, a failed CI run or a fix command on the PR. Their runs need not
 * have an epic, so their prompts can't count on a PRD or a story.
 */
export const REQUEST_TRIGGERS = [
  "linear.mention",
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

/** Harness primitives served to sessions by the in-process `omniralph` MCP server. */
export const HARNESS_TOOLS = ["post_activity", "ask_permission", "get_attachment", "ship"] as const;
export type HarnessTool = (typeof HARNESS_TOOLS)[number];

/** Read-only Linear tools, served by the control panel through the same MCP server. */
export const LINEAR_TOOLS = [
  "linear_get_issue",
  "linear_list_comments",
  "linear_search_issues",
  "linear_get_document",
] as const;
export type LinearTool = (typeof LINEAR_TOOLS)[number];

/** The harness tools each task type allows; `ship` is for coding runs only. */
export const HARNESS_TOOLS_BY_TASK_TYPE: Record<TaskType, readonly HarnessTool[]> = {
  query: ["post_activity", "ask_permission", "get_attachment"],
  review: ["post_activity", "ask_permission", "get_attachment"],
  coding: HARNESS_TOOLS,
};
