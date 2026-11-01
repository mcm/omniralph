You are working on Linear ENG-10: Widget exports.
It is a PRD epic implemented one story per commit on branch `eng-10-widget-exports` (base `main`) in this git worktree.

## Status: 2/5 stories complete
- [x] ENG-11: Widgets table
- [~] ENG-12: Export widgets as CSV (in acme/exporter) (depends on ENG-11, OPS-9)
- [ ] ENG-13: Rotate the S3 keys (manual step for a person, not for you)
- [ ] ENG-14: Validate functional requirements (depends on ENG-11, ENG-12, ENG-13)
- [-] ENG-15: Old spike

- Git remote `origin`: `https://github.com/acme/widgets.git`
- Pull request: https://github.com/acme/widgets/pull/7
- Progress log (learnings from earlier sessions): `/tmp/omniralph-progress-z/progress.md`
- Quality gates: `pnpm test`, `pnpm lint`

<prd-document>
````markdown
## Introduction
Admins want to export widgets.

```sh
pnpm export --all
```

## Quality Gates
- `pnpm test` - Tests
````
</prd-document>

## Request from your team
```
The PR conflicts with main, please fix it.
```

## How to handle it
- This is a direct request, not a story. Do what it asks, and nothing beyond it.
- You may commit, and publish `eng-10-widget-exports` to `origin`, when the request calls for it. Don't run `git push` (your git credentials are read-only): call the `ship` tool, which commits what is left in the worktree with the `message` you give, pushes `eng-10-widget-exports` and tells you what it did. It never pushes `main` or any other branch.
- History rewrites are allowed on `eng-10-widget-exports` without being asked, and merges are not: never merge `main` (or any other branch) into `eng-10-widget-exports`. When `eng-10-widget-exports` needs `main` (it is behind or conflicts with it) or the request asks for a rebase: `git fetch origin && git rebase origin/main`, resolve conflicts, run the quality gates, then call `ship` with `forceWithLease: true`. If the lease is rejected (someone else pushed), stop and report it instead of overwriting their work.
- For the pull request, don't run `gh` or `glab`. Ship `eng-10-widget-exports` first, then ask for it with `pullRequest`, on the `ship` call or in your structured result: `open` opens it into `main` as a draft, `update` changes the open one's title or description, `ready` marks it ready for review. Give `open` a title summarising the change itself and a description of the deliverable written for reviewers who can't see Linear: what it does and why, notable changes, and any breaking changes or judgement calls. Don't list the user stories.
- If you change code, run the quality gates and commit with a clear message.
- If the request is ambiguous or can't be done (e.g. missing credentials), say exactly what's missing instead of guessing.
- Finish with a short summary for the thread on Linear of what you did, including any pull request URL, as the `summary` of your structured result.

## Rules
You are responding to a request in a thread on Linear.
- Do what the request asks. You may commit when the request calls for it; push only through the `ship` tool.
- Don't run `gh` or `glab`: they aren't set up here. Ask for pull/merge request changes (open, update, mark ready) through `pullRequest` in your structured result; the orchestrator makes them.
- Only ship `eng-10-widget-exports`, the branch you are on. Never push to, or force-push, the base branch or any other branch.
- History rewrites are allowed on `eng-10-widget-exports` without being asked, and merges are not: never merge the base branch (or any other branch) into it. When it needs the base branch (it is behind or conflicts with it), or the request asks for a rebase, squash, amend or reword, do it and ship it with `forceWithLease: true`.
- The `summary` of your structured result is posted to the thread on Linear: summarise what you did, with links (e.g. the PR/MR URL).
- To wait for background work, end your turn with `waiting: true` in your structured result.
