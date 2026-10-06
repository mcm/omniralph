/**
 * The prompts of ralph's Claude sessions (ported from cyralph). The story prompt is modelled on
 * ralph-tui's JSON tracker template: full PRD context first, then codebase patterns, then exactly
 * one story, then the workflow and stop condition.
 *
 * Custom templates use a Handlebars-compatible subset: `{{var}}`, `{{#if var}}...{{else}}...{{/if}}`.
 */
import { extractCodebasePatterns, recentProgressEntries } from "./progress.js";
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

/** System prompt addition of a story session: the job owns git, the control panel owns Linear. */
export const RALPH_SYSTEM_APPEND = `You are "Omniralph", an autonomous engineer working a Linear epic one user story at a time (the Ralph loop).
- Work only on the single story you are given; other stories get their own sessions.
- Never run git commit, git push, or open pull requests: the orchestrator handles version control and Linear updates. If guidance asks for a push or a PR/MR, skip that part without comment; the orchestrator does it.
- Be precise and verifiable. Only report the status "complete" in your structured result when the story truly meets its acceptance criteria.`;

/** A stash entry offered to a story session for review (see `## Stashed Work`). */
export interface OfferedStash {
  sha: string;
  label: string;
  /** When it was stashed (ISO 8601). */
  date: string;
}

export interface PromptContext {
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
  /** Follow-up instructions from humans in the Linear agent session. */
  guidance?: string[];
  attempt: number;
  maxAttempts: number;
  /** Extra instructions from repository config. */
  appendInstruction?: string;
  /** The orchestrator files `followUps` as sub-issues of the epic (Linear-backed epics only). */
  followUps?: boolean;
  /**
   * Commands the orchestrator runs itself after the agent reports the story complete. Quality gates among them
   * aren't repeated as the agent's to run, so each check runs once.
   */
  verifyCommands?: string[];
  /** Stash entries of earlier sessions of this story that haven't been applied yet. */
  stashes?: OfferedStash[];
  /** Today's date in the progress entry heading; defaults to now. */
  now?: Date;
}

export const DEFAULT_STORY_TEMPLATE = `You are working through a PRD epic from Linear, one user story per session.
Each session starts with a fresh context: the PRD, the progress log and the repository are your memory.

## PRD: {{epicTitle}} ({{epicIdentifier}})
### Progress: {{completedCount}}/{{totalCount}} stories complete

{{#if prdOverview}}
<prd-document>
{{prdOverview}}
</prd-document>

{{/if}}
### All Stories
{{storyList}}

{{#if codebasePatterns}}
## Codebase Patterns (Study These First)
{{codebasePatterns}}

{{/if}}
## Your Task: {{storyId}} - {{storyTitle}}
{{#if storyIdentifier}}Linear issue: {{storyIdentifier}}{{#if storyUrl}} ({{storyUrl}}){{/if}}
{{/if}}
{{#if storyDescription}}
### Description
{{storyDescription}}

{{/if}}
{{#if acceptanceCriteria}}
### Acceptance Criteria
{{acceptanceCriteria}}

{{/if}}
{{#if notes}}
### Notes
{{notes}}

{{/if}}
{{#if qualityGates}}
### Quality Gates (must pass before you report the story complete)
{{qualityGates}}

{{/if}}
{{#if verifyCommands}}
### Checked by the Orchestrator
The orchestrator runs these itself after you report the story complete and sends any failure back to you, so you don't need to run them as a final check (run one earlier only if you need its output while working):
{{verifyCommands}}

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
1. Study the PRD context above to understand the bigger picture.
2. Read the progress log at \`{{progressFile}}\` for status, learnings and gotchas.
3. Implement ONLY this story ({{storyId}}), satisfying every acceptance criterion. Do not start other stories.
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
- \`status: "complete"\` only when every acceptance criterion is met and the quality gates pass. If the story is already implemented (e.g. by a previous session), verify it meets the acceptance criteria and report it complete straight away.
- \`status: "blocked"\` when something another attempt can't get past stops you (missing access or credentials, an unavailable service, a decision only a person can make). Explain in \`summary\` precisely why and what would unblock you. The story is then set aside without retries until someone replies. If you made changes worth keeping, add \`commit: { summary }\` with a one-line description of them: the orchestrator commits them as work in progress when its checks pass, and stashes them otherwise.
- \`status: "incomplete"\` when the story is just unfinished: it gets another attempt.
- \`summary\` is posted to Linear: what you did, or what is in the way.
{{#if followUps}}

## Follow-up Work
If you find work this story needs that is outside its scope (bugs elsewhere, missing pieces, problems a validation turns up), don't create Linear issues yourself and don't leave it as a note. Add one entry per item to \`followUps\`, and the orchestrator files each as a new story (a sub-issue of {{epicIdentifier}}): a short imperative \`title\`, and a \`description\` of what is wrong, where, and what done looks like (acceptance criteria as \`- [ ]\` checkboxes).
- If {{storyId}} can't be completed until they are fixed, don't report it complete. They will block {{storyId}}, be worked first, and then {{storyId}} runs again.
- If {{storyId}} is complete anyway, report it complete, and they join the epic as new stories.
- If an item is work only a person can do (granting access, changing settings in an outside service, a decision), set \`manual: true\`. It is filed for a person and never attempted by an agent; stories it blocks wait until a person marks it done.
{{else}}
- Leave \`followUps\` empty.
{{/if}}
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
      const manual = s.manual ? " (manual step for a person, not for you)" : "";
      return `- ${STATUS_MARK[s.status]} ${s.storyId}: ${s.title}${manual}${depText}${here}`;
    })
    .join("\n");
}

export function buildStoryPrompt(ctx: PromptContext, template = DEFAULT_STORY_TEMPLATE): string {
  const { epic, story } = ctx;
  const completed = epic.stories.filter(
    (s) => s.status === "completed" || s.status === "cancelled",
  ).length;
  const verifyCommands = uniqueCommands(ctx.verifyCommands ?? []);
  const checked = new Set(verifyCommands.map(normalizeCommand));
  const qualityGates = uniqueCommands(epic.qualityGates).filter(
    (g) => !checked.has(normalizeCommand(g)),
  );
  const vars: Vars = {
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
    storyDescription: story.description.trim() || undefined,
    acceptanceCriteria: story.acceptanceCriteria.map((c) => `- [ ] ${c}`).join("\n") || undefined,
    notes: story.notes,
    qualityGates: qualityGates.map((g) => `- \`${g}\``).join("\n") || undefined,
    verifyCommands: verifyCommands.map((g) => `- \`${g}\``).join("\n") || undefined,
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

/**
 * Prompt for a short session that reads the branch's changes and writes the PR/MR title and
 * description: a summary of the deliverable a reviewer without access to Linear can follow, the
 * stories it implements (with their Linear identifiers) and how it was verified.
 */
export function buildDescribePrPrompt(ctx: DescribePrPromptContext): string {
  const { epic, baseBranch, prTerm } = ctx;
  const background = epic.description.trim();
  const stories: NonNullable<DescribePrPromptContext["stories"]> =
    ctx.stories ??
    epic.stories.map((s) => ({ identifier: s.identifier ?? s.storyId, title: s.title }));
  const gates = uniqueCommands(epic.qualityGates);
  const progress = ctx.progress?.trim();
  return [
    `The branch \`${ctx.branch}\` in this git worktree is ready for a ${prTerm} into \`${baseBranch}\`. It implements "${epic.title}" (${epic.identifier}).`,
    "",
    ...(background
      ? [
          `Background from the issue tracker (for context only; readers of the ${prTerm} can't see it):`,
          "<issue-background>",
          background.length > 6000 ? `${background.slice(0, 6000)}\n…` : background,
          "</issue-background>",
          "",
        ]
      : []),
    ...(stories.length > 0
      ? [
          "The stories the branch implements, one commit each (Linear identifier, title, commit):",
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
