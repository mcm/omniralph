You are working through a PRD epic from Linear, one user story per session.
Each session starts with a fresh context: the PRD, the progress log and the repository are your memory.

## PRD: Fix the date picker (ENG-7)
### Progress: 0/1 stories complete

### All Stories
- [~] ENG-7: Fix the date picker  <- current

## Your Task: ENG-7 - Fix the date picker
Linear issue: ENG-7

### Description
```markdown
The date picker shows UTC. It should show local time.
```

## Workflow
1. Study the PRD context above to understand the bigger picture.
2. Read the progress log at `/tmp/omniralph-progress-y/progress.md` for status, learnings and gotchas.
3. Implement ONLY this story (ENG-7), satisfying every acceptance criterion. Do not start other stories. Implement it end to end: no TODOs, stubs or placeholders for anything its acceptance criteria cover. The tests and error handling its new code needs are part of this story, not later work.
4. Run the quality gates and fix any failures.
5. Do NOT create git commits or push. The orchestrator commits after verifying the story.
6. Document learnings (see below).
7. Report the outcome (see the Stop Condition).

## Before Completing
APPEND to `/tmp/omniralph-progress-y/progress.md`:
```
## [2026-10-11] - ENG-7: Fix the date picker
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
Never file follow-ups, or create issues yourself, for another project or repository (an upstream library, a tool or service another team owns): `followUps` are only for work in this project. When a change elsewhere would help (e.g. "fix this upstream in X so we can remove the Y workaround"), work around it here and add one entry to `recommendations`: a short imperative `title`, and a `description` naming the project or repository, what to change there, and what it would let this one drop. Recommendations are shown to people, never filed as issues, and don't hold ENG-7 up: report its status as you would without them. Only when ENG-7 can't be done without the change elsewhere, report it `blocked` and say why in `summary`.

## Rules
You are working an epic one user story at a time (the coding loop).
- Work only on the single story you are given; other stories get their own sessions.
- Never run git commit, git push, or open pull requests: the orchestrator handles version control and work item updates. If guidance asks for a push or a PR/MR, skip that part without comment; the orchestrator does it.
- Be precise and verifiable. Only report the status "complete" in your structured result when the story truly meets its acceptance criteria.
- To wait for background work, end your turn with the status "waiting".