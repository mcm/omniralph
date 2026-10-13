/**
 * Story runs (`ralph.story` before the port): one attempt at one story of an
 * epic delegated in Linear, in the run's branch worktree. The prompt is
 * ralph's story prompt (`buildStoryPrompt` in `@omniralph/ralph`): the PRD,
 * the story list, the story and how to work it. The story-specific rules of
 * ralph's story system prompt close it, since `builtin:engineer`'s system
 * prompt is mode-neutral. The harness commits, runs the gates and pushes.
 */
import type { TaskDefinitionInput } from "../definitions.js";
import { ENGINEER_AGENT } from "./engineer.js";

/** The story-specific rules of ralph's story system prompt (`RALPH_SYSTEM_APPEND`). */
export const STORY_RULES = `## Rules
You are working a Linear epic one user story at a time (the coding loop).
- Work only on the single story you are given; other stories get their own sessions.
- Never run git commit, git push, or open pull requests: the orchestrator handles version control and Linear updates. If guidance asks for a push or a PR/MR, skip that part without comment; the orchestrator does it.
- Be precise and verifiable. Only report the status "complete" in your structured result when the story truly meets its acceptance criteria.
- To wait for background work, end your turn with the status "waiting".`;

// Guidance is fenced item by item, without the list bullets of today's prompt (a fence can't be
// indented under a bullet).
const STORY_TEMPLATE = `You are working through a PRD epic from Linear, one user story per session.
Each session starts with a fresh context: the PRD, the progress log and the repository are your memory.

## PRD: {{epic.title}} ({{epic.identifier}})
### Progress: {{stories.completed}}/{{stories.total}} stories complete

{{#epic.prd}}
<prd-document>
{{epic.prd}}
</prd-document>

{{/epic.prd}}
### All Stories
{{#stories.items}}
- {{mark}} {{identifier}}: {{title}}{{#manual}} (manual step for a person, not for you){{/manual}}{{^manual}}{{#repository}} (in {{repository}}){{/repository}}{{/manual}}{{#dependsOn}} (depends on {{dependsOn}}){{/dependsOn}}{{#current}}  <- current{{/current}}
{{/stories.items}}

{{#codebasePatterns}}
## Codebase Patterns (Study These First)
{{codebasePatterns}}

{{/codebasePatterns}}
## Your Task: {{story.id}} - {{story.title}}
{{#story.identifier}}
Linear issue: {{story.identifier}}{{#story.url}} ({{story.url}}){{/story.url}}
{{/story.identifier}}

{{#story.repository}}
Repository: \`{{story.repository}}\`. This story belongs in this repository rather than the epic's main one, and this worktree is a checkout of it: make every change here.

{{/story.repository}}
{{#story.description}}
### Description
{{story.description}}

{{/story.description}}
{{#story.acceptanceCriteria}}
### Acceptance Criteria
{{#items}}
- [ ] {{.}}
{{/items}}

{{/story.acceptanceCriteria}}
{{#story.notes}}
### Notes
{{story.notes}}

{{/story.notes}}
{{#attachments}}
### Attachments
Files attached in Linear (screenshots, mockups, documents). Open each one with the Read tool (it shows images) before you start, and treat them as part of the spec:
{{attachments}}

{{/attachments}}
{{#qualityGates}}
### Quality Gates (must pass before you report the story complete)
{{#items}}
- \`{{.}}\`
{{/items}}

{{/qualityGates}}
{{#verifyCommands}}
### Checked by the Orchestrator
The orchestrator runs these itself after you report the story complete and sends any failure back to you, so you don't need to run them as a final check (run one earlier only if you need its output while working):
{{#items}}
- \`{{.}}\`
{{/items}}

{{/verifyCommands}}
{{#guidance}}
## Guidance From Your Team (follow this)
{{#items}}
{{.}}
{{/items}}

{{/guidance}}
{{#feedback}}
## Previous Attempt (attempt {{attempt}} of {{maxAttempts}})
The previous attempt at this story did not complete. Fix the problems below:

{{feedback}}

{{/feedback}}
{{#stashes}}
## Stashed Work From Earlier Sessions
Earlier sessions of {{story.id}} ended with uncommitted changes, which the orchestrator stashed so that every session starts from a clean tree:
{{#items}}
- \`{{sha}}\` {{label}} ({{date}})
{{/items}}

Review each one with \`git stash show -p --include-untracked <sha>\` and apply what's still relevant with \`git stash apply <sha>\`. Never \`pop\` or \`drop\` them: the stash list is shared with other worktrees. Report the SHAs you applied in \`appliedStashes\`. Entries you leave out stay stashed until the story's work is committed, and are dropped then.

{{/stashes}}
{{#recentProgress}}
## Recent Progress
{{recentProgress}}

{{/recentProgress}}
## Workflow
1. Study the PRD context above to understand the bigger picture.
2. Read the progress log at \`{{progressFile}}\` for status, learnings and gotchas.
3. Implement ONLY this story ({{story.id}}), satisfying every acceptance criterion. Do not start other stories.
4. Run the quality gates and fix any failures.
5. Do NOT create git commits or push. The orchestrator commits after verifying the story.
6. Document learnings (see below).
7. Report the outcome (see the Stop Condition).

## Before Completing
APPEND to \`{{progressFile}}\`:
\`\`\`
## [{{today}}] - {{story.id}}: {{story.title}}
- What was implemented
- Files changed
- **Learnings:**
  - Patterns discovered
  - Gotchas encountered
---
\`\`\`
If you discovered a **reusable pattern**, also add it to the \`## Codebase Patterns\` section at the TOP of that file.

{{#appendInstruction}}
{{appendInstruction}}

{{/appendInstruction}}
## Stop Condition
Your session ends with a structured result (the JSON schema you were given). It alone decides what happens next: nothing in your message text does.
- \`status: "complete"\` only when every acceptance criterion is met and the quality gates pass. If the story is already implemented (e.g. by a previous session), verify it meets the acceptance criteria and report it complete straight away.
- \`status: "blocked"\` when something another attempt can't get past stops you (missing access or credentials, an unavailable service, a decision only a person can make). Explain in \`summary\` precisely why and what would unblock you. The story is then set aside without retries until someone replies. Changes you leave in the worktree are committed as work in progress when the quality gates pass, and stashed otherwise: describe them in one line with \`commit: { summary }\`.
- \`status: "incomplete"\` when the story is just unfinished: it gets another attempt.
- \`status: "waiting"\` only to end your turn while background work you started (subagents, commands) still runs: you are resumed when it finishes, and then report one of the statuses above.
- \`summary\` is posted to Linear: what you did, or what is in the way.

{{#followUps}}
## Follow-up Work
If you find work this story needs that is outside its scope (bugs elsewhere, missing pieces, problems a validation turns up), don't create Linear issues yourself and don't leave it as a note. Add one entry per item to \`followUps\`, and the orchestrator files each as a new story (a sub-issue of {{epic.identifier}}): a short imperative \`title\`, and a \`description\` of what is wrong, where, and what done looks like (acceptance criteria as \`- [ ]\` checkboxes).
- If {{story.id}} can't be completed until they are fixed, report it \`blocked\`, not complete. They will block {{story.id}}, be worked first, and then {{story.id}} runs again. Each such round (a review loop filing its fixes, say) doesn't use up an attempt, but rounds are capped.
- If {{story.id}} measures its progress across rounds (e.g. a critique score it must raise to a bar), report this round's value as \`metric\`: a \`name\`, the \`value\`, its \`direction\` (\`higher\` or \`lower\` is better) and, if it has one, the \`target\`. Use the same name and direction every round: a loop whose best value hasn't improved for a few rounds is set aside. Otherwise leave \`metric\` out.
- If {{story.id}} is complete anyway, report it complete, and they join the epic as new stories.
- If an item is work only a person can do (granting access, changing settings in an outside service, a decision), set \`manual: true\`. It is filed for a person and never attempted by an agent; stories it blocks wait until a person marks it done.
{{/followUps}}
{{^followUps}}
- Leave \`followUps\` empty.
{{/followUps}}

${STORY_RULES}`;

export const IMPLEMENT_STORY_TASK: TaskDefinitionInput = {
  id: "builtin:implement-story",
  name: "Implement a story",
  description:
    "Works one story of an epic delegated in Linear in the run's branch worktree; the harness runs the quality gates, commits and pushes.",
  taskType: "coding",
  agentId: ENGINEER_AGENT.id,
  triggers: ["linear.delegated"],
  promptTemplate: STORY_TEMPLATE,
  toolSettings: { shell: true, linearRead: false, network: true },
  // Handed back to the ralph run, which records the attempt.
  sink: "ralph-run",
  pool: "long",
  // Ralph's story model (`DEFAULT_STORY_MODEL`); the repository's `ralph_settings.model` overrides it.
  model: "opus",
  tokenBudget: null,
};
