# Linear conventions for Omniralph

Read by `/linear-prd` when planning epics and by anyone (including Cyralph) working them.

## Staging

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
- **Fixes found while testing** go on the epic branch. Then `staging` is moved again.
- **Production** is unchanged: each epic ships through its own PR to `main`. Nothing merges
  from `staging` into `main`.
- **Cyralph never moves `staging`.** Live testing on staging is done by a person, after the
  epic's PR is open, and is not part of the epic.

## Planning an epic

Cyralph builds an epic end to end, unattended, and finishes with a PR to `main`.

1. **Every story is one Cyralph can finish itself.** Acceptance criteria are limited to
   checks it can run in the repo: tests, typecheck, lint, and migrations applying cleanly to
   a fresh database. No criterion may need a deployment, a browser session or a person.
2. **No manual stories for live or smoke testing,** and no `cyralph-prepare` steps that
   deploy to `staging`. The epic must never stop to wait for a person.
3. **The epic's PR to `main` is not a story.** Cyralph opens it once every story is done.
