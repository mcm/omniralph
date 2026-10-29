# Fixture database

A local Postgres seeded with one fake organization ("Fixture Labs"), for rendering every
signed-in screen of the control panel without OAuth, secrets or production services. It runs
in Docker through Testcontainers, like the tests.

```sh
# Start (or reuse), migrate and reseed it; prints the variables to run the panel with.
pnpm --silent --filter @omniralph/web fixtures:up > apps/web/.env.fixtures

# Run the panel against it (the workspace packages must be built once).
pnpm turbo run build --filter=@omniralph/web^...
set -a; . apps/web/.env.fixtures; set +a
pnpm --filter @omniralph/web dev

# Sign in: open /sign-in/dev?email=admin@fixtures.example (or member@fixtures.example),
# optionally with &callbackUrl=/runs. The sign-in page also shows a form for it.

# Remove it.
pnpm --filter @omniralph/web fixtures:down
```

`fixtures:up` prints `DATABASE_URL`, `ENCRYPTION_KEY` and `AUTH_SECRET` (fixed, fake values)
and `OMNIRALPH_DEV_SIGNIN=1`. The dev sign-in (`src/app/(auth)/sign-in/dev/route.ts`) only
exists with `OMNIRALPH_DEV_SIGNIN=1` **and** `NODE_ENV` other than `production`.
It also prints `OMNIRALPH_FIXTURE_LINEAR=1`: the settings pickers and the Backlog then read the
fixture Linear workspace (`src/lib/linear/fixture-gateway.ts`: teams FIX, OPS and WEB, their
labels, projects, states and work items; the sandbox organization's token gets its own SBX
workspace) instead of linear.app; and `OMNIRALPH_FIXTURE_SCM=1`: a story's Diff tab reads a
fixture diff (`src/lib/scm/fixture-diff.ts`) and the add-repo picker a fixture list
(`src/lib/scm/fixture-repositories.ts`) for the fixture connections instead of GitHub or GitLab. Both only outside production.

## What's in it

- `seed.ts`: the data. Timestamps are relative to the seed time, so rerun `fixtures:up` to
  refresh them (it replaces the previous seed). Online agents heartbeat in 2099, so they
  stay online however long after seeding the panel renders.
- `ids.ts`: fixed IDs (`FIXTURE_IDS`) for naming detail pages, e.g.
  `/runs/${FIXTURE_IDS.ralphRuns.running}`, `/runs/${FIXTURE_IDS.triageRuns.completed}` or
  `/repos/${FIXTURE_IDS.repositories.controlPanel}`.

Covered: an admin and a member, both in two organizations ("All organizations"; neither has a
saved theme, so a capture's color scheme decides), a pending invitation, GitHub and GitLab
connections with repositories (Reviews, Coding and Ask each on and off, one with Coding off
and no work item match, one disconnected), a Linear workspace, about 30 agents online,
offline, outdated, updating and revoked (the control panel pinned to four of them, one
revoked), and:

- **Inbox** (`FIXTURE_IDS.inbox`, `FIXTURE_INBOX_KEYS`): a manual story waiting, a stopped
  epic, a PRD ready, a pull request and a merge request waiting on a person with their AI
  review, failed runs, offline agents, a run asking which repo to use, running work, and an
  item both users snoozed.
- **Runs** of every kind (epic, request, review, triage, ask) in every status; an epic with
  stories in every status (attempts, progress logs, follow-ups, a manual story), a story with
  three attempts and a commit (its Diff tab), and attempts with a transcript.
- **Backlog** work items Ready to start and Needs refining with a PRD and a repo they route
  to, one being triaged.
- reviews over the last 40 days with findings open, dismissed and restored, learned and
  custom rules, repositories at every review depth, routing rules and work item matches, a
  custom playbook (editable, unlike the built-ins), jobs in every status, and the delivery
  log with every outcome and a replay.
- **Ask**: the admin's web chats, answered, answering, waiting, failed, stopped and skipped,
  and one whose answer is a drafted Request.
- **Empty states**: the second organization ("Fixture Sandbox") has an empty Inbox and a
  Backlog, so its empty Inbox shows Up next (board InboxEmpty).

All data is fake: emails are `@fixtures.example`, hosts `*.fixtures.example`, external IDs
and tokens start with `fixture`. The Repos add-repo sheet's picker for a GitHub or GitLab
connection (`/repos?add=github&connection=${FIXTURE_IDS.scmConnections.github}`) calls the
provider's API; with fixture credentials it shows its error state.
