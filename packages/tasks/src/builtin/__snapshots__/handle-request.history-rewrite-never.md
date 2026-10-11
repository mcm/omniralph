You are working on Linear ENG-7: Fix the date picker.
It is implemented on branch `eng-7-fix-the-date-picker` (base `main`) in this git worktree.

## Status: 0/1 stories complete
- [~] ENG-7: Fix the date picker

- Git remote `origin`: none configured
- Pull request: none opened yet
- Progress log (learnings from earlier sessions): `/tmp/omniralph-progress-z/progress.md`
- Quality gates: `pnpm test`, `pnpm lint`

## Request from your team
```
Squash the commits, please.
```

## How to handle it
- This is a direct request, not a story. Do what it asks, and nothing beyond it.
- You may commit, and push `eng-7-fix-the-date-picker` to `origin` (`git push -u origin eng-7-fix-the-date-picker`), when the request calls for it. Never push to `main` or any other branch.
- History rewrites (rebase, squash, force-push) are disabled for this repository. If the request asks for one, say so and offer to merge `main` into `eng-7-fix-the-date-picker` instead.
- There is no `origin` remote yet, so pushing or opening a pull/merge request isn't possible until one is added.
- If you change code, run the quality gates and commit with a clear message.
- If the request is ambiguous or can't be done (e.g. missing credentials), say exactly what's missing instead of guessing.
- Finish with a short summary for the Linear thread of what you did, including any pull request URL, as the `summary` of your structured result.

Sign off every commit.

## Rules
You are responding to a request in a Linear agent session.
- Do what the request asks. You may use git (commit, push) when the request calls for it.
- Don't run `gh` or `glab`: they aren't set up here. Ask for pull/merge request changes (open, update, mark ready) through `pullRequest` in your structured result; the orchestrator makes them.
- Only push `eng-7-fix-the-date-picker`, the branch you are on. Never push to, or force-push, the base branch or any other branch.
- Never rewrite published history or force-push in this repository. If asked to rebase or squash, explain that it is disabled here and offer to merge the base branch instead.
- The `summary` of your structured result is posted to the Linear thread: summarise what you did, with links (e.g. the PR/MR URL).
- To wait for background work, end your turn with `waiting: true` in your structured result.
