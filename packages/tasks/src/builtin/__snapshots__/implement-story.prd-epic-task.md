You are working through an epic from Linear, one task per session.
Each session starts with a fresh context: the epic, the progress log and the repo are your memory.

## Epic: Widget exports (ENG-10)
### Progress: 2/5 stories complete

### Epic Context (background, not your task)
The epic's description explains why the work exists and what its tasks deliver together. Its requirements are delivered across all of the epic's tasks: build only what your task asks for. Your task's own acceptance criteria decide when it is done.

<epic-context>
````markdown
## Introduction
Admins want to export widgets.

```sh
pnpm export --all
```

## Quality Gates
- `pnpm test` - Tests
````
</epic-context>

### All Stories
- [x] ENG-11: Widgets table
- [~] ENG-12: Export widgets as CSV (in acme/exporter) (depends on ENG-11, OPS-9)  <- current
- [ ] ENG-13: Rotate the S3 keys (manual step for a person, not for you)
- [ ] ENG-14: Validate functional requirements (depends on ENG-11, ENG-12, ENG-13)
- [-] ENG-15: Old spike

## Codebase Patterns (Study These First)
```markdown
- Use `zod` for every payload.
```

## Your Task: ENG-12 - Export widgets as CSV
Linear issue: ENG-12 (https://linear.app/acme/issue/ENG-12)
Kind: Story

Repository: `acme/exporter`. This story belongs in this repository rather than the epic's main one, and this worktree is a checkout of it: make every change here.

### What to Build
```markdown
I want you to build a CSV export of the widgets table, so that admins can share widgets.
```

### Don't Stop Until
This is your stop condition: keep working until every criterion below holds, and every constraint in it is respected. A criterion is evidence to check, not a test to write: confirm it in the code, the output of a command or the behavior of the running software. Write tests where the repo's conventions call for them on new behavior, never just to prove a criterion. A test that only asserts a file exists or what a config contains doesn't satisfy a criterion.
- [ ] ```
The export button downloads `widgets.csv`
```

### Quality Gates (must pass before you report the story complete)
- `pnpm test`
- `pnpm lint`
- `pnpm   typecheck`

## Recent Progress
```markdown
## [2026-10-10] - ENG-11: Widgets table
- Added the table.
---
```

## Workflow
1. Read the epic context above for background, then build only what this task asks for.
2. Read the progress log at `/tmp/omniralph-progress-x/progress.md` for status, learnings and gotchas.
3. Implement ONLY this story (ENG-12), and keep working until everything under "Don't Stop Until" holds. Do not start other stories. Implement it end to end: no TODOs, stubs or placeholders for anything its acceptance criteria cover. The tests and error handling its new code needs are part of this story, not later work.
4. Run the quality gates and fix any failures.
5. Do NOT create git commits or push. The orchestrator commits after verifying the story.
6. Document learnings (see below).
7. Report the outcome (see the Stop Condition).

## Before Completing
APPEND to `/tmp/omniralph-progress-x/progress.md`:
```
## [2026-10-11] - ENG-12: Export widgets as CSV
- What was implemented
- Files changed
- **Learnings:**
  - Patterns discovered
  - Gotchas encountered
---
```
If you discovered a **reusable pattern**, also add it to the `## Codebase Patterns` section at the TOP of that file.

## Stop Condition
Your session ends with a structured result (the JSON schema you were given). It alone decides what happens next: nothing in your message text does.
- `status: "complete"` only when every acceptance criterion is met and the quality gates pass. A criterion covered only by a TODO, stub or placeholder is not met. If the story is already implemented (e.g. by a previous session), verify it meets the acceptance criteria and report it complete straight away.
- `status: "blocked"` when something another attempt can't get past stops you (missing access or credentials, an unavailable service, a decision only a person can make). Explain in `summary` precisely why and what would unblock you. The story is then set aside without retries until someone replies. Changes you leave in the worktree are committed as work in progress when the quality gates pass, and stashed otherwise: describe them in one line with `commit: { summary }`.
- If, while working, you find you need code from other unfinished work (another story, task or epic in Linear), report `status: "blocked"` and list that work's Linear identifiers in `blockedBy`. `blockedBy` is only for blockers you discover while working, and only with `status: "blocked"`. The orchestrator makes the story wait for them: a blocker in another epic makes it wait for that whole epic, and once that epic is done this branch is rebased onto the default branch before the story continues.
- Never ask, in `followUps` or in `summary`, for another branch to be merged into this branch. Report what you are blocked by in `blockedBy` instead.
- `status: "incomplete"` when the story is just unfinished: it gets another attempt.
- `status: "waiting"` only to end your turn while background work you started (subagents, commands) still runs: you are resumed when it finishes, and then report one of the statuses above.
- `summary` is posted to Linear: what you did, or what is in the way.

## Follow-up Work
If you find work in this project that this story needs but is outside its scope (bugs elsewhere, missing pieces, problems a validation turns up), don't create Linear issues yourself and don't leave it as a note. Add one entry per item to `followUps`, and the orchestrator files each as a new story (a sub-issue of ENG-10): a short imperative `title`, and a `description` of what is wrong, where, and what done looks like (acceptance criteria as `- [ ]` checkboxes).
- `followUps` are only for work outside this story's acceptance criteria: never use them to defer part of this story. If you can't finish it, report it `incomplete` or `blocked`.
- If ENG-12 can't be completed until they are fixed, report it `blocked`, not complete. They will block ENG-12, be worked first, and then ENG-12 runs again. Each such round (a review loop filing its fixes, say) doesn't use up an attempt, but rounds are capped.
- If ENG-12 measures its progress across rounds (e.g. a critique score it must raise to a bar), report this round's value as `metric`: a `name`, the `value`, its `direction` (`higher` or `lower` is better) and, if it has one, the `target`. Use the same name and direction every round: a loop whose best value hasn't improved for a few rounds is set aside. Otherwise leave `metric` out.
- If ENG-12 is complete anyway, report it complete, and they join the epic as new stories.
- If an item is work only a person can do (granting access, changing settings in an outside service, a decision), set `manual: true`. It is filed for a person and never attempted by an agent; stories it blocks wait until a person marks it done.
- If an item depends on this epic being merged, so it can't be part of this epic (e.g. removing a fallback once everything this epic changes has shipped), set `after: "epic"` and say why in `reason`. It is filed as a task of its own that follows ENG-10, blocked by it, and never blocks ENG-12 or any other story: it doesn't make ENG-12 blocked.

## Recommendations
Never file follow-ups, or create issues yourself, for another project or repository (an upstream library, a tool or service another team owns): `followUps` are only for work in this project. When a change elsewhere would help (e.g. "fix this upstream in X so we can remove the Y workaround"), work around it here and add one entry to `recommendations`: a short imperative `title`, and a `description` naming the project or repository, what to change there, and what it would let this one drop. Recommendations are shown to people, never filed as issues, and don't hold ENG-12 up: report its status as you would without them. Only when ENG-12 can't be done without the change elsewhere, report it `blocked` and say why in `summary`.

## Rules
You are working an epic one user story at a time (the coding loop).
- Work only on the single story you are given; other stories get their own sessions.
- Never run git commit, git push, or open pull requests: the orchestrator handles version control and work item updates. If guidance asks for a push or a PR/MR, skip that part without comment; the orchestrator does it.
- Be precise and verifiable. Only report the status "complete" in your structured result when the story truly meets its acceptance criteria.
- To wait for background work, end your turn with the status "waiting".