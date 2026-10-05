# CI workflows (GitHub Actions / GitLab CI)

Read the whole workflow file, not only the changed lines: these rules compare a changed line with the rest of the file.

## Security (`security`)

- Flag an action or include reference that breaks the file's own pinning convention: if the other `uses:` lines (or GitLab `include:` / `image:` references) pin to a full commit SHA, a new or changed reference pinned to a tag (`@v4`) or branch (`@main`) is a supply-chain risk — require the commit SHA, with the tag as a trailing comment
- Flag `${{ }}` expressions that expand untrusted event fields inside `run:` (or `script:`) — e.g. `github.event.pull_request.title` / `.body` / `.head.ref`, `github.event.issue.title` / `.body`, `github.event.comment.body`, `github.event.review.body`, `github.event.commits.*.message`, `github.head_ref`; GitLab `$CI_MERGE_REQUEST_TITLE` / `$CI_COMMIT_MESSAGE` / `$CI_COMMIT_BRANCH` in unquoted shell. The value is pasted into the script before the shell runs, so a crafted title runs commands — require passing it through `env:` and quoting the variable (`"$PR_TITLE"`)
- Flag `pull_request_target` or `workflow_run` workflows that check out or run code from the PR head with secrets or a write token available
- Flag `permissions:` widened (e.g. `write-all`, `contents: write`) beyond what the job's steps need, and secrets passed to steps that run untrusted code

## Correctness (`correctness`)

- Flag a step that reads a file, directory or artifact (e.g. `coverage/coverage-summary.json`, `dist/`, a `download-artifact` name, a `needs:` job output, GitLab `artifacts:` / `dependencies:`) that no earlier step in the same job, and no job it depends on, produces — check every earlier step's commands and the test/build scripts they run before reporting, and name the missing producer in the finding
- Flag `needs:` / `dependencies:` / `if:` references to jobs, steps or outputs that don't exist or are spelled differently (`steps.<id>.outputs.<name>` must match a step `id` and an output it sets)
- Flag `if:` conditions that can never be true or always are (e.g. comparing to the wrong event name or ref format such as `main` vs `refs/heads/main`)
- Flag caches or artifacts whose key or path doesn't match what the job writes, so they are never restored or uploaded
