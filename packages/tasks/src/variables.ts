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
    triggers: [...PR_TRIGGERS, "chat.request"],
    description: "`owner/repo` or `group/project`.",
  },
  {
    name: "branch",
    source: "trigger",
    trust: "trusted",
    triggers: ["chat.request"],
    description: "Branch checked out in the working directory.",
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
    name: "issue.title",
    source: "trigger",
    trust: "untrusted",
    triggers: LINEAR_TRIGGERS,
    description: "Title of the Linear issue.",
  },
  {
    name: "issue.description",
    source: "trigger",
    trust: "untrusted",
    fence: "markdown",
    triggers: LINEAR_TRIGGERS,
    description: "Description of the Linear issue.",
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
