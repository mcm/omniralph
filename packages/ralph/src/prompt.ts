/**
 * The prompts of ralph's Claude sessions (ported from cyralph). The story prompt is modelled on
 * ralph-tui's JSON tracker template: full PRD context first, then codebase patterns, then exactly
 * one story, then the workflow and stop condition.
 *
 * Custom templates use a Handlebars-compatible subset: `{{var}}`, `{{#if var}}...{{else}}...{{/if}}`.
 */
import {
  COVERED_REQUIREMENTS_HEADING,
  COVERED_REQUIREMENTS_NOTE,
  CRITERIA_AS_EVIDENCE_NOTE,
  EPIC_CONTEXT_HEADING,
  EPIC_CONTEXT_NOTE,
  FIX_SECTIONS,
  FIX_TASK_NOTE,
  UNKNOWN_REQUIREMENT_TEXT,
  requirementId,
  splitFixDescription,
} from "@omniralph/planning";
import { extractCodebasePatterns, recentProgressEntries } from "./progress.js";
import { templateList, type TemplateList } from "./triage.js";
import { type Epic, type Story, dependencyLabel } from "./types.js";

/**
 * Commands with duplicates dropped (compared with whitespace collapsed), first occurrence kept. A command
 * that's both a PRD quality gate and a repository verify command should only run once.
 */
export function uniqueCommands(commands: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const cmd of commands) {
    const key = normalizeCommand(cmd);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(cmd.trim());
  }
  return out;
}

function normalizeCommand(cmd: string): string {
  return cmd.trim().replace(/\s+/g, " ");
}

/**
 * The resource rule of every session that runs commands: the machine is shared
 * with other sessions and workloads, so never exhaust it.
 */
export const GOOD_NEIGHBOR_RULE = `- Be a good neighbor: always assume you share this machine's CPU, memory, disk and network with other sessions and workloads, and never assume what resources are available. Run tests and builds the usual way, one at a time. Never stress test by saturating all cores, running several instances of a test suite at once, or otherwise exhausting the machine's resources.`;

/** System prompt addition of a story session: the job owns git, the control panel owns the tracker. */
export const RALPH_SYSTEM_APPEND = `You are "Omniralph", an autonomous engineer working an epic one user story at a time (the coding loop).
- Work only on the single story you are given; other stories get their own sessions.
- Never run git commit, git push, or open pull requests: the orchestrator handles version control and work item updates. If guidance asks for a push or a PR/MR, skip that part without comment; the orchestrator does it.
- Be precise and verifiable. Only report the status "complete" in your structured result when the story truly meets its acceptance criteria.
- You may run subagents and commands in the background. To wait for them, end your turn with the status "waiting": the session stays open, you are resumed as each finishes (for up to an hour), and only your last structured result counts. Stop background processes you no longer need (e.g. dev servers) before you finish.
${GOOD_NEIGHBOR_RULE}`;

/** A stash entry offered to a story session for review (see `## Stashed Work`). */
export interface OfferedStash {
  sha: string;
  label: string;
  /** When it was stashed (ISO 8601). */
  date: string;
}

export interface PromptContext {
  /** The tracker's display name (the provider's, from the server), where the prompt names it. */
  trackerName: string;
  epic: Epic;
  story: Story;
  /** Where the session appends its learnings (a copy of the run's progress log). */
  progressFile: string;
  /** The run's progress log: its Codebase Patterns and latest entries go into the prompt. */
  progress?: string;
  /** The Codebase Patterns to show; defaults to those of `progress`. */
  codebasePatterns?: string;
  /** The latest progress entries to show (the log's tail); defaults to the last five of `progress`. */
  recentProgress?: string;
  /** Output of failed quality gates / previous failed attempt for this story. */
  previousAttemptFeedback?: string;
  /** Follow-up instructions from humans in the tracker's agent session. */
  guidance?: string[];
  attempt: number;
  maxAttempts: number;
  /** Extra instructions from repository config. */
  appendInstruction?: string;
  /** The orchestrator files `followUps` as sub-issues of the epic (tracker-backed epics only). */
  followUps?: boolean;
  /**
   * Commands the orchestrator runs itself after the agent reports the story complete (the lane
   * repository's checks, then the PRD's gates it runs). Quality gates among them aren't repeated
   * as the agent's to run, so each check runs once.
   */
  checks?: string[];
  /** Stash entries of earlier sessions of this story that haven't been applied yet. */
  stashes?: OfferedStash[];
  /** Markdown list of the tracker attachments the session can open (see `formatAttachments`). */
  attachments?: string;
  /** Today's date in the progress entry heading; defaults to now. */
  now?: Date;
}

export const DEFAULT_STORY_TEMPLATE = `{{#if planningEpic}}You are working through an epic from {{trackerName}}, one task per session.
Each session starts with a fresh context: the epic, the progress log and the repo are your memory.

## Epic: {{epicTitle}} ({{epicIdentifier}}){{else}}You are working through a PRD epic from {{trackerName}}, one user story per session.
Each session starts with a fresh context: the PRD, the progress log and the repository are your memory.

## PRD: {{epicTitle}} ({{epicIdentifier}}){{/if}}
### Progress: {{completedCount}}/{{totalCount}} stories complete

{{#if prdOverview}}
{{#if planningEpic}}### ${EPIC_CONTEXT_HEADING}
${EPIC_CONTEXT_NOTE}

<epic-context>
{{prdOverview}}
</epic-context>
{{else}}<prd-document>
{{prdOverview}}
</prd-document>
{{/if}}

{{/if}}
### All Stories
{{storyList}}

{{#if codebasePatterns}}
## Codebase Patterns (Study These First)
{{codebasePatterns}}

{{/if}}
## Your Task: {{storyId}} - {{storyTitle}}
{{#if storyIdentifier}}{{trackerName}} issue: {{storyIdentifier}}{{#if storyUrl}} ({{storyUrl}}){{/if}}
{{/if}}Kind: {{storyKind}}
{{#if isFix}}
${FIX_TASK_NOTE}
{{/if}}

{{#if repository}}Repository: \`{{repository}}\`. This story belongs in this repository rather than the epic's main one, and this worktree is a checkout of it: make every change here.
{{/if}}
{{#if storyDescription}}
### Description
{{storyDescription}}

{{/if}}
{{#if currentBehavior}}
### ${FIX_SECTIONS.current}
{{currentBehavior}}

{{/if}}
{{#if expectedBehavior}}
### ${FIX_SECTIONS.expected}
{{expectedBehavior}}

{{/if}}
{{#if unchangedBehavior}}
### ${FIX_SECTIONS.unchanged}
{{unchangedBehavior}}

{{/if}}
{{#if coveredRequirements}}
### ${COVERED_REQUIREMENTS_HEADING}
${COVERED_REQUIREMENTS_NOTE}
{{coveredRequirements}}

{{/if}}
{{#if acceptanceCriteria}}
### Acceptance Criteria
${CRITERIA_AS_EVIDENCE_NOTE}
{{acceptanceCriteria}}

{{/if}}
{{#if notes}}
### Notes
{{notes}}

{{/if}}
{{#if attachments}}
### Attachments
Files attached in {{trackerName}} (screenshots, mockups, documents). Open each one with the Read tool (it shows images) before you start, and treat them as part of the spec:
{{attachments}}

{{/if}}
{{#if qualityGates}}
### Quality Gates (must pass before you report the story complete)
{{qualityGates}}

{{/if}}
{{#if checks}}
### Checked by the Orchestrator
The orchestrator runs these itself after you report the story complete and sends any failure back to you, so you don't need to run them as a final check (run one earlier only if you need its output while working):
{{checks}}

{{/if}}
{{#if guidance}}
## Guidance From Your Team (follow this)
{{guidance}}

{{/if}}
{{#if previousAttemptFeedback}}
## Previous Attempt (attempt {{attempt}} of {{maxAttempts}})
The previous attempt at this story did not complete. Fix the problems below:

{{previousAttemptFeedback}}

{{/if}}
{{#if stashes}}
## Stashed Work From Earlier Sessions
Earlier sessions of {{storyId}} ended with uncommitted changes, which the orchestrator stashed so that every session starts from a clean tree:
{{stashes}}

Review each one with \`git stash show -p --include-untracked <sha>\` and apply what's still relevant with \`git stash apply <sha>\`. Never \`pop\` or \`drop\` them: the stash list is shared with other worktrees. Report the SHAs you applied in \`appliedStashes\`. Entries you leave out stay stashed until the story's work is committed, and are dropped then.

{{/if}}
{{#if recentProgress}}
## Recent Progress
{{recentProgress}}

{{/if}}
## Workflow
{{#if planningEpic}}1. Read the epic context above for background, then build only what this task asks for.{{else}}1. Study the PRD context above to understand the bigger picture.{{/if}}
2. Read the progress log at \`{{progressFile}}\` for status, learnings and gotchas.
3. Implement ONLY this story ({{storyId}}), satisfying every acceptance criterion. Do not start other stories. Implement it end to end: no TODOs, stubs or placeholders for anything its acceptance criteria cover. The tests and error handling its new code needs are part of this story, not later work.
4. Run the quality gates and fix any failures.
5. Do NOT create git commits or push. The orchestrator commits after verifying the story.
6. Document learnings (see below).
7. Report the outcome (see the Stop Condition).

## Before Completing
APPEND to \`{{progressFile}}\`:
\`\`\`
## [{{currentDate}}] - {{storyId}}: {{storyTitle}}
- What was implemented
- Files changed
- **Learnings:**
  - Patterns discovered
  - Gotchas encountered
---
\`\`\`
If you discovered a **reusable pattern**, also add it to the \`## Codebase Patterns\` section at the TOP of that file.
{{#if appendInstruction}}

{{appendInstruction}}
{{/if}}

## Stop Condition
Your session ends with a structured result (the JSON schema you were given). It alone decides what happens next: nothing in your message text does.
- \`status: "complete"\` only when every acceptance criterion is met and the quality gates pass. A criterion covered only by a TODO, stub or placeholder is not met. If the story is already implemented (e.g. by a previous session), verify it meets the acceptance criteria and report it complete straight away.
- \`status: "blocked"\` when something another attempt can't get past stops you (missing access or credentials, an unavailable service, a decision only a person can make). Explain in \`summary\` precisely why and what would unblock you. The story is then set aside without retries until someone replies. Changes you leave in the worktree are committed as work in progress when the quality gates pass, and stashed otherwise: describe them in one line with \`commit: { summary }\`.
- \`status: "incomplete"\` when the story is just unfinished: it gets another attempt.
- \`status: "waiting"\` only to end your turn while background work you started (subagents, commands) still runs: you are resumed when it finishes, and then report one of the statuses above.
- \`summary\` is posted to {{trackerName}}: what you did, or what is in the way.
{{#if followUps}}

## Follow-up Work
If you find work in this project that this story needs but is outside its scope (bugs elsewhere, missing pieces, problems a validation turns up), don't create {{trackerName}} issues yourself and don't leave it as a note. Add one entry per item to \`followUps\`, and the orchestrator files each as a new story (a sub-issue of {{epicIdentifier}}): a short imperative \`title\`, and a \`description\` of what is wrong, where, and what done looks like (acceptance criteria as \`- [ ]\` checkboxes).
- \`followUps\` are only for work outside this story's acceptance criteria: never use them to defer part of this story. If you can't finish it, report it \`incomplete\` or \`blocked\`.
- If {{storyId}} can't be completed until they are fixed, report it \`blocked\`, not complete. They will block {{storyId}}, be worked first, and then {{storyId}} runs again. Each such round (a review loop filing its fixes, say) doesn't use up an attempt, but rounds are capped.
- If {{storyId}} measures its progress across rounds (e.g. a critique score it must raise to a bar), report this round's value as \`metric\`: a \`name\`, the \`value\`, its \`direction\` (\`higher\` or \`lower\` is better) and, if it has one, the \`target\`. Use the same name and direction every round: a loop whose best value hasn't improved for a few rounds is set aside. Otherwise leave \`metric\` out.
- If {{storyId}} is complete anyway, report it complete, and they join the epic as new stories.
- If an item is work only a person can do (granting access, changing settings in an outside service, a decision), set \`manual: true\`. It is filed for a person and never attempted by an agent; stories it blocks wait until a person marks it done.
- If an item depends on this epic being merged, so it can't be part of this epic (e.g. removing a fallback once everything this epic changes has shipped), set \`after: "epic"\` and say why in \`reason\`. It is filed as a task of its own that follows {{epicIdentifier}}, blocked by it, and never blocks {{storyId}} or any other story: it doesn't make {{storyId}} blocked.
{{else}}
- Leave \`followUps\` empty.
{{/if}}

## Recommendations
Never file follow-ups, or create issues yourself, for another project or repository (an upstream library, a tool or service another team owns): \`followUps\` are only for work in this project. When a change elsewhere would help (e.g. "fix this upstream in X so we can remove the Y workaround"), work around it here and add one entry to \`recommendations\`: a short imperative \`title\`, and a \`description\` naming the project or repository, what to change there, and what it would let this one drop. Recommendations are shown to people, never filed as issues, and don't hold {{storyId}} up: report its status as you would without them. Only when {{storyId}} can't be done without the change elsewhere, report it \`blocked\` and say why in \`summary\`.
`;

type Vars = Record<string, string | number | undefined>;

/** Render the Handlebars-compatible subset. Unknown vars render as empty. */
export function renderTemplate(template: string, vars: Vars): string {
  const truthy = (k: string) => {
    const v = vars[k];
    return v !== undefined && v !== "" && v !== 0;
  };
  // Innermost-first resolution of {{#if}} blocks handles nesting.
  const ifBlock = /\{\{#if\s+(\w+)\}\}((?:(?!\{\{#if\s)[\s\S])*?)\{\{\/if\}\}/;
  let out = template;
  for (let m = ifBlock.exec(out); m; m = ifBlock.exec(out)) {
    const [whole, key = "", body = ""] = m;
    const [thenPart, elsePart = ""] = body.split("{{else}}");
    out =
      out.slice(0, m.index) +
      (truthy(key) ? thenPart : elsePart) +
      out.slice(m.index + whole.length);
  }
  return out
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => String(vars[k] ?? ""))
    .replace(/\n{3,}/g, "\n\n");
}

const STATUS_MARK: Record<Story["status"], string> = {
  completed: "[x]",
  cancelled: "[-]",
  in_progress: "[~]",
  open: "[ ]",
};

export function formatStoryList(epic: Epic, current?: Story): string {
  return epic.stories
    .map((s) => {
      const deps = s.dependsOn.map((d) => dependencyLabel(epic, d));
      const depText = deps.length ? ` (depends on ${deps.join(", ")})` : "";
      const here = current?.key === s.key ? "  <- current" : "";
      const manual = s.manual
        ? " (manual step for a person, not for you)"
        : s.repo
          ? ` (in ${s.repo.name})`
          : "";
      return `- ${STATUS_MARK[s.status]} ${s.storyId}: ${s.title}${manual}${depText}${here}`;
    })
    .join("\n");
}

function completedCount(epic: Epic): number {
  return epic.stories.filter((s) => s.status === "completed" || s.status === "cancelled").length;
}

/** The commands the orchestrator runs, and the PRD's quality gates not among them (each runs once). */
function storyGates(ctx: Pick<PromptContext, "epic" | "checks">): {
  checks: string[];
  qualityGates: string[];
} {
  const checks = uniqueCommands(ctx.checks ?? []);
  const checked = new Set(checks.map(normalizeCommand));
  const qualityGates = uniqueCommands(ctx.epic.qualityGates).filter(
    (g) => !checked.has(normalizeCommand(g)),
  );
  return { checks, qualityGates };
}

/** How a story's kind reads in its prompt. */
export type StoryKindLabel = "Fix" | "Story";

/** `Fix` for a fix, else `Story` (a story without a kind is new work). */
export function storyKindLabel(story: Pick<Story, "kind">): StoryKindLabel {
  return story.kind === "fix" ? "Fix" : "Story";
}

/** Whether the epic is in the planning format (it has `## Requirements`), not a legacy PRD or a single issue. */
function planningEpic(epic: Epic): boolean {
  return epic.kind !== "single" && epic.requirements !== undefined;
}

/** A requirement of a story's `Covers:` line, with its text from the epic (null when the epic doesn't have it). */
export interface CoveredRequirement {
  id: string;
  text: string | null;
}

/** The requirements of `story`'s `Covers:` line that are requirement identifiers, with their text from `epic`. */
export function coveredRequirements(epic: Epic, story: Story): CoveredRequirement[] {
  return (story.covers ?? [])
    .filter((id) => requirementId(id))
    .map((id) => ({
      id,
      text: epic.requirements?.find((r) => r.id === id)?.text.trim() || null,
    }));
}

/** A story's description as its prompt shows it: a Fix's behavior sections apart from the rest. */
function storyParts(story: Story) {
  const description = story.description.trim();
  if (story.kind !== "fix") {
    return { description, current: null, expected: null, unchanged: null };
  }
  return splitFixDescription(description);
}

export function buildStoryPrompt(ctx: PromptContext, template = DEFAULT_STORY_TEMPLATE): string {
  const { epic, story } = ctx;
  const completed = completedCount(epic);
  const { checks, qualityGates } = storyGates(ctx);
  const parts = storyParts(story);
  const vars: Vars = {
    planningEpic: planningEpic(epic) ? "yes" : undefined,
    trackerName: ctx.trackerName,
    epicTitle: epic.title,
    epicIdentifier: epic.identifier,
    epicUrl: epic.url,
    prdOverview: epic.kind === "single" ? undefined : epic.description.trim() || undefined,
    completedCount: completed,
    totalCount: epic.stories.length,
    storyList: formatStoryList(epic, story),
    codebasePatterns:
      ctx.codebasePatterns ?? (ctx.progress ? extractCodebasePatterns(ctx.progress) : undefined),
    storyId: story.storyId,
    storyTitle: story.title,
    storyIdentifier: story.identifier,
    storyUrl: story.url,
    storyKind: storyKindLabel(story),
    isFix: story.kind === "fix" ? "yes" : undefined,
    repository: story.repo?.name,
    storyDescription: parts.description || undefined,
    currentBehavior: parts.current ?? undefined,
    expectedBehavior: parts.expected ?? undefined,
    unchangedBehavior: parts.unchanged ?? undefined,
    coveredRequirements:
      coveredRequirements(epic, story)
        .map((r) => `- ${r.id}: ${r.text ?? UNKNOWN_REQUIREMENT_TEXT}`)
        .join("\n") || undefined,
    acceptanceCriteria: story.acceptanceCriteria.map((c) => `- [ ] ${c}`).join("\n") || undefined,
    notes: story.notes,
    attachments: ctx.attachments,
    qualityGates: qualityGates.map((g) => `- \`${g}\``).join("\n") || undefined,
    checks: checks.map((g) => `- \`${g}\``).join("\n") || undefined,
    guidance: ctx.guidance?.length
      ? ctx.guidance.map((g) => `- ${g.replace(/\n/g, "\n  ")}`).join("\n")
      : undefined,
    previousAttemptFeedback: ctx.previousAttemptFeedback,
    attempt: ctx.attempt,
    maxAttempts: ctx.maxAttempts,
    recentProgress:
      ctx.recentProgress ?? (ctx.progress ? recentProgressEntries(ctx.progress) : undefined),
    progressFile: ctx.progressFile,
    currentDate: (ctx.now ?? new Date()).toISOString().slice(0, 10),
    appendInstruction: ctx.appendInstruction,
    followUps: ctx.followUps ? "yes" : undefined,
    stashes: ctx.stashes?.length
      ? ctx.stashes.map((e) => `- \`${e.sha}\` ${e.label} (${e.date})`).join("\n")
      : undefined,
  };
  return renderTemplate(template, vars).trim();
}

export interface DescribePrPromptContext {
  epic: Epic;
  branch: string;
  baseBranch: string;
  /** "pull request" or "merge request". */
  prTerm: string;
  /** A file with the progress log, if the session can read one. */
  progressFile?: string;
  /** The progress log itself, quoted into the prompt (for sessions that can't read files outside the repository). */
  progress?: string;
  /** The stories the branch implements, in order (defaults to the epic's). */
  stories?: readonly { identifier: string; title: string; commitSha?: string | null }[];
}

/** Longest PR/MR title the describe session may write. */
export const PR_TITLE_MAX_LENGTH = 72;

/** Marks a describe-the-PR session (tests and logs tell it apart from story/request sessions by this). */
export const PR_DESCRIPTION_HEADING = "## Write the title and description";

/** System prompt addition for the read-only session that writes a PR/MR title and description. */
export const PR_DESCRIPTION_SYSTEM_APPEND = `You are "Omniralph", writing the title and description of a pull/merge request for work that is already committed.
- Only read: inspect the repository and git history (\`git log\`, \`git diff\`, \`git show\`). Don't edit files, commit, push, or run gh/glab.
- Report the title and description in your structured result (\`title\`, \`body\`).`;

/** The end of a long text, marked as cut. */
function lastPart(text: string, max: number): string {
  return text.length > max ? `…\n${text.slice(-max)}` : text;
}

/** The stories a PR/MR description lists: `ctx.stories`, or the epic's. */
function describedStories(
  ctx: DescribePrPromptContext,
): NonNullable<DescribePrPromptContext["stories"]> {
  return (
    ctx.stories ??
    ctx.epic.stories.map((s) => ({ identifier: s.identifier ?? s.storyId, title: s.title }))
  );
}

/**
 * Prompt for a short session that reads the branch's changes and writes the PR/MR title and
 * description: a summary of the deliverable a reviewer without access to the tracker can follow, the
 * stories it implements (with their identifiers) and how it was verified.
 */
export function buildDescribePrPrompt(ctx: DescribePrPromptContext): string {
  const { epic, baseBranch, prTerm } = ctx;
  const background = epic.description.trim();
  const stories = describedStories(ctx);
  const gates = uniqueCommands(epic.qualityGates);
  const progress = ctx.progress?.trim();
  return [
    `The branch \`${ctx.branch}\` in this git worktree is ready for a ${prTerm} into \`${baseBranch}\`. It implements "${epic.title}" (${epic.identifier}).`,
    "",
    ...(background
      ? [
          `Background from the issue tracker (for context only; readers of the ${prTerm} can't see it):`,
          "<issue-background>",
          prdExcerpt(background),
          "</issue-background>",
          "",
        ]
      : []),
    ...(stories.length > 0
      ? [
          "The stories the branch implements, one commit each (identifier, title, commit):",
          ...stories.map(
            (s) =>
              `- ${s.identifier}: ${s.title}${s.commitSha ? ` (\`${s.commitSha.slice(0, 10)}\`)` : ""}`,
          ),
          "",
        ]
      : []),
    ...(gates.length > 0
      ? [
          "Every story passed these quality gates before it was committed:",
          ...gates.map((g) => `- \`${g}\``),
          "",
        ]
      : []),
    ...(progress
      ? [
          "Notes from the sessions that did the work (decisions, gotchas):",
          "<progress-log>",
          lastPart(progress, 12_000),
          "</progress-log>",
          "",
        ]
      : ctx.progressFile
        ? [
            `Notes from the sessions that did the work (decisions, gotchas) are in \`${ctx.progressFile}\`, if it exists.`,
            "",
          ]
        : []),
    PR_DESCRIPTION_HEADING,
    `1. Study what actually changed: \`git log --reverse --format='%s%n%b' origin/${baseBranch}..HEAD\` and \`git diff origin/${baseBranch}...HEAD\` (use \`${baseBranch}\` instead of \`origin/${baseBranch}\` if that ref doesn't exist), reading files where the diff alone isn't clear.`,
    `2. Write a title and description for the ${prTerm} that a reviewer with no access to the issue tracker can follow:`,
    `   - Title: one line, imperative mood, at most ${PR_TITLE_MAX_LENGTH} characters, summarising the change itself. No issue identifiers or prefixes.`,
    "   - Description (markdown): open with a short summary of what the change delivers and why. Then the notable changes, grouped by area, in a few bullets.",
    "   - Add a **Stories** section listing every story above as `- <identifier>: <title>`, with the identifier exactly as given.",
    `   - Add a **Verification** section saying how the change was verified (the quality gates above${gates.length > 0 ? "" : ", if any"}, tests the stories added), without claiming checks that didn't run.`,
    "   - Add a **Breaking changes** section if behaviour, configuration, APIs or data formats change incompatibly, saying what users must do. Omit it otherwise.",
    "   - Add a **Decisions** section for judgement calls, trade-offs or deviations from the request that a reviewer should know about. Omit it if there were none.",
    "   - Don't describe the development process or the progress log, and don't link the issue tracker; that is added for you.",
    "   - Be concrete and concise; don't pad with generic statements or restate the diff line by line.",
    "3. Don't change any files.",
    "",
    "Report them as the `title` and the markdown `body` of your structured result.",
  ].join("\n");
}

/** Whether a request may rewrite the branch's history (the repo's `history_rewrite`). */
export type HistoryRewritePolicy = "when-asked" | "always" | "never";

/** Where a request session's requests come from: the tracker (its session or comments) or a chat thread. */
export type RequestSource = "tracker" | "chat";

/** Marks a request session's prompt (tests and logs tell it apart from story sessions by this). */
export const REQUEST_HEADING = "## Request from your team";

/**
 * System prompt addition of a request session (cyralph's `requestSystemAppend`):
 * it may commit and push its branch, never another one, rewrites history only
 * when asked (and allowed) or, with `always`, rebases instead of ever merging,
 * and asks for PR/MR changes in its result.
 */
export function requestSystemAppend(
  historyRewrite: HistoryRewritePolicy = "when-asked",
  source: RequestSource = "tracker",
  options: { ship?: boolean; trackerName?: string } = {},
): string {
  const tracker = options.trackerName ?? "the tracker";
  if (options.ship) return shipSystemAppend(source, tracker);
  const rewrite =
    historyRewrite === "always"
      ? "- History rewrites are allowed on the epic branch without being asked, and merges are not: never merge the base branch (or any other branch) into it. When it needs the base branch (it is behind or conflicts with it), or the request asks for a rebase, squash, amend or reword, do it and push with `git push --force-with-lease`, never a plain `--force`."
      : historyRewrite === "when-asked"
        ? "- Don't rewrite history on your own initiative. When the request explicitly asks for it (rebase, squash, amend, reword), do it on the epic branch and push with `git push --force-with-lease`. That is allowed here."
        : "- Never rewrite published history or force-push in this repository. If asked to rebase or squash, explain that it is disabled here and offer to merge the base branch instead.";
  const where =
    source === "chat"
      ? "a request in a chat thread about a repository"
      : `a request in a thread on ${tracker} about a PRD epic`;
  const thread = source === "chat" ? "the chat thread" : `the thread on ${tracker}`;
  return `You are "Omniralph", an autonomous engineer responding to ${where}.
- Do what the request asks. You may use git (commit, push) when the request calls for it.
- Don't run \`gh\` or \`glab\`: they aren't set up here. Ask for pull/merge request changes (open, update, mark ready) through \`pullRequest\` in your structured result; the orchestrator makes them.
- Only push the epic branch you are on. Never push to, or force-push, the base branch or any other branch.
${rewrite}
- The \`summary\` of your structured result is posted to ${thread}: summarise what you did, with links (e.g. the PR/MR URL).
- You may run subagents and commands in the background. To wait for them, end your turn with \`waiting: true\` in your structured result: the session stays open, you are resumed as each finishes (for up to an hour), and only your last structured result counts. Stop background processes you no longer need (e.g. dev servers) before you finish.
${GOOD_NEIGHBOR_RULE}`;
}

/**
 * System prompt addition of a `/ship` request session: it prepares one
 * commit and describes it; the job commits, pushes and opens the PR/MR.
 */
function shipSystemAppend(source: RequestSource, tracker: string): string {
  const where = source === "chat" ? "a chat thread" : `a thread on ${tracker}`;
  const thread = source === "chat" ? "the chat thread" : `the thread on ${tracker}`;
  return `You are "Omniralph", an autonomous engineer shipping the work on a branch for ${where}.
- Don't run \`git commit\`, \`git push\`, \`git stash pop\`/\`drop\` or any command that rewrites history: the orchestrator commits everything left in the worktree with the \`commit.message\` of your structured result, then pushes the branch.
- Don't run \`gh\` or \`glab\`: they aren't set up here. Ask for pull/merge request changes (open, update) through \`pullRequest\` in your structured result; the orchestrator makes them after it pushes.
- The \`summary\` of your structured result is posted to ${thread}.
${GOOD_NEIGHBOR_RULE}`;
}

/** A stash entry a `/ship` session may bring back into the worktree. */
export interface ShipStash {
  sha: string;
  label: string;
  date: string;
}

export interface RequestPromptContext {
  /** The tracker's display name (the provider's, from the server), where the prompt names it. */
  trackerName: string;
  epic: Epic;
  /** The requests from the tracker or chat thread, oldest first. */
  requests: readonly string[];
  /**
   * Where the requests come from. A chat request's epic is a stand-in (the
   * run's reference and the request's first line, no stories), so its prompt
   * names neither the tracker nor a story status. Default "tracker".
   */
  source?: RequestSource;
  /** The branch of the worktree the session runs in. */
  branch: string;
  baseBranch: string;
  /** The worktree's `origin` URL, if it has one. */
  remoteUrl?: string;
  /** The branch's open PR/MR, if any. */
  prUrl?: string;
  /** Where the progress log (learnings from earlier sessions) is. */
  progressFile: string;
  qualityGates: readonly string[];
  /** "pull request" or "merge request". */
  prTerm?: string;
  /** May a request rewrite the epic branch's history (`always`: rebase, never merge)? Default "when-asked". */
  historyRewrite?: HistoryRewritePolicy;
  /** Markdown list of the tracker attachments the session can open. */
  attachments?: string;
  /** Extra instructions from the repository's settings. */
  appendInstruction?: string;
  /**
   * `/ship`: the session prepares one commit instead of committing itself;
   * `stashes` are what earlier request sessions left uncommitted.
   */
  ship?: { stashes: readonly ShipStash[] };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Prompt of a direct request from the tracker thread (an @mention, or a reply
 * no story picked up), e.g. "push and open a PR" (cyralph's
 * `buildRequestPrompt`), or from a chat thread. Like Cyrus, the agent acts on
 * it itself; PR/MR changes go through its structured result.
 */
export function buildRequestPrompt(ctx: RequestPromptContext): string {
  const { epic } = ctx;
  const term = ctx.prTerm ?? "pull request";
  const done = completedCount(epic);
  const prd = epic.kind === "single" ? "" : epic.description.trim();
  const gates = uniqueCommands(ctx.qualityGates);
  const chat = ctx.source === "chat";
  const intro = chat
    ? [
        `You are working on a request from a chat thread: ${epic.title}.`,
        `It is implemented on branch \`${ctx.branch}\` (base \`${ctx.baseBranch}\`) in this git worktree.`,
      ]
    : [
        `You are working on ${ctx.trackerName} ${epic.identifier}: ${epic.title}.`,
        epic.kind === "single"
          ? `It is implemented on branch \`${ctx.branch}\` (base \`${ctx.baseBranch}\`) in this git worktree.`
          : `It is a PRD epic implemented one story per commit on branch \`${ctx.branch}\` (base \`${ctx.baseBranch}\`) in this git worktree.`,
        "",
        `## Status: ${done}/${epic.stories.length} stories complete`,
        formatStoryList(epic),
      ];
  const lines = [
    ...intro,
    "",
    `- Git remote \`origin\`: ${ctx.remoteUrl ? `\`${ctx.remoteUrl}\`` : "none configured"}`,
    `- ${capitalize(term)}: ${ctx.prUrl ?? "none opened yet"}`,
    `- Progress log (learnings from earlier sessions): \`${ctx.progressFile}\``,
    ...(gates.length ? [`- Quality gates: ${gates.map((g) => `\`${g}\``).join(", ")}`] : []),
    ...(prd ? ["", "<prd-document>", prdExcerpt(prd), "</prd-document>"] : []),
    ...(ctx.attachments
      ? [
          "",
          "## Attachments",
          `Files attached ${chat ? "to the request" : `in ${ctx.trackerName}`}. Open the ones relevant to the request with the Read tool (it shows images):`,
          ctx.attachments,
        ]
      : []),
    "",
    REQUEST_HEADING,
    ...ctx.requests.map((r) => `> ${r.trim().replace(/\n/g, "\n> ")}\n`),
    ...(ctx.ship ? shipInstructions(ctx, term, gates) : requestInstructions(ctx, term)),
    ...(ctx.appendInstruction?.trim() ? ["", ctx.appendInstruction.trim()] : []),
  ];
  return lines.join("\n").trim();
}

/** "How to handle it" of an ordinary request session. */
function requestInstructions(ctx: RequestPromptContext, term: string): string[] {
  const chat = ctx.source === "chat";
  const thread = chat ? "chat thread" : `thread on ${ctx.trackerName}`;
  return [
    "## How to handle it",
    "- This is a direct request, not a story. Do what it asks, and nothing beyond it.",
    `- You may commit, and push \`${ctx.branch}\` to \`origin\` (\`git push -u origin ${ctx.branch}\`), when the request calls for it. Never push to \`${ctx.baseBranch}\` or any other branch.`,
    ctx.historyRewrite === "always"
      ? `- History rewrites are allowed on \`${ctx.branch}\` without being asked, and merges are not: never merge \`${ctx.baseBranch}\` (or any other branch) into \`${ctx.branch}\`. When \`${ctx.branch}\` needs \`${ctx.baseBranch}\` (it is behind or conflicts with it) or the request asks for a rebase: \`git fetch origin && git rebase origin/${ctx.baseBranch}\`, resolve conflicts, run the quality gates, then \`git push --force-with-lease origin ${ctx.branch}\`. If the lease is rejected (someone else pushed), stop and report it instead of overwriting their work.`
      : (ctx.historyRewrite ?? "when-asked") === "when-asked"
        ? `- History rewrites are allowed on \`${ctx.branch}\` when the request asks for one. For a rebase: \`git fetch origin && git rebase origin/${ctx.baseBranch}\`, resolve conflicts, run the quality gates, then \`git push --force-with-lease origin ${ctx.branch}\`. Do the rebase that was asked for; don't substitute a merge. If the lease is rejected (someone else pushed), stop and report it instead of overwriting their work.`
        : `- History rewrites (rebase, squash, force-push) are disabled for this repository. If the request asks for one, say so and offer to merge \`${ctx.baseBranch}\` into \`${ctx.branch}\` instead.`,
    ctx.remoteUrl
      ? `- For the ${term}, don't run \`gh\` or \`glab\`. Push \`${ctx.branch}\` first, then set \`pullRequest\` in your structured result: \`open\` opens it into \`${ctx.baseBranch}\` as a draft, \`update\` changes the open one's title or description, \`ready\` marks it ready for review. Give \`open\` a title summarising the change itself and a description of the deliverable written for reviewers who can't see ${chat ? "the chat thread" : ctx.trackerName}: what it does and why, notable changes, and any breaking changes or judgement calls.${chat ? "" : " Don't list the user stories."}`
      : "- There is no `origin` remote yet, so pushing or opening a pull/merge request isn't possible until one is added.",
    "- If you change code, run the quality gates and commit with a clear message.",
    "- If the request is ambiguous or can't be done (e.g. missing credentials), say exactly what's missing instead of guessing.",
    `- Finish with a short summary for the ${thread} of what you did, including any ${term} URL, as the \`summary\` of your structured result.`,
  ];
}

/** "How to handle it" of a `/ship` session: it prepares the commit, the job makes and pushes it. */
function shipInstructions(
  ctx: RequestPromptContext,
  term: string,
  gates: readonly string[],
): string[] {
  const stashes = ctx.ship?.stashes ?? [];
  const chat = ctx.source === "chat";
  return [
    "## How to handle it",
    `This is \`/ship\`: the work on \`${ctx.branch}\` is to be committed, pushed and put up for review. You prepare the commit; the orchestrator makes it with your message, pushes \`${ctx.branch}\` to \`origin\` and makes the ${term} change you ask for. Don't commit or push yourself.`,
    "",
    "1. See what the worktree has: `git status` and `git diff` (uncommitted changes), and `git log --oneline origin/" +
      ctx.branch +
      "..HEAD` (commits not pushed yet; the ref may not exist if the branch was never pushed).",
    ...(stashes.length > 0
      ? [
          "2. Earlier request sessions on this branch left uncommitted work, which was stashed (newest first):",
          ...stashes.map((s) => `   - \`${s.sha}\` (${s.date}): ${s.label}`),
          "   Review each with `git stash show -p --include-untracked <sha>` and bring back what belongs in this commit with `git stash apply <sha>`. Never `pop` or `drop` them: the stash list is shared with other worktrees.",
        ]
      : ["2. No earlier request session left stashed work on this branch."]),
    "3. If the request above says more than `/ship` (notes, a last fix), do that first.",
    gates.length > 0
      ? `4. Run the quality gates (${gates.map((g) => `\`${g}\``).join(", ")}) and fix any failures.`
      : "4. Check that the change builds and its tests pass, as far as the repository lets you.",
    "5. Leave in the worktree only what belongs in the commit: everything left (including untracked files) is committed with `git add -A`. Delete scratch files; add generated ones to `.gitignore`.",
    "6. Report `commit.message` in your structured result: a one-line subject, a blank line, and a short body saying what changed and why. Leave `commit` out when there's nothing to commit (the orchestrator still pushes commits that aren't on `origin` yet).",
    ctx.prUrl
      ? `7. The ${term} is open (${ctx.prUrl}). If its title or description no longer match the branch, set \`pullRequest\` to \`update\` with a new title and description; otherwise leave \`pullRequest\` out.`
      : `7. No ${term} is open yet: set \`pullRequest\` to \`open\` with a title summarising the change itself and a description written for reviewers who can't see ${chat ? "the chat thread" : ctx.trackerName} (what it does and why, notable changes, breaking changes or judgement calls).${chat ? "" : " Don't list the user stories."}`,
    "- If something stops you (failing gates you can't fix, a conflict, missing credentials), leave `commit` out and say exactly what's wrong in `summary`: nothing is committed or pushed then.",
    `- \`summary\` is posted to the ${chat ? "chat thread" : `thread on ${ctx.trackerName}`}: say what is being committed and pushed, in a sentence or two.`,
  ];
}

/*
 * Template contexts: the values the built-in coding tasks' prompt templates
 * (`builtin:implement-story`, `builtin:handle-request`, `builtin:describe-pr`
 * in `@omniralph/tasks`) render, computed from the inputs of the builders
 * above so both render the same prompt. The renderer fences the untrusted
 * values (issue text, the PRD, requests, guidance, progress and feedback)
 * itself; titles and names are put on one line instead.
 */

/** One line: whitespace (newlines included) collapsed. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A list of quality gates or commands: the commands, and them inline (`` `a`, `b` ``). */
export type CommandList = { items: string[]; inline: string } | null;

function commandList(commands: readonly string[]): CommandList {
  return commands.length > 0
    ? { items: [...commands], inline: commands.map((c) => `\`${c}\``).join(", ") }
    : null;
}

/** A story of the epic's story list (`formatStoryList`). */
export interface StoryListItem {
  /** `[x]` completed, `[-]` cancelled, `[~]` in progress, `[ ]` open. */
  mark: string;
  identifier: string;
  title: string;
  manual: boolean;
  /** The repository it's worked in, when not the epic's main one. */
  repository: string | null;
  /** The stories (or external issues) it waits for, comma-separated; null for none. */
  dependsOn: string | null;
  /** The story the session works on. */
  current: boolean;
}

export interface StoryListContext {
  completed: number;
  total: number;
  items: StoryListItem[];
}

function storyListContext(epic: Epic, current?: Story): StoryListContext {
  return {
    completed: completedCount(epic),
    total: epic.stories.length,
    items: epic.stories.map((s) => ({
      mark: STATUS_MARK[s.status],
      identifier: s.storyId,
      title: oneLine(s.title),
      manual: s.manual === true,
      repository: s.repo?.name ?? null,
      dependsOn: s.dependsOn.map((d) => dependencyLabel(epic, d)).join(", ") || null,
      current: current?.key === s.key,
    })),
  };
}

/** The tracker the run's work items live in, as the coding templates name it (`tracker.name`). */
export interface TrackerTemplateContext {
  /** Its display name (the provider's, from the server). */
  name: string;
}

/** What `builtin:implement-story`'s template renders (see `buildStoryPrompt`). */
export interface StoryTemplateContext {
  tracker: TrackerTemplateContext;
  epic: {
    identifier: string;
    title: string;
    url: string | null;
    /** The PRD (the epic's description); null for a single issue or a blank one. */
    prd: string | null;
    single: boolean;
    /** The epic is in the planning format: its description is background for the task, not a PRD. */
    planning: boolean;
  };
  stories: StoryListContext;
  story: {
    /** The story's ID in the epic (its tracker identifier for a tracker-backed epic). */
    id: string;
    /** Its tracker identifier; null when it has none. */
    identifier: string | null;
    url: string | null;
    title: string;
    /** `Fix` (a bug, by the tracker's fix labels) or `Story` (new work). */
    kind: StoryKindLabel;
    /** The repository it's worked in, when not the epic's main one. */
    repository: string | null;
    /** Trimmed, without a Fix's behavior sections; null when blank. */
    description: string | null;
    /** A Fix's behavior sections (each null when it has none); null for a Story. */
    fix: {
      current: string | null;
      expected: string | null;
      unchanged: string | null;
    } | null;
    /** The requirements of its `Covers:` line, with their text from the epic. */
    covers: TemplateList<CoveredRequirement>;
    acceptanceCriteria: TemplateList<string>;
    notes: string | null;
  };
  /** The PRD's quality gates the orchestrator doesn't run itself. */
  qualityGates: CommandList;
  /** The commands the orchestrator runs after the session (the repo's checks, then the PRD's gates it runs). */
  checks: CommandList;
  /** The latest guidance from the team, oldest first. */
  guidance: TemplateList<string>;
  /** Why the previous attempt didn't complete; null on the first attempt. */
  feedback: string | null;
  attempt: number;
  maxAttempts: number;
  stashes: TemplateList<OfferedStash>;
  progress: string | null;
  codebasePatterns: string | null;
  recentProgress: string | null;
  progressFile: string;
  /** Today's date (`YYYY-MM-DD`). */
  today: string;
  attachments: string | null;
  appendInstruction: string | null;
  followUps: boolean;
}

/** `ctx` as the context of a `builtin:implement-story` run (see `StoryTemplateContext`). */
export function storyTemplateContext(ctx: PromptContext): StoryTemplateContext {
  const { epic, story } = ctx;
  const { checks, qualityGates } = storyGates(ctx);
  const parts = storyParts(story);
  return {
    tracker: { name: ctx.trackerName },
    epic: {
      identifier: epic.identifier,
      title: oneLine(epic.title),
      url: epic.url ?? null,
      prd: epic.kind === "single" ? null : epic.description.trim() || null,
      single: epic.kind === "single",
      planning: planningEpic(epic),
    },
    stories: storyListContext(epic, story),
    story: {
      id: story.storyId,
      identifier: story.identifier || null,
      url: story.url || null,
      title: oneLine(story.title),
      kind: storyKindLabel(story),
      repository: story.repo?.name ?? null,
      description: parts.description || null,
      fix:
        story.kind === "fix"
          ? { current: parts.current, expected: parts.expected, unchanged: parts.unchanged }
          : null,
      covers: templateList(coveredRequirements(epic, story)),
      acceptanceCriteria: templateList(story.acceptanceCriteria),
      notes: story.notes || null,
    },
    qualityGates: commandList(qualityGates),
    checks: commandList(checks),
    guidance: templateList(ctx.guidance),
    feedback: ctx.previousAttemptFeedback || null,
    attempt: ctx.attempt,
    maxAttempts: ctx.maxAttempts,
    stashes: templateList(ctx.stashes),
    progress: ctx.progress || null,
    codebasePatterns:
      (ctx.codebasePatterns ??
        (ctx.progress ? extractCodebasePatterns(ctx.progress) : undefined)) ||
      null,
    recentProgress:
      (ctx.recentProgress ?? (ctx.progress ? recentProgressEntries(ctx.progress) : undefined)) ||
      null,
    progressFile: ctx.progressFile,
    today: (ctx.now ?? new Date()).toISOString().slice(0, 10),
    attachments: ctx.attachments || null,
    appendInstruction: ctx.appendInstruction || null,
    followUps: ctx.followUps === true,
  };
}

/** What `builtin:handle-request`'s template renders (see `buildRequestPrompt`). */
export interface RequestTemplateContext {
  tracker: TrackerTemplateContext;
  /** The requests come from a chat thread (else from the tracker). */
  fromChat: boolean;
  epic: {
    identifier: string;
    title: string;
    url: string | null;
    /** The PRD, cut to 6000 characters; null for a single issue or a blank one. */
    prd: string | null;
    single: boolean;
  };
  /** The epic's stories and their status; null for a chat request. */
  stories: (Omit<StoryListContext, "items"> & { items: Omit<StoryListItem, "current">[] }) | null;
  /** The requests, trimmed, oldest first. */
  requests: string[];
  branch: string;
  baseBranch: string;
  remoteUrl: string | null;
  prUrl: string | null;
  /** `pull request` or `merge request`. */
  prTerm: string;
  /** `Pull request` or `Merge request`. */
  prTermCapitalized: string;
  progressFile: string;
  qualityGates: CommandList;
  /** A request may rewrite the branch's history (`historyRewrite: when-asked` or `always`). */
  historyRewriteAllowed: boolean;
  /** Rebase instead of ever merging, without being asked (`historyRewrite: always`). */
  historyRewriteAlways: boolean;
  /** `/ship`: the session prepares one commit; the orchestrator commits and pushes. */
  ship: boolean;
  /** `/ship`: what earlier request sessions left stashed, newest first. */
  stashes: TemplateList<ShipStash>;
  attachments: string | null;
  appendInstruction: string | null;
}

/** The start of a long PRD, marked as cut (as the request and describe prompts show it). */
function prdExcerpt(prd: string): string {
  return prd.length > 6000 ? `${prd.slice(0, 6000)}\n…` : prd;
}

/** `ctx` as the context of a `builtin:handle-request` run (see `RequestTemplateContext`). */
export function requestTemplateContext(ctx: RequestPromptContext): RequestTemplateContext {
  const { epic } = ctx;
  const term = ctx.prTerm ?? "pull request";
  const prd = epic.kind === "single" ? "" : epic.description.trim();
  const fromChat = ctx.source === "chat";
  const stories = storyListContext(epic);
  return {
    tracker: { name: ctx.trackerName },
    fromChat,
    epic: {
      identifier: epic.identifier,
      title: oneLine(epic.title),
      url: epic.url ?? null,
      prd: prd ? prdExcerpt(prd) : null,
      single: epic.kind === "single",
    },
    stories: fromChat
      ? null
      : { ...stories, items: stories.items.map(({ current: _, ...item }) => item) },
    requests: ctx.requests.map((r) => r.trim()),
    branch: ctx.branch,
    baseBranch: ctx.baseBranch,
    remoteUrl: ctx.remoteUrl || null,
    prUrl: ctx.prUrl || null,
    prTerm: term,
    prTermCapitalized: capitalize(term),
    progressFile: ctx.progressFile,
    qualityGates: commandList(uniqueCommands(ctx.qualityGates)),
    historyRewriteAllowed: (ctx.historyRewrite ?? "when-asked") !== "never",
    historyRewriteAlways: ctx.historyRewrite === "always",
    ship: ctx.ship !== undefined,
    stashes: templateList(ctx.ship?.stashes),
    attachments: ctx.attachments || null,
    appendInstruction: ctx.appendInstruction?.trim() || null,
  };
}

/** What `builtin:describe-pr`'s template renders (see `buildDescribePrPrompt`). */
export interface DescribePrTemplateContext {
  branch: string;
  baseBranch: string;
  prTerm: string;
  epic: {
    identifier: string;
    title: string;
    /** The issue's description (the PRD), cut to 6000 characters; null when blank. */
    prd: string | null;
  };
  /** The stories the branch implements, in order. */
  stories: TemplateList<{ identifier: string; title: string; commit: string | null }>;
  qualityGates: CommandList;
  /** The end of the progress log (12,000 characters); null when blank. */
  progressLog: string | null;
}

/** `ctx` as the trigger context of a `builtin:describe-pr` run (see `DescribePrTemplateContext`). */
export function describePrTemplateContext(ctx: DescribePrPromptContext): DescribePrTemplateContext {
  const { epic } = ctx;
  const background = epic.description.trim();
  const progress = ctx.progress?.trim();
  return {
    branch: ctx.branch,
    baseBranch: ctx.baseBranch,
    prTerm: ctx.prTerm,
    epic: {
      identifier: epic.identifier,
      title: oneLine(epic.title),
      prd: background ? prdExcerpt(background) : null,
    },
    stories: templateList(
      describedStories(ctx).map((s) => ({
        identifier: s.identifier,
        title: oneLine(s.title),
        commit: s.commitSha ? s.commitSha.slice(0, 10) : null,
      })),
    ),
    qualityGates: commandList(uniqueCommands(epic.qualityGates)),
    progressLog: progress ? lastPart(progress, 12_000) : null,
  };
}

/** What a task verifier checks (see `verifyTaskTemplateContext`). */
export interface VerifyTaskPromptContext {
  branch: string;
  baseBranch: string;
  epic: { identifier: string; title: string; description: string };
  story: {
    identifier: string;
    title: string;
    /** Its description without the acceptance criteria. */
    description: string;
    acceptanceCriteria: readonly string[];
  };
  /** The attempt's commit; null when it committed nothing. */
  commitSha: string | null;
  /** The checks the attempt passed. */
  qualityGates: readonly string[];
}

/** What `builtin:verify-task`'s template renders (see `verifyTaskTemplateContext`). */
export interface VerifyTaskTemplateContext {
  branch: string;
  baseBranch: string;
  epic: {
    identifier: string;
    title: string;
    /** The PRD, cut to 6000 characters; null when blank. */
    prd: string | null;
  };
  story: {
    identifier: string;
    title: string;
    description: string | null;
    acceptanceCriteria: TemplateList<string>;
  };
  /** The full SHA of the attempt's commit; null when it committed nothing. */
  commit: string | null;
  qualityGates: CommandList;
}

/** `ctx` as the trigger context of a `builtin:verify-task` run (see `VerifyTaskTemplateContext`). */
export function verifyTaskTemplateContext(ctx: VerifyTaskPromptContext): VerifyTaskTemplateContext {
  const prd = ctx.epic.description.trim();
  return {
    branch: ctx.branch,
    baseBranch: ctx.baseBranch,
    epic: {
      identifier: ctx.epic.identifier,
      title: oneLine(ctx.epic.title),
      prd: prd ? prdExcerpt(prd) : null,
    },
    story: {
      identifier: ctx.story.identifier,
      title: oneLine(ctx.story.title),
      description: ctx.story.description.trim() || null,
      acceptanceCriteria: templateList(ctx.story.acceptanceCriteria),
    },
    commit: ctx.commitSha,
    qualityGates: commandList(uniqueCommands(ctx.qualityGates)),
  };
}

/** What an epic audit checks (see `auditEpicTemplateContext`). */
export interface AuditEpicPromptContext {
  branch: string;
  baseBranch: string;
  epic: { identifier: string; title: string; description: string };
  /** The epic's requirements (`## Requirements`, or a legacy PRD's `## Functional Requirements`). */
  requirements: readonly { id: string; text: string }[];
  /** The epic's tasks, with what each one was checked against. */
  tasks: readonly {
    identifier: string;
    title: string;
    /** The repo it was worked in when it isn't the audited one; null otherwise. */
    repository: string | null;
    acceptanceCriteria: readonly string[];
  }[];
  /** The commit audited (the lane's head); null when it is the branch as checked out. */
  commitSha: string | null;
  /** This audit round (1-based) and the most the epic gets. */
  round: number;
  maxRounds: number;
  /** `pull request` (GitHub) or `merge request` (GitLab). */
  prTerm: string;
}

/** What `builtin:audit-epic`'s template renders (see `auditEpicTemplateContext`). */
export interface AuditEpicTemplateContext {
  branch: string;
  baseBranch: string;
  epic: {
    identifier: string;
    title: string;
    /** The PRD, cut to 6000 characters; null when blank. */
    prd: string | null;
  };
  requirements: TemplateList<{ id: string; text: string }>;
  tasks: TemplateList<{
    identifier: string;
    title: string;
    repository: string | null;
    acceptanceCriteria: TemplateList<string>;
  }>;
  /** The full SHA audited; null when it is the branch as checked out. */
  commit: string | null;
  audit: { round: number; maxRounds: number; last: boolean };
  prTerm: string;
}

/** `ctx` as the trigger context of a `builtin:audit-epic` run (see `AuditEpicTemplateContext`). */
export function auditEpicTemplateContext(ctx: AuditEpicPromptContext): AuditEpicTemplateContext {
  const prd = ctx.epic.description.trim();
  return {
    branch: ctx.branch,
    baseBranch: ctx.baseBranch,
    epic: {
      identifier: ctx.epic.identifier,
      title: oneLine(ctx.epic.title),
      prd: prd ? prdExcerpt(prd) : null,
    },
    requirements: templateList(ctx.requirements.map((r) => ({ id: r.id, text: oneLine(r.text) }))),
    tasks: templateList(
      ctx.tasks.map((task) => ({
        identifier: task.identifier,
        title: oneLine(task.title),
        repository: task.repository,
        acceptanceCriteria: templateList(task.acceptanceCriteria.map(oneLine)),
      })),
    ),
    commit: ctx.commitSha,
    audit: {
      round: ctx.round,
      maxRounds: ctx.maxRounds,
      last: ctx.round >= ctx.maxRounds,
    },
    prTerm: ctx.prTerm,
  };
}
