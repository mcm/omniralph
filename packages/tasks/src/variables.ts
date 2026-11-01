/**
 * The variable catalog: every value a prompt template can use. A variable
 * comes from the trigger that started the run, from the task type (the
 * agent computes it while preparing the run) or from a setup command.
 * Untrusted values (anything a person or the model outside the run wrote)
 * are fenced when rendered, with the variable's `fence` info string.
 */
import type { SetupCommand } from "./definitions.js";
import { REQUEST_TRIGGERS, STORY_TRIGGERS, type TaskType, type TriggerKind } from "./kinds.js";

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
   * fencing it (as today's triage prompt quotes tracker text); see `quote()`.
   */
  quote?: string;
  description: string;
}

export type VariableDefinition =
  | (VariableBase & { source: "trigger"; triggers: readonly TriggerKind[] })
  | (VariableBase & {
      source: "taskType";
      taskTypes: readonly TaskType[];
      /**
       * The first agent release that provides the variable, when later than
       * the release that runs its task types (`AGENT_VERSION_BY_TASK_TYPE`).
       * A task whose template uses it requires that release.
       */
      minAgentVersion?: string;
    })
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
/** Triggers of coding tasks: story runs and request runs. */
const CODING_TRIGGERS = [...STORY_TRIGGERS, ...REQUEST_TRIGGERS] as const;
/** Coding triggers, and the `run.invoked` of a query task a coding run invokes (`builtin:describe-pr`). */
const CODING_RUN_TRIGGERS = [...CODING_TRIGGERS, "run.invoked"] as const;
/** Triggers whose runs start from a work item in the tracker. */
const TRACKER_TRIGGERS = [
  "tracker.delegated",
  "tracker.triage",
  "tracker.mention",
] as const satisfies readonly TriggerKind[];

export const VARIABLES: readonly VariableDefinition[] = [
  {
    name: "tracker.name",
    source: "trigger",
    trust: "trusted",
    triggers: [...CODING_TRIGGERS, "tracker.triage"],
    description:
      "Display name of the tracker the run's work items live in: use it wherever the prompt names the tracker.",
  },
  {
    name: "tracker.conventionsFile",
    source: "trigger",
    trust: "trusted",
    triggers: ["tracker.triage"],
    description:
      "The repository file that may hold the project's conventions for the tracker's issues (named after the tracker, e.g. `<TRACKER>.md`).",
  },
  {
    name: "repository",
    source: "trigger",
    trust: "trusted",
    triggers: [...PR_TRIGGERS, "chat.request", "tracker.triage", "run.invoked"],
    description: "`owner/repo` or `group/project` (null when a work item routes to none).",
  },
  {
    name: "branch",
    source: "trigger",
    trust: "trusted",
    triggers: ["tracker.triage", ...CODING_RUN_TRIGGERS],
    description:
      "Branch checked out in the working directory: the default branch for a query, the run's branch for a coding run (and the PR description it invokes).",
  },
  {
    name: "pr.number",
    source: "trigger",
    trust: "trusted",
    triggers: [...PR_TRIGGERS, "run.invoked"],
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
    triggers: TRACKER_TRIGGERS,
    description: "Identifier of the issue in the tracker, e.g. `ENG-123`.",
  },
  {
    name: "issue.url",
    source: "trigger",
    trust: "trusted",
    triggers: TRACKER_TRIGGERS,
    description: "URL of the issue in the tracker (may be empty).",
  },
  {
    name: "issue.stateType",
    source: "trigger",
    trust: "trusted",
    triggers: TRACKER_TRIGGERS,
    description: "Workflow state type of the issue (`backlog`, `unstarted`, …).",
  },
  {
    name: "issue.creator.name",
    source: "trigger",
    trust: "trusted",
    triggers: TRACKER_TRIGGERS,
    description:
      "Name of the issue's creator (`issue.creator` is null when the tracker doesn't say).",
  },
  {
    name: "issue.title",
    source: "trigger",
    trust: "untrusted",
    quote: "issue-title",
    triggers: TRACKER_TRIGGERS,
    description: "Title of the issue.",
  },
  {
    name: "issue.description",
    source: "trigger",
    trust: "untrusted",
    quote: "issue-description",
    triggers: TRACKER_TRIGGERS,
    description: "Description of the issue.",
  },
  // Triage: the issue's comments, sub-issues and blockers, the session's reply and the previous
  // triage. Lists are `{ items }` objects, null when empty, so a template can head them once.
  // Names, dates and one-line titles render as is, as today's triage prompt does.
  {
    name: "comments.items.author",
    source: "trigger",
    trust: "trusted",
    triggers: ["tracker.triage"],
    description: "Author of a comment (null for an integration or a deleted user).",
  },
  {
    name: "comments.items.createdAt",
    source: "trigger",
    trust: "trusted",
    triggers: ["tracker.triage"],
    description: "When a comment was posted (ISO 8601).",
  },
  {
    name: "comments.items.body",
    source: "trigger",
    trust: "untrusted",
    quote: "comment",
    triggers: ["tracker.triage"],
    description: "Body of a comment, oldest first.",
  },
  ...(["id", "identifier", "stateType", "priority"] as const).map((field): VariableDefinition => ({
    name: `children.items.${field}`,
    source: "trigger",
    trust: "trusted",
    triggers: ["tracker.triage"],
    description:
      field === "priority"
        ? "Priority name of a sub-issue (`No priority`, `Urgent` … `Low`)."
        : `\`${field}\` of a sub-issue, in sub-issue order.`,
  })),
  {
    name: "children.items.title",
    source: "trigger",
    trust: "untrusted",
    quote: "sub-issue-title",
    triggers: ["tracker.triage"],
    description: "Title of a sub-issue.",
  },
  {
    name: "children.items.description",
    source: "trigger",
    trust: "untrusted",
    quote: "sub-issue-description",
    triggers: ["tracker.triage"],
    description: "Description of a sub-issue.",
  },
  ...(["identifier", "stateType", "blocks", "title"] as const).map((field): VariableDefinition => ({
    name: `blockers.items.${field}`,
    source: "trigger",
    trust: "trusted",
    triggers: ["tracker.triage"],
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
    triggers: ["tracker.triage"],
    description: "A reply in the tracker thread (e.g. answers to open questions; may be empty).",
  },
  ...(
    [
      ["outcome", "Outcome of the session's previous triage (`prd`, `reformat`, `unchanged`)."],
      ["size", "Size of the previous triage."],
      ["stories.items.index", "0-based index of a story of the previous triage."],
      ["stories.items.title", "Title of a story of the previous triage."],
      ["subIssueUpdates.items.id", "Tracker ID of a sub-issue the previous triage reformatted."],
      ["subIssueUpdates.items.title", "Title of a sub-issue the previous triage reformatted."],
      ["openQuestions.items.number", "1-based number of an open question of the previous triage."],
      ["openQuestions.items.text", "An open question of the previous triage."],
    ] as const
  ).map(([field, description]): VariableDefinition => ({
    name: `previousResult.${field}`,
    source: "trigger",
    trust: "trusted",
    triggers: ["tracker.triage"],
    description,
  })),
  {
    name: "previousResult.title",
    source: "trigger",
    trust: "untrusted",
    quote: "previous-title",
    triggers: ["tracker.triage"],
    description: "Title the previous triage wrote.",
  },
  {
    name: "previousResult.description",
    source: "trigger",
    trust: "untrusted",
    quote: "previous-description",
    triggers: ["tracker.triage"],
    description: "Description the previous triage wrote.",
  },
  // Correlation: the review run that invoked the run, with each task's results.
  {
    name: "reviewRun.tasks.items.taskId",
    source: "trigger",
    trust: "trusted",
    triggers: ["run.invoked"],
    description: "ID of a review task of the review run, in the repository's task order.",
  },
  {
    name: "reviewRun.tasks.items.name",
    source: "trigger",
    trust: "trusted",
    triggers: ["run.invoked"],
    description: "Name of the review task.",
  },
  {
    name: "reviewRun.tasks.items.summary",
    source: "trigger",
    trust: "untrusted",
    fence: "markdown",
    triggers: ["run.invoked"],
    description: "The summary the task's run wrote (null without one).",
  },
  {
    name: "reviewRun.tasks.items.findings",
    source: "trigger",
    trust: "untrusted",
    fence: "json",
    triggers: ["run.invoked"],
    description:
      "The task's findings as a JSON array (`id`, `path`, `startLine`, `endLine`, `severity`, `category`, `confidence`, `title`, `body`, `suggestion`); null without any.",
  },
  // Coding runs (story and request runs) and the PR description they invoke. Titles and
  // identifiers are put on one line and render as is; issue text, the PRD, requests, guidance,
  // progress and feedback are fenced.
  ...(
    [
      [
        "epic.identifier",
        CODING_RUN_TRIGGERS,
        "Tracker identifier of the epic (or single issue), e.g. `ENG-123`.",
      ],
      [
        "epic.title",
        CODING_RUN_TRIGGERS,
        "Title of the epic, on one line (a chat request's first line).",
      ],
      ["epic.url", CODING_TRIGGERS, "URL of the epic in the tracker (null without one)."],
      [
        "epic.single",
        CODING_TRIGGERS,
        "True when the run works a single issue rather than an epic with stories.",
      ],
      [
        "baseBranch",
        CODING_RUN_TRIGGERS,
        "The repository's default branch: the run's branch starts from it and the PR targets it.",
      ],
      ["prTerm", CODING_RUN_TRIGGERS, "`pull request` (GitHub) or `merge request` (GitLab)."],
      ["prTermCapitalized", CODING_TRIGGERS, "`Pull request` or `Merge request`."],
      [
        "qualityGates.items",
        CODING_RUN_TRIGGERS,
        "A quality gate (shell command): the PRD's gates not run by the orchestrator for a story, every gate otherwise.",
      ],
      [
        "qualityGates.inline",
        CODING_RUN_TRIGGERS,
        "The quality gates in backticks, comma-separated (`qualityGates` is null without any).",
      ],
      ["stories.items.identifier", CODING_RUN_TRIGGERS, "ID of a story of the epic, in order."],
      ["stories.items.title", CODING_RUN_TRIGGERS, "Title of the story, on one line."],
      ["stories.completed", CODING_TRIGGERS, "How many stories are completed or cancelled."],
      ["stories.total", CODING_TRIGGERS, "How many stories the epic has."],
      [
        "stories.items.mark",
        CODING_TRIGGERS,
        "Status of the story: `[x]` completed, `[-]` cancelled, `[~]` in progress, `[ ]` open.",
      ],
      ["stories.items.manual", CODING_TRIGGERS, "True for a step only a person can do."],
      [
        "stories.items.repository",
        CODING_TRIGGERS,
        "Repository the story is worked in, when it isn't the epic's main one (else null).",
      ],
      [
        "stories.items.dependsOn",
        CODING_TRIGGERS,
        "The stories or issues it waits for, comma-separated (null for none).",
      ],
      ["stories.items.current", STORY_TRIGGERS, "True for the story the run works on."],
      [
        "stories.items.commit",
        ["run.invoked"],
        "First 10 characters of the story's commit (null without one).",
      ],
      ["story.id", STORY_TRIGGERS, "ID of the story the run works on (its tracker identifier)."],
      ["story.identifier", STORY_TRIGGERS, "Tracker identifier of the story (null without one)."],
      ["story.url", STORY_TRIGGERS, "URL of the story in the tracker (null without one)."],
      ["story.title", STORY_TRIGGERS, "Title of the story, on one line."],
      [
        "story.kind",
        STORY_TRIGGERS,
        "Kind of the story: `Fix` (a bug, by the tracker's fix labels) or `Story` (new work).",
      ],
      [
        "epic.planning",
        STORY_TRIGGERS,
        "True when the epic is in the planning format (`## Problem`, `## Scope`, `## Requirements`): its description is background for the story, not a PRD.",
      ],
      [
        "story.fix",
        STORY_TRIGGERS,
        "A Fix's behavior sections (`current`, `expected`, `unchanged`); null for a Story.",
      ],
      [
        "story.covers.items.id",
        STORY_TRIGGERS,
        "Identifier of an epic requirement the story owns, from its `Covers:` line (e.g. `FR-2`); `story.covers` is null without any.",
      ],
      [
        "story.repository",
        STORY_TRIGGERS,
        "Repository the story is worked in, when it isn't the epic's main one (else null).",
      ],
      [
        "followUps",
        STORY_TRIGGERS,
        "True when the orchestrator files follow-up work as new stories of the epic (not for a single issue).",
      ],
      [
        "fromChat",
        REQUEST_TRIGGERS,
        "True when the requests come from a chat thread, false for the tracker.",
      ],
      [
        "ship",
        REQUEST_TRIGGERS,
        "True for `/ship`: the session prepares one commit, which the orchestrator makes and pushes.",
      ],
      ["prUrl", REQUEST_TRIGGERS, "URL of the branch's open PR (null when none is open)."],
    ] as const
  ).map(([name, triggers, description]): VariableDefinition => ({
    name,
    source: "trigger",
    trust: "trusted",
    triggers,
    description,
  })),
  {
    name: "epic.prd",
    source: "trigger",
    trust: "untrusted",
    fence: "markdown",
    triggers: CODING_RUN_TRIGGERS,
    description:
      "The epic's PRD (its description); null for a single issue or a blank one. Cut to 6,000 characters for a request or a PR description.",
  },
  {
    name: "story.description",
    source: "trigger",
    trust: "untrusted",
    fence: "markdown",
    triggers: STORY_TRIGGERS,
    description:
      "Description of the story, without its acceptance criteria, `Covers:` line or a Fix's behavior sections (null when blank).",
  },
  ...(
    [
      ["story.fix.current", "## Current behavior"],
      ["story.fix.expected", "## Expected behavior"],
      ["story.fix.unchanged", "## Unchanged behavior"],
    ] as const
  ).map(([name, section]): VariableDefinition => ({
    name,
    source: "trigger",
    trust: "untrusted",
    fence: "markdown",
    triggers: STORY_TRIGGERS,
    description: `A Fix's \`${section}\` section (null when it has none, or for a Story).`,
  })),
  {
    name: "story.covers.items.text",
    source: "trigger",
    trust: "untrusted",
    triggers: STORY_TRIGGERS,
    description:
      "Text of the requirement in the epic's `## Requirements` (null when the epic doesn't have it).",
  },
  {
    name: "story.acceptanceCriteria.items",
    source: "trigger",
    trust: "untrusted",
    triggers: STORY_TRIGGERS,
    description:
      "An acceptance criterion of the story (`story.acceptanceCriteria` is null without any).",
  },
  {
    name: "story.notes",
    source: "trigger",
    trust: "untrusted",
    fence: "markdown",
    triggers: STORY_TRIGGERS,
    description: "Notes on the story (null without any).",
  },
  {
    name: "guidance.items",
    source: "trigger",
    trust: "untrusted",
    triggers: STORY_TRIGGERS,
    description:
      "A reply from the team in the agent session, oldest first (`guidance` is null without any).",
  },
  {
    name: "requests",
    source: "trigger",
    trust: "untrusted",
    triggers: REQUEST_TRIGGERS,
    description: "The requests the run handles, trimmed, oldest first.",
  },
  {
    name: "progressLog",
    source: "trigger",
    trust: "untrusted",
    fence: "markdown",
    triggers: ["run.invoked"],
    description: "The end (12,000 characters) of the coding run's progress log (null when blank).",
  },
  {
    name: "progress",
    source: "taskType",
    trust: "untrusted",
    fence: "markdown",
    taskTypes: ["coding"],
    description: "The run's progress log so far: learnings of earlier sessions (null when empty).",
  },
  {
    name: "codebasePatterns",
    source: "taskType",
    trust: "untrusted",
    fence: "markdown",
    taskTypes: ["coding"],
    description: "The `## Codebase Patterns` section of the progress log (null without one).",
  },
  {
    name: "recentProgress",
    source: "taskType",
    trust: "untrusted",
    fence: "markdown",
    taskTypes: ["coding"],
    description: "The latest five entries of the progress log (null without any).",
  },
  {
    name: "feedback",
    source: "taskType",
    trust: "untrusted",
    taskTypes: ["coding"],
    description:
      "Why the previous attempt at the story didn't complete, e.g. failed gate output (null on the first attempt).",
  },
  ...(
    [
      ["attempt", "Which attempt at the story this is (1 on the first)."],
      ["maxAttempts", "Attempts a story gets (the task's `maxAttemptsPerStory`)."],
      [
        "stashes",
        "Stash entries of earlier sessions offered to this one (`{ items }`, null when none): a story's earlier attempts, or for `/ship` earlier request sessions, newest first.",
      ],
      ["stashes.items.sha", "SHA of a stash entry."],
      ["stashes.items.label", "The message it was stashed with."],
      ["stashes.items.date", "When it was stashed (ISO 8601)."],
      [
        "progressFile",
        "Path of the file the session appends its learnings to (a copy of the progress log).",
      ],
      ["today", "Today's date, `YYYY-MM-DD`."],
      [
        "attachments",
        "Markdown list of the tracker attachments the session can open, with their paths (null without any).",
      ],
      [
        "appendInstruction",
        "Extra instructions from the repository's settings (null without any).",
      ],
      [
        "checks.items",
        "A command the orchestrator runs itself after the session: the repo's checks, then the PRD's gates it runs (`checks` is null without any).",
      ],
      ["remoteUrl", "URL of the worktree's `origin` remote (null without one)."],
      [
        "historyRewriteAllowed",
        "True when a request may rewrite the branch's history (the repository's `historyRewrite` is `when-asked` or `always`).",
      ],
      [
        "historyRewriteAlways",
        "True when the session rebases instead of ever merging, without being asked (the repository's `historyRewrite` is `always`).",
      ],
    ] as const
  ).map(([name, description]): VariableDefinition => ({
    name,
    source: "taskType",
    trust: "trusted",
    taskTypes: ["coding"],
    description,
  })),
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
    taskTypes: ["query", "review"],
    description:
      "The repository's `CLAUDE.md`: the checkout's for a query, the base commit's for a review (may be empty).",
  },
  // Review: the profile's depth, the rubric and the repository's rules (the stable prompt prefix),
  // then the diff under review, its plan and risk pre-pass, and the open findings to re-check.
  {
    name: "depth",
    source: "taskType",
    trust: "trusted",
    taskTypes: ["review"],
    description:
      "How thoroughly to review, from the review depth (e.g. `Quick review: look only at the diff. …`).",
  },
  {
    name: "rubric",
    source: "taskType",
    trust: "trusted",
    taskTypes: ["review"],
    description:
      "The agent's rubric reference docs for the diff's languages: `rubric/universal.md`, then `rubric/languages/<language>.md` per language (null without any).",
  },
  {
    name: "repositoryRules",
    source: "taskType",
    trust: "trusted",
    taskTypes: ["review"],
    description:
      "The repository's custom instructions and enabled rules, written or approved by its admins (null when it has neither).",
  },
  {
    name: "repositoryRules.instructions",
    source: "taskType",
    trust: "trusted",
    taskTypes: ["review"],
    description: "The repository's custom instructions, trimmed (null when none).",
  },
  {
    name: "repositoryRules.rules.items.number",
    source: "taskType",
    trust: "trusted",
    taskTypes: ["review"],
    description: "1-based number of an enabled rule: custom rules first, then learned ones.",
  },
  {
    name: "repositoryRules.rules.items.text",
    source: "taskType",
    trust: "trusted",
    taskTypes: ["review"],
    description: "Text of an enabled rule, on one line.",
  },
  {
    name: "diff",
    source: "taskType",
    trust: "untrusted",
    fence: "diff",
    taskTypes: ["review"],
    description: "Diff of the files under review (empty when nothing is left to review).",
  },
  {
    name: "plan",
    source: "taskType",
    trust: "trusted",
    taskTypes: ["review"],
    description: "The review plan (scope, files and skipped files), as JSON.",
  },
  ...(
    [
      ["mode", "`full` (the whole change) or `incremental` (the commits since the last review)."],
      ["baseSha", "Base commit of the change."],
      ["fromSha", "First commit of an incremental review's range, exclusive (null when full)."],
      ["headSha", "Head commit under review."],
      ["files", "Paths of the files under review."],
      ["skipped.path", "Path of a file the plan skipped."],
      ["skipped.reason", "Why it was skipped (`excluded`, `generated`, `binary`, …)."],
    ] as const
  ).map(([field, description]): VariableDefinition => ({
    name: `plan.${field}`,
    source: "taskType",
    trust: "trusted",
    taskTypes: ["review"],
    description,
  })),
  {
    name: "risk",
    source: "taskType",
    trust: "trusted",
    taskTypes: ["review"],
    description: "The risk pre-pass's hints, as JSON.",
  },
  {
    name: "risk.complexityScore",
    source: "taskType",
    trust: "trusted",
    taskTypes: ["review"],
    description: "Complexity of the diff, 0 to 10.",
  },
  {
    name: "risk.hotspots",
    source: "taskType",
    trust: "trusted",
    taskTypes: ["review"],
    description:
      "Markdown list of the files and patterns the risk pre-pass flagged (null when none).",
  },
  {
    name: "previousFindings",
    source: "taskType",
    trust: "untrusted",
    fence: "json",
    taskTypes: ["review"],
    description: "Open findings of earlier reviews to re-check (null when none).",
  },
  ...(
    [
      [
        "id",
        "Id of an open finding (its position in the list), for the `previousFindings` answer.",
      ],
      ["path", "File of an open finding (backticks removed)."],
      ["lines", "`N` or `N-M`: its lines in the version reviewed then."],
      ["category", "Its category."],
    ] as const
  ).map(([field, description]): VariableDefinition => ({
    name: `previousFindings.items.${field}`,
    source: "taskType",
    trust: "trusted",
    taskTypes: ["review"],
    description,
  })),
  {
    name: "previousFindings.items.text",
    source: "taskType",
    trust: "untrusted",
    fence: "markdown",
    taskTypes: ["review"],
    description: "Its title and (capped) body (null without either).",
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
export function availableVariables(
  taskType: TaskType,
  triggers: readonly TriggerKind[],
  catalog: readonly VariableDefinition[] = VARIABLES,
): string[] {
  return catalog
    .filter((variable) => {
      switch (variable.source) {
        case "taskType":
          return variable.taskTypes.includes(taskType);
        case "trigger":
          return triggers.length > 0 && triggers.every((t) => variable.triggers.includes(t));
        case "setup":
          return false;
      }
    })
    .map((variable) => variable.name);
}

/**
 * The catalog entries of a task's setup commands: `setup.<name>`, untrusted,
 * fenced with the command's `fence` info string.
 */
export function setupVariables(
  setupCommands: readonly Pick<SetupCommand, "name" | "fence" | "optional">[],
): VariableDefinition[] {
  return setupCommands.map((command) => ({
    name: `setup.${command.name}`,
    source: "setup",
    trust: "untrusted",
    ...(command.fence !== "" && { fence: command.fence }),
    description: command.optional
      ? `Output of the setup command \`${command.name}\` (a short failure note when it fails).`
      : `Output of the setup command \`${command.name}\`.`,
  }));
}

type TaskVariableSource = {
  taskType: TaskType;
  triggers: readonly TriggerKind[];
  setupCommands: readonly Pick<SetupCommand, "name" | "fence" | "optional">[];
};

/** The catalog a task's prompt template renders with: `VARIABLES` plus its setup variables. */
export function taskCatalog(task: Pick<TaskVariableSource, "setupCommands">): VariableDefinition[] {
  return [...VARIABLES, ...setupVariables(task.setupCommands)];
}

/** Names of every variable a task can use: `availableVariables` plus its `setup.<name>` variables. */
export function taskVariables(
  task: TaskVariableSource,
  catalog: readonly VariableDefinition[] = VARIABLES,
): string[] {
  return [
    ...availableVariables(task.taskType, task.triggers, catalog),
    ...task.setupCommands.map((command) => `setup.${command.name}`),
  ];
}
