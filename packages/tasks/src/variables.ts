/**
 * The variable catalog: every value a prompt template can use. A variable
 * comes from the trigger that started the run, from the task type (the
 * harness computes it while preparing the run) or from a setup command.
 * Untrusted values (anything a person or the model outside the run wrote)
 * are fenced when rendered, with the variable's `fence` info string.
 */
import type { TaskType, TriggerKind } from "./kinds.js";

export const VARIABLE_SOURCES = ["trigger", "taskType", "setup"] as const;
export type VariableSource = (typeof VARIABLE_SOURCES)[number];

export const VARIABLE_TRUST = ["trusted", "untrusted"] as const;
export type VariableTrust = (typeof VARIABLE_TRUST)[number];

interface VariableBase {
  /** Dotted name, e.g. `finding.title`. */
  name: string;
  trust: VariableTrust;
  /** Info string of the fence around an untrusted value (e.g. `diff`, `markdown`). */
  fence?: string;
  /**
   * Quotes an untrusted value between `<tag>` and `</tag>` lines instead of
   * fencing it (as today's triage prompt quotes Linear text); see `quote()`.
   */
  quote?: string;
  description: string;
}

export type VariableDefinition =
  | (VariableBase & { source: "trigger"; triggers: readonly TriggerKind[] })
  | (VariableBase & { source: "taskType"; taskTypes: readonly TaskType[] })
  | (VariableBase & { source: "setup" });

const PR_TRIGGERS = [
  "pr.updated",
  "pr.mention",
  "review.rerun",
  "finding.mention",
  "finding.dismissed",
  "pr.review-findings",
  "pr.ci-failed",
  "pr.fix-command",
] as const satisfies readonly TriggerKind[];
const FINDING_TRIGGERS = [
  "finding.mention",
  "finding.dismissed",
] as const satisfies readonly TriggerKind[];
const LINEAR_TRIGGERS = [
  "linear.delegated",
  "linear.triage",
  "linear.mention",
] as const satisfies readonly TriggerKind[];

export const VARIABLES: readonly VariableDefinition[] = [
  {
    name: "repository",
    source: "trigger",
    trust: "trusted",
    triggers: [...PR_TRIGGERS, "chat.request", "linear.triage"],
    description: "`owner/repo` or `group/project` (null when a Linear issue routes to none).",
  },
  {
    name: "branch",
    source: "trigger",
    trust: "trusted",
    triggers: ["chat.request", "linear.triage"],
    description: "Branch checked out in the working directory (the default branch).",
  },
  {
    name: "pr.number",
    source: "trigger",
    trust: "trusted",
    triggers: PR_TRIGGERS,
    description: "PR number (GitHub) or MR IID (GitLab).",
  },
  {
    name: "pr.title",
    source: "trigger",
    trust: "untrusted",
    triggers: PR_TRIGGERS,
    description: "Title of the pull request.",
  },
  {
    name: "pr.body",
    source: "trigger",
    trust: "untrusted",
    fence: "markdown",
    triggers: PR_TRIGGERS,
    description: "Description of the pull request.",
  },
  {
    name: "finding.file",
    source: "trigger",
    trust: "trusted",
    triggers: FINDING_TRIGGERS,
    description:
      "File of the finding, JSON-quoted (the trigger context's `finding.path` holds the raw path).",
  },
  {
    name: "finding.location",
    source: "trigger",
    trust: "trusted",
    triggers: FINDING_TRIGGERS,
    description: "`line N` or `lines N-M`.",
  },
  {
    name: "finding.severity",
    source: "trigger",
    trust: "trusted",
    triggers: FINDING_TRIGGERS,
    description: "Severity of the finding.",
  },
  {
    name: "finding.category",
    source: "trigger",
    trust: "trusted",
    triggers: FINDING_TRIGGERS,
    description: "Category of the finding.",
  },
  {
    name: "finding.title",
    source: "trigger",
    trust: "untrusted",
    triggers: FINDING_TRIGGERS,
    description: "Title of the finding.",
  },
  {
    name: "finding.body",
    source: "trigger",
    trust: "untrusted",
    fence: "markdown",
    triggers: FINDING_TRIGGERS,
    description: "Body of the finding.",
  },
  {
    name: "dismissal.note",
    source: "trigger",
    trust: "untrusted",
    triggers: ["finding.dismissed"],
    description: "Note left when the finding was dismissed (may be empty).",
  },
  {
    name: "chat.context",
    source: "trigger",
    trust: "untrusted",
    triggers: ["chat.request"],
    description: "The conversation so far (may be empty).",
  },
  {
    name: "issue.identifier",
    source: "trigger",
    trust: "trusted",
    triggers: LINEAR_TRIGGERS,
    description: "Linear issue identifier, e.g. `ENG-123`.",
  },
  {
    name: "issue.url",
    source: "trigger",
    trust: "trusted",
    triggers: LINEAR_TRIGGERS,
    description: "URL of the Linear issue (may be empty).",
  },
  {
    name: "issue.stateType",
    source: "trigger",
    trust: "trusted",
    triggers: LINEAR_TRIGGERS,
    description: "Linear workflow state type of the issue (`backlog`, `unstarted`, …).",
  },
  {
    name: "issue.creator.name",
    source: "trigger",
    trust: "trusted",
    triggers: LINEAR_TRIGGERS,
    description: "Name of the issue's creator (`issue.creator` is null when Linear doesn't say).",
  },
  {
    name: "issue.title",
    source: "trigger",
    trust: "untrusted",
    quote: "issue-title",
    triggers: LINEAR_TRIGGERS,
    description: "Title of the Linear issue.",
  },
  {
    name: "issue.description",
    source: "trigger",
    trust: "untrusted",
    quote: "issue-description",
    triggers: LINEAR_TRIGGERS,
    description: "Description of the Linear issue.",
  },
  // Triage: the issue's comments, sub-issues and blockers, the session's reply and the previous
  // triage. Lists are `{ items }` objects, null when empty, so a template can head them once.
  // Names, dates and one-line titles render as is, as today's triage prompt does.
  {
    name: "comments.items.author",
    source: "trigger",
    trust: "trusted",
    triggers: ["linear.triage"],
    description: "Author of a comment (null for an integration or a deleted user).",
  },
  {
    name: "comments.items.createdAt",
    source: "trigger",
    trust: "trusted",
    triggers: ["linear.triage"],
    description: "When a comment was posted (ISO 8601).",
  },
  {
    name: "comments.items.body",
    source: "trigger",
    trust: "untrusted",
    quote: "comment",
    triggers: ["linear.triage"],
    description: "Body of a comment, oldest first.",
  },
  ...(["id", "identifier", "stateType", "priority"] as const).map((field): VariableDefinition => ({
    name: `children.items.${field}`,
    source: "trigger",
    trust: "trusted",
    triggers: ["linear.triage"],
    description:
      field === "priority"
        ? "Linear priority name of a sub-issue (`No priority`, `Urgent` … `Low`)."
        : `\`${field}\` of a sub-issue, in sub-issue order.`,
  })),
  {
    name: "children.items.title",
    source: "trigger",
    trust: "untrusted",
    quote: "sub-issue-title",
    triggers: ["linear.triage"],
    description: "Title of a sub-issue.",
  },
  {
    name: "children.items.description",
    source: "trigger",
    trust: "untrusted",
    quote: "sub-issue-description",
    triggers: ["linear.triage"],
    description: "Description of a sub-issue.",
  },
  ...(["identifier", "stateType", "blocks", "title"] as const).map((field): VariableDefinition => ({
    name: `blockers.items.${field}`,
    source: "trigger",
    trust: "trusted",
    triggers: ["linear.triage"],
    description:
      field === "title"
        ? "Title of an issue blocking the issue or a sub-issue, on one line."
        : field === "blocks"
          ? "Identifier of the issue a blocker blocks."
          : `\`${field}\` of an issue blocking the issue or a sub-issue.`,
  })),
  {
    name: "reply",
    source: "trigger",
    trust: "untrusted",
    quote: "reply",
    triggers: ["linear.triage"],
    description: "A reply in the Linear session (e.g. answers to open questions; may be empty).",
  },
  ...(
    [
      ["outcome", "Outcome of the session's previous triage (`prd`, `reformat`, `unchanged`)."],
      ["size", "Size of the previous triage."],
      ["stories.items.index", "0-based index of a story of the previous triage."],
      ["stories.items.title", "Title of a story of the previous triage."],
      ["subIssueUpdates.items.id", "Linear ID of a sub-issue the previous triage reformatted."],
      ["subIssueUpdates.items.title", "Title of a sub-issue the previous triage reformatted."],
      ["openQuestions.items.number", "1-based number of an open question of the previous triage."],
      ["openQuestions.items.text", "An open question of the previous triage."],
    ] as const
  ).map(([field, description]): VariableDefinition => ({
    name: `previousResult.${field}`,
    source: "trigger",
    trust: "trusted",
    triggers: ["linear.triage"],
    description,
  })),
  {
    name: "previousResult.title",
    source: "trigger",
    trust: "untrusted",
    quote: "previous-title",
    triggers: ["linear.triage"],
    description: "Title the previous triage wrote.",
  },
  {
    name: "previousResult.description",
    source: "trigger",
    trust: "untrusted",
    quote: "previous-description",
    triggers: ["linear.triage"],
    description: "Description the previous triage wrote.",
  },
  {
    name: "question",
    source: "taskType",
    trust: "untrusted",
    taskTypes: ["query"],
    description: "The question or request the query answers.",
  },
  {
    name: "hunk",
    source: "taskType",
    trust: "untrusted",
    fence: "diff",
    taskTypes: ["query"],
    description: "Diff hunk around the finding (may be empty).",
  },
  {
    name: "conventions",
    source: "taskType",
    trust: "untrusted",
    fence: "markdown",
    taskTypes: ["query"],
    description: "The repository's `CLAUDE.md` from the default branch (may be empty).",
  },
  {
    name: "checkout",
    source: "taskType",
    trust: "trusted",
    taskTypes: ["query"],
    description: "True when the working directory holds a checkout of the run's ref.",
  },
];

/** The catalog entry named `name`, if any. */
export function findVariable(name: string): VariableDefinition | undefined {
  return VARIABLES.find((variable) => variable.name === name);
}

/**
 * Names of the variables a task can use: those its task type provides, and
 * those every one of its triggers provides. Setup variables are per task and
 * not included.
 */
export function availableVariables(taskType: TaskType, triggers: readonly TriggerKind[]): string[] {
  return VARIABLES.filter((variable) => {
    switch (variable.source) {
      case "taskType":
        return variable.taskTypes.includes(taskType);
      case "trigger":
        return triggers.length > 0 && triggers.every((t) => variable.triggers.includes(t));
      case "setup":
        return false;
    }
  }).map((variable) => variable.name);
}
