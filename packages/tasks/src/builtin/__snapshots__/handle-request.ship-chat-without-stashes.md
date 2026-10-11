You are working on a request from a chat thread: Bump the Node version.
It is implemented on branch `chat/bump-node` (base `main`) in this git worktree.

- Git remote `origin`: `https://github.com/acme/widgets.git`
- Pull request: none opened yet
- Progress log (learnings from earlier sessions): `/tmp/omniralph-progress-z/progress.md`

## Request from your team
```
/ship with a note: keep the lockfile
```

## How to handle it
This is `/ship`: the work on `chat/bump-node` is to be committed, pushed and put up for review. You prepare the commit; the orchestrator makes it with your message, pushes `chat/bump-node` to `origin` and makes the pull request change you ask for. Don't commit or push yourself.

1. See what the worktree has: `git status` and `git diff` (uncommitted changes), and `git log --oneline origin/chat/bump-node..HEAD` (commits not pushed yet; the ref may not exist if the branch was never pushed).
2. No earlier request session left stashed work on this branch.
3. If the request above says more than `/ship` (notes, a last fix), do that first.
4. Check that the change builds and its tests pass, as far as the repository lets you.
5. Leave in the worktree only what belongs in the commit: everything left (including untracked files) is committed with `git add -A`. Delete scratch files; add generated ones to `.gitignore`.
6. Report `commit.message` in your structured result: a one-line subject, a blank line, and a short body saying what changed and why. Leave `commit` out when there's nothing to commit (the orchestrator still pushes commits that aren't on `origin` yet).
7. No pull request is open yet: set `pullRequest` to `open` with a title summarising the change itself and a description written for reviewers who can't see the chat thread (what it does and why, notable changes, breaking changes or judgement calls).
- If something stops you (failing gates you can't fix, a conflict, missing credentials), leave `commit` out and say exactly what's wrong in `summary`: nothing is committed or pushed then.
- `summary` is posted to the chat thread: say what is being committed and pushed, in a sentence or two.

Sign off every commit.

## Rules
You are shipping the work on a branch for a chat thread.
- Don't run `git commit`, `git push`, `git stash pop`/`drop` or any command that rewrites history: the orchestrator commits everything left in the worktree with the `commit.message` of your structured result, then pushes the branch.
- Don't run `gh` or `glab`: they aren't set up here. Ask for pull/merge request changes (open, update) through `pullRequest` in your structured result; the orchestrator makes them after it pushes.
- The `summary` of your structured result is posted to the chat thread.
