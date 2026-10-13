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
# optionally with &callbackUrl=/coding. The sign-in page also shows a form for it.

# Remove it.
pnpm --filter @omniralph/web fixtures:down
```

`fixtures:up` prints `DATABASE_URL`, `ENCRYPTION_KEY` and `AUTH_SECRET` (fixed, fake values)
and `OMNIRALPH_DEV_SIGNIN=1`. The dev sign-in (`src/app/(auth)/sign-in/dev/route.ts`) only
exists with `OMNIRALPH_DEV_SIGNIN=1` **and** `NODE_ENV` other than `production`.

## What's in it

- `seed.ts`: the data. Timestamps are relative to the seed time, so rerun `fixtures:up` to
  refresh them (it replaces the previous seed). Online harnesses heartbeat in 2099, so they
  stay online however long after seeding the panel renders.
- `ids.ts`: fixed IDs (`FIXTURE_IDS`) for naming detail pages, e.g.
  `/coding/${FIXTURE_IDS.ralphRuns.running}` or `/reviews/${FIXTURE_IDS.reviews.featured}`.

Covered: an admin and a member (and a second organization for the switcher), a pending
invitation, GitHub and GitLab connections with repositories (one disabled, one disconnected),
a Linear workspace, harnesses online, offline, outdated, updating and revoked, ralph runs in
every status with stories in every status (attempts, progress logs, follow-ups, a run waiting
on a manual story), reviews over the last 40 days with findings open, dismissed and restored,
learned and custom rules, a custom review profile, a custom agent and task (editable,
unlike the built-ins), and jobs in every status.

All data is fake: emails are `@fixtures.example`, hosts `*.fixtures.example`, external IDs
and tokens start with `fixture`. The repository pages for a GitHub or GitLab connection call
the provider's API; with fixture credentials they show their error state.
