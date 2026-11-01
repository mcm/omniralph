The branch `eng-10-widget-exports` in this git worktree is ready for a pull request into `main`. It implements "Widget exports" (ENG-10).

Background from the issue tracker (for context only; readers of the pull request can't see it):
<issue-background>
````markdown
## Introduction
Admins want to export widgets.

```sh
pnpm export --all
```

## Quality Gates
- `pnpm test` - Tests
````
</issue-background>

The stories the branch implements, one commit each (identifier, title, commit):
- ENG-11: Widgets table (`dddddddddd`)
- ENG-12: Export widgets as CSV

Every story passed these quality gates before it was committed:
- `pnpm test`
- `pnpm lint`
- `pnpm   typecheck`

Notes from the sessions that did the work (decisions, gotchas):
<progress-log>
```markdown
# Ralph Progress Log

## Codebase Patterns (Study These First)
- Use `zod` for every payload.

---

## [2026-10-10] - ENG-11: Widgets table
- Added the table.
---
```
</progress-log>

## Write the title and description
1. Study what actually changed: `git log --reverse --format='%s%n%b' origin/main..HEAD` and `git diff origin/main...HEAD` (use `main` instead of `origin/main` if that ref doesn't exist), reading files where the diff alone isn't clear.
2. Write a title and description for the pull request that a reviewer with no access to the issue tracker can follow:
   - Title: one line, imperative mood, at most 72 characters, summarising the change itself. No issue identifiers or prefixes.
   - Description (markdown): open with a short summary of what the change delivers and why. Then the notable changes, grouped by area, in a few bullets.
   - Add a **Stories** section listing every story above as `- <identifier>: <title>`, with the identifier exactly as given.
   - Add a **Verification** section saying how the change was verified (the quality gates above, tests the stories added), without claiming checks that didn't run.
   - Add a **Breaking changes** section if behaviour, configuration, APIs or data formats change incompatibly, saying what users must do. Omit it otherwise.
   - Add a **Decisions** section for judgement calls, trade-offs or deviations from the request that a reviewer should know about. Omit it if there were none.
   - Don't describe the development process or the progress log, and don't link the issue tracker; that is added for you.
   - Be concrete and concise; don't pad with generic statements or restate the diff line by line.
3. Don't change any files.

Report them as the `title` and the markdown `body` of your structured result.