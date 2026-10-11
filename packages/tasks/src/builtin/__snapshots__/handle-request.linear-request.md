You are working on Linear ENG-10: Widget exports.
It is a PRD epic implemented one story per commit on branch `eng-10-widget-exports` (base `main`) in this git worktree.

## Status: 2/5 stories complete
- [x] ENG-11: Widgets table
- [~] ENG-12: Export widgets as CSV (in acme/exporter) (depends on ENG-11, OPS-9)
- [ ] ENG-13: Rotate the S3 keys (manual step for a person, not for you)
- [ ] ENG-14: Validate functional requirements (depends on ENG-11, ENG-12, ENG-13)
- [-] ENG-15: Old spike

- Git remote `origin`: `https://github.com/acme/widgets.git`
- Pull request: none opened yet
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

## Attachments
Files attached in Linear. Open the ones relevant to the request with the Read tool (it shows images):
- **log.txt** (from Linear thread): `/tmp/attachments/log.txt`

## Request from your team
```
Please rebase onto main.
```

```
Also rename the button:
> Export CSV
```

## How to handle it
- This is a direct request, not a story. Do what it asks, and nothing beyond it.
- You may commit, and push `eng-10-widget-exports` to `origin` (`git push -u origin eng-10-widget-exports`), when the request calls for it. Never push to `main` or any other branch.
- History rewrites are allowed on `eng-10-widget-exports` when the request asks for one. For a rebase: `git fetch origin && git rebase origin/main`, resolve conflicts, run the quality gates, then `git push --force-with-lease origin eng-10-widget-exports`. Do the rebase that was asked for; don't substitute a merge. If the lease is rejected (someone else pushed), stop and report it instead of overwriting their work.
- For the pull request, don't run `gh` or `glab`. Push `eng-10-widget-exports` first, then set `pullRequest` in your structured result: `open` opens it into `main` as a draft, `update` changes the open one's title or description, `ready` marks it ready for review. Give `open` a title summarising the change itself and a description of the deliverable written for reviewers who can't see Linear: what it does and why, notable changes, and any breaking changes or judgement calls. Don't list the user stories.
- If you change code, run the quality gates and commit with a clear message.
- If the request is ambiguous or can't be done (e.g. missing credentials), say exactly what's missing instead of guessing.
- Finish with a short summary for the Linear thread of what you did, including any pull request URL, as the `summary` of your structured result.

## Rules
You are responding to a request in a Linear agent session.
- Do what the request asks. You may use git (commit, push) when the request calls for it.
- Don't run `gh` or `glab`: they aren't set up here. Ask for pull/merge request changes (open, update, mark ready) through `pullRequest` in your structured result; the orchestrator makes them.
- Only push `eng-10-widget-exports`, the branch you are on. Never push to, or force-push, the base branch or any other branch.
- Don't rewrite history on your own initiative. When the request explicitly asks for it (rebase, squash, amend, reword), do it on `eng-10-widget-exports` and push with `git push --force-with-lease`. That is allowed here.
- The `summary` of your structured result is posted to the Linear thread: summarise what you did, with links (e.g. the PR/MR URL).
- To wait for background work, end your turn with `waiting: true` in your structured result.
