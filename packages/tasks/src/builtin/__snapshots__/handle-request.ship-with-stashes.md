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
/ship
```

## How to handle it
This is `/ship`: the work on `eng-10-widget-exports` is to be committed, pushed and put up for review. You prepare the commit; the orchestrator makes it with your message, pushes `eng-10-widget-exports` to `origin` and makes the pull request change you ask for. Don't commit or push yourself.

1. See what the worktree has: `git status` and `git diff` (uncommitted changes), and `git log --oneline origin/eng-10-widget-exports..HEAD` (commits not pushed yet; the ref may not exist if the branch was never pushed).
2. Earlier request sessions on this branch left uncommitted work, which was stashed (newest first):
   - `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb` (2026-10-10): omniralph ralph run-1 request pre-run
   - `cccccccccccccccccccccccccccccccccccccccc` (2026-10-09): omniralph ralph run-1 request stopped
   Review each with `git stash show -p --include-untracked <sha>` and bring back what belongs in this commit with `git stash apply <sha>`. Never `pop` or `drop` them: the stash list is shared with other worktrees.
3. If the request above says more than `/ship` (notes, a last fix), do that first.
4. Run the quality gates (`pnpm test`, `pnpm lint`) and fix any failures.
5. Leave in the worktree only what belongs in the commit: everything left (including untracked files) is committed with `git add -A`. Delete scratch files; add generated ones to `.gitignore`.
6. Report `commit.message` in your structured result: a one-line subject, a blank line, and a short body saying what changed and why. Leave `commit` out when there's nothing to commit (the orchestrator still pushes commits that aren't on `origin` yet).
7. The pull request is open (https://github.com/acme/widgets/pull/7). If its title or description no longer match the branch, set `pullRequest` to `update` with a new title and description; otherwise leave `pullRequest` out.
- If something stops you (failing gates you can't fix, a conflict, missing credentials), leave `commit` out and say exactly what's wrong in `summary`: nothing is committed or pushed then.
- `summary` is posted to the thread on Linear: say what is being committed and pushed, in a sentence or two.

## Rules
You are shipping the work on a branch for a thread on Linear.
- Don't run `git commit`, `git push`, `git stash pop`/`drop` or any command that rewrites history: the orchestrator commits everything left in the worktree with the `commit.message` of your structured result, then pushes the branch.
- Don't run `gh` or `glab`: they aren't set up here. Ask for pull/merge request changes (open, update) through `pullRequest` in your structured result; the orchestrator makes them after it pushes.
- The `summary` of your structured result is posted to the thread on Linear.
