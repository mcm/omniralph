You are working through a PRD epic from Linear, one user story per session.
Each session starts with a fresh context: the PRD, the progress log and the repository are your memory.

## PRD: Task Priority (ENG-1)
### Progress: 1/2 stories complete

<prd-document>
The PRD body
</prd-document>

### All Stories
- [x] US-001: Story US-001
- [ ] US-002: Story US-002 (depends on US-001)  <- current

## Your Task: US-002 - Story US-002
Kind: Story

### Description
Show a badge on urgent tasks.

### Acceptance Criteria
Your task is done when every criterion below holds. A criterion is evidence to check, not a test to write: confirm it in the code, the output of a command or the behavior of the running software. Write tests where the repo's conventions call for them on new behavior, never just to prove a criterion. A test that only asserts a file exists or what a config contains doesn't satisfy a criterion.
- [ ] badge shows

### Quality Gates (must pass before you report the story complete)
- `pnpm lint`

## Workflow
1. Study the PRD context above to understand the bigger picture.
2. Read the progress log at `/tmp/p.md` for status, learnings and gotchas.
3. Implement ONLY this story (US-002), satisfying every acceptance criterion. Do not start other stories. Implement it end to end: no TODOs, stubs or placeholders for anything its acceptance criteria cover. The tests and error handling its new code needs are part of this story, not later work.
4. Run the quality gates and fix any failures.
5. Do NOT create git commits or push. The orchestrator commits after verifying the story.
6. Document learnings (see below).
7. Report the outcome (see the Stop Condition).

## Before Completing
APPEND to `/tmp/p.md`:
```
## [2026-11-02] - US-002: Story US-002
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

- Leave `followUps` empty.

## Recommendations
Never file follow-ups, or create issues yourself, for another project or repository (an upstream library, a tool or service another team owns): `followUps` are only for work in this project. When a change elsewhere would help (e.g. "fix this upstream in X so we can remove the Y workaround"), work around it here and add one entry to `recommendations`: a short imperative `title`, and a `description` naming the project or repository, what to change there, and what it would let this one drop. Recommendations are shown to people, never filed as issues, and don't hold US-002 up: report its status as you would without them. Only when US-002 can't be done without the change elsewhere, report it `blocked` and say why in `summary`.