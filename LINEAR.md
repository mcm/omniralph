# Linear conventions for Omniralph

Read by `/linear-prd` when planning epics and by anyone (including Cyralph) working them.

## Staging and live smoke tests

There is one staging environment, and it tests one epic at a time.

- **`staging` is a pointer, not a branch with its own history.** It is moved to the head of
  the epic under test with a force-push:

  ```
  git push --force origin origin/<epic-branch>:staging
  ```

  No pull requests target `staging`, and no commits are made on it directly.
- **Stable URLs.** Vercel deploys `staging` to a fixed domain with branch-scoped Preview env
  vars (`APP_URL` and the staging GitHub App's credentials). The staging GitHub App's
  webhook and setup URLs point at that domain and never change. It is installed only on
  `mcm/omniralph-sandbox`.
- **Database.** `staging` has its own Neon branch. When moving `staging` to a new epic, reset
  that Neon branch from `main` first unless the previous epic has already been merged, so
  migrations from an abandoned epic don't linger.
- **Fixes found while testing** go on the epic branch. Then `staging` is moved again: reply
  `rerun preparation` in the epic's session and approve the push.
- **Production** is unchanged: each epic ships through its own PR to `main`. Nothing merges
  from `staging` into `main`.
- **Cyralph pushes to `staging` only through an approved preparation step** (see below). It
  never moves `staging` on its own.

## Planning an epic

When an epic changes deployed behaviour (anything a live control panel, webhook or agent
would exercise):

1. **Build stories are limited to checks Cyralph can run itself:** tests, typecheck, lint,
   and migrations applying cleanly to a fresh database. No acceptance criterion may need a
   deployment, a browser session or a person.
2. **Add one `manual` live smoke-test story when the epic is planned,** not during
   execution. It is blocked by every build story it exercises. Its description starts with
   this preparation block, which Cyralph runs from the epic worktree once someone approves
   it in the epic's session:

   ````markdown
   ```cyralph-prepare
   git push --force origin HEAD:staging
   ```
   ````

   Its checklist starts with:

   - [ ] Before approving the preparation: if the previous epic on `staging` wasn't merged,
     reset the staging Neon branch from `main` (the deploy migrates it)
   - [ ] After the preparation runs: wait for the `staging` deploy, then rebuild the test
     agent from the epic head

   The rest of the story lists the end-to-end steps to perform against `mcm/omniralph-sandbox`
   and what to record (review IDs, screenshots, links). Results are recorded on the smoke-test
   story itself.
3. **The epic's PR to `main` is not a story.** It follows the smoke test as usual.
