You are working through an epic from Linear, one task per session.
Each session starts with a fresh context: the epic, the progress log and the repo are your memory.

## Epic: Task Priority (ENG-1)
### Progress: 1/2 stories complete

### Epic Context (background, not your task)
The epic's description explains why the work exists and what its tasks deliver together. Its requirements are delivered across all of the epic's tasks: build only what your task asks for. Your task's own acceptance criteria decide when it is done.

<epic-context>
## Problem
Slow reviews.

## Requirements
- FR-1: The system must badge tasks.
</epic-context>

### All Stories
- [x] US-001: Story US-001
- [ ] US-002: Story US-002 (depends on US-001)  <- current

## Your Task: US-002 - Story US-002
Kind: Fix

This task is a Fix: "What Is Broken" below is the bug and what should happen instead. Make that happen, and keep every behavior named under "Don't Stop Until" working as it does now. Add a regression test only where the affected code already has tests.

### What Is Broken
I want you to fix badges vanishing on Safari: they should stay.

### Likely Cause and How to Fix It (guidance)
This is guidance on how to build it, not part of what is checked: follow it where it fits, and depart from it when the code shows a better way.
Build it by checking the `:has()` selector, the likely cause.

### Don't Stop Until
This is your stop condition: keep working until every criterion below holds, and every constraint in it is respected. A criterion is evidence to check, not a test to write: confirm it in the code, the output of a command or the behavior of the running software. Write tests where the repo's conventions call for them on new behavior, never just to prove a criterion. A test that only asserts a file exists or what a config contains doesn't satisfy a criterion.
- [ ] Urgent tasks show a red badge.
- [ ] Sorting works as before.

## Workflow
1. Read the epic context above for background, then build only what this task asks for.
2. Read the progress log at `/tmp/p.md` for status, learnings and gotchas.
3. Implement ONLY this story (US-002), and keep working until everything under "Don't Stop Until" holds. Do not start other stories. Implement it end to end: no TODOs, stubs or placeholders for anything its acceptance criteria cover. The tests and error handling its new code needs are part of this story, not later work.
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
- `status: "incomplete"` when the story is just unfinished: it gets another attempt.
- `status: "waiting"` only to end your turn while background work you started (subagents, commands) still runs: you are resumed when it finishes, and then report one of the statuses above.
- `summary` is posted to Linear: what you did, or what is in the way.

- Leave `followUps` empty.

## Recommendations
Never file follow-ups, or create issues yourself, for another project or repository (an upstream library, a tool or service another team owns): `followUps` are only for work in this project. When a change elsewhere would help (e.g. "fix this upstream in X so we can remove the Y workaround"), work around it here and add one entry to `recommendations`: a short imperative `title`, and a `description` naming the project or repository, what to change there, and what it would let this one drop. Recommendations are shown to people, never filed as issues, and don't hold US-002 up: report its status as you would without them. Only when US-002 can't be done without the change elsewhere, report it `blocked` and say why in `summary`.