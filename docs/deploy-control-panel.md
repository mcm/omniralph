# Deploying the control panel

The control panel (`apps/web`) is a Next.js 16 app on Vercel. It's the single integration point:
code hosts send webhooks to it, it owns job state in Postgres, where harnesses claim their jobs, signs
harness tokens with Vercel KMS and brokers short-lived clone credentials. Every variable mentioned below is described in [env.md](env.md).

Prerequisites: a Vercel team with KMS available (beta), the Vercel CLI
(`npm i -g vercel`, logged in), an npm token that can read `@iamthemcmaster/ui`, a Neon API key, and
admin access to this repository and to the GitHub organization and/or GitLab projects you'll connect.

Vercel doesn't build the control panel: GitHub Actions does (`.github/workflows/deploy-web.yml`) and
uploads the output with `vercel deploy --prebuilt` (see *Deploying from GitHub Actions*).

## 1. Create the Vercel project

1. **Add New › Project**, import the GitHub repository (`mcm/omniralph`).
2. **Root Directory:** `apps/web`. Vercel detects Next.js and the pnpm workspace. Leave the build
   command alone: `apps/web/vercel.json` sets it to `turbo run build`, and turns off deployments
   from Git pushes (`"git": { "deploymentEnabled": false }`), so connecting the repository doesn't
   make Vercel build it too.
3. **Node.js version:** 22.x (**Settings › Build and Deployment**).
4. **Function region** (**Settings › Functions**): close to your Neon database (e.g. `iad1`
   Washington, D.C.).
5. Link a local checkout for the CLI steps below: `cd apps/web && vercel link`. Note the
   `orgId` and `projectId` in `apps/web/.vercel/project.json` for the next step.

## 2. Deploying from GitHub Actions

`.github/workflows/deploy-web.yml` builds and deploys the control panel:

- **Pushes to `main`** (and manual runs of the workflow on `main`) deploy to **production**.
- **Pull requests** don't deploy previews for now: previews can't complete OAuth sign-in (their
  callback URLs aren't registered), so the workflow only runs when a pull request closes, to delete
  the Neon branch (`preview/<branch>`) an earlier preview created. To turn previews back on, add
  `opened`, `synchronize` and `reopened` back to the workflow's `pull_request` types: pull requests
  from branches of this repository then deploy a **preview** with their own Neon branch, deleted
  when the pull request closes. Pull requests from forks and Dependabot get no preview: they can't
  read the secrets.

Each run pulls the Vercel environment's settings and variables (`vercel pull`), builds with
`vercel build`, migrates the database (see *Migrations*) and uploads the output with
`vercel deploy --prebuilt`. The deployment URL is on the run's summary and its GitHub environment
(`production` or `preview`). Production runs queue up; a newer push to a pull request cancels its
running preview deploy.

Set these under the repository's **Settings › Secrets and variables › Actions**:

| Name | Kind | Value |
| -- | -- | -- |
| `VERCEL_TOKEN` | secret | A Vercel access token (**Account Settings › Tokens**) scoped to the team that owns the project |
| `VERCEL_ORG_ID` | variable | `orgId` from `.vercel/project.json` (the team ID) |
| `VERCEL_PROJECT_ID` | variable | `projectId` from `.vercel/project.json` |
| `NPM_TOKEN` | secret | npm token that can read `@iamthemcmaster/ui` (also used by CI) |
| `NEON_API_KEY` | secret | A Neon API key (**Neon Console › Account settings › API keys**) |
| `NEON_PROJECT_ID` | variable | The Neon project's ID (**Project settings › General**) |
| `NEON_DATABASE`, `NEON_ROLE` | variables, optional | Database and role of preview connection strings; default `neondb` and `neondb_owner`, the Neon integration's names |

`@iamthemcmaster/ui` is a private package on the public npm registry: the workflow writes
`NPM_TOKEN` to `.npmrc` before building. Use a read-only (or granular, read-only on
`@iamthemcmaster`) npm token. Never commit an `.npmrc` with a token. Vercel no longer installs
anything, so the project doesn't need `NPM_RC`.

## 3. Postgres (Neon)

1. **Storage › Neon › Create** (Vercel Marketplace) and connect it to the project for
   **Production and Development**. Leave the integration's **preview branches** off: the deploy
   workflow creates each pull request's Neon branch itself, because the integration only branches
   on deployments Vercel builds.
2. The integration injects `DATABASE_URL` (pooled, used by the app) and `DATABASE_URL_UNPOOLED`
   (direct, used by migrations). Previews get their branch's URLs as deployment variables from the
   workflow instead. Neon Auth isn't used; don't enable it.

### Migrations

The deploy workflow runs `pnpm --filter @omniralph/db migrate` after a successful build and before
uploading, so each deployment migrates the database it's connected to: the Neon project's default
branch for production, the pull request's Neon branch (created from the default branch on its first
deploy) for previews. The workflow gets these URLs from Neon with `NEON_API_KEY`, because
`vercel pull` writes the integration's sensitive variables as empty strings. It runs outside `turbo` so the remote cache can't skip it. Migrations
apply before the new deployment serves traffic, so they must stay compatible with the code that's
still live.

To migrate by hand (e.g. a local database): `DATABASE_URL=… pnpm --filter @omniralph/db migrate`.
It prefers `DATABASE_URL_UNPOOLED` when that's set.

## 4. KMS issuer for harness tokens (`KMS_AGENT_ISSUER_ID`)

Harness access tokens and job tokens are RS256 JWTs signed by Vercel KMS, so no signing key sits in an
env var. Create **one issuer per environment**: a preview deployment must not be able to mint tokens
that production accepts.

```sh
for env in production preview development; do
  vercel kms create "omniralph-harness-$env" --algorithm RS256
done
vercel kms list                                    # note each issuer ID
vercel kms add-grant <productionIssuerId>  --project omniralph --environment production
vercel kms add-grant <previewIssuerId>     --project omniralph --environment preview
vercel kms add-grant <developmentIssuerId> --project omniralph --environment development
vercel kms inspect <issuerId>                       # "algorithm": "RS256", one grant
```

Then set `KMS_AGENT_ISSUER_ID` to the matching issuer ID in each environment. Tokens are verified
against `https://kms.vercel.com/<issuer>/jwks.json`. Locally (`next dev`) you can leave it unset:
the control panel then signs with `LOCAL_AGENT_SIGNING_KEY` or an in-memory key, which is refused
when `VERCEL_ENV=production`. See [ADR 0002](adr/0002-agent-auth.md).

## 5. GitHub App private key in KMS (optional, `GITHUB_APP_KMS_ISSUER_ID`)

Create the GitHub App first ([github-app.md](github-app.md)). Instead of putting its private key in
`GITHUB_APP_PRIVATE_KEY`, import it into an **external-origin** issuer. GitHub only accepts RS256 and
KMS defaults to RS512, so `--algorithm RS256` is required, and an issuer's algorithm can't be
changed later:

```sh
vercel kms import omniralph-github-app-production --key ./app.private-key.pem --algorithm RS256
vercel kms add-grant <issuerId> --project omniralph --environment production
vercel kms inspect <issuerId>       # "algorithm": "RS256", "origin": "external"
```

Set `GITHUB_APP_KMS_ISSUER_ID=<issuerId>` and leave `GITHUB_APP_PRIVATE_KEY` unset, then delete the
PEM file. Do the same per environment if previews use their own GitHub App.

## 6. Job dispatch

There's nothing to provision: the `jobs` table in Postgres is the job queue
([ADR 0006](adr/0006-postgres-job-queue.md)). Harnesses claim jobs with `POST /api/harness/claim`, which
holds the request for up to 50s while there's nothing to claim (its `maxDuration` is 60s), and
renew the leases of their running jobs with each heartbeat.

If the project still has a `QUEUE_REGIONS` variable from an older release, remove it after
deploying; nothing reads it. Follow the [cutover](adr/0006-postgres-job-queue.md#cutover) so
running jobs aren't lost.

## 7. Vercel Cron (`CRON_SECRET`)

`apps/web/vercel.json` declares the cron jobs; they're registered on production deployments:

| Path | Schedule | Does |
| -- | -- | -- |
| `/api/cron/chat-run-events` | every minute | The chat responder's fallback for missed wake-ups: relays run events pending for over a minute in their chat threads ([chat.md](chat.md)). Does nothing without the chat agent configured |
| `/api/cron/discord-gateway` | every 9 minutes | Holds the Discord Gateway connection for 10 minutes and forwards messages to the Discord webhook route; needs a Pro or Enterprise plan ([chat.md](chat.md#the-discord-gateway-cron)). Does nothing without the Discord env vars |
| `/api/cron/expire-jobs` | hourly | Marks jobs still `queued` after 24h as `expired` (no harness claimed them) |
| `/api/cron/prune-rate-limits` | hourly at :30 | Deletes old harness API rate-limit windows |
| `/api/cron/prune-webhook-deliveries` | daily 03:15 UTC | Deletes webhook delivery IDs (redelivery dedupe) older than a week |
| `/api/cron/ralph-reconcile` | every 10 minutes | Ralph's fallback for missed wake-ups: advances waiting runs (and the chat runs of organizations without Linear), checks open ralph PRs/MRs for merges (cleanup) and failed CI, and deletes kept branches whose cleanup question timed out ([linear.md](linear.md)) |

Set `CRON_SECRET` (e.g. `openssl rand -hex 32`). Vercel sends it as `Authorization: Bearer …`;
the routes reject everything else. Cron jobs only run for the production deployment.

## 8. Remaining environment variables

Set these per environment (production values shown; see [env.md](env.md) for every variable):

| Variable | Value |
| -- | -- |
| `ENCRYPTION_KEY` | `openssl rand -base64 32`. Keep it stable: it decrypts stored GitLab tokens. |
| `APP_URL` | `https://omniralph.example.com` (your production domain). Optional in production when the default `VERCEL_PROJECT_PRODUCTION_URL` is right; set it for previews that should receive webhooks. |
| `AUTH_SECRET` | `openssl rand -base64 32` |
| `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET` | A GitHub **OAuth app**, callback `<APP_URL>/api/auth/callback/github` |
| `AUTH_GITLAB_ID`, `AUTH_GITLAB_SECRET`, `AUTH_GITLAB_URL` | A GitLab OAuth application (`read_user`), callback `<APP_URL>/api/auth/callback/gitlab` |
| `ALLOWED_EMAIL_DOMAINS` | e.g. `example.com`. Who may sign in (besides people invited to an organization). The only instance-wide access setting: there are no instance admins. |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_WEBHOOK_SECRET` | From [github-app.md](github-app.md) |
| `BOT_HANDLE` | Optional, default `omniralph`. GitHub only: GitLab uses each connection's bot username |
| `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET` | For ralph: from [linear.md](linear.md) |

Configure at least one sign-in provider. Redeploy after changing variables: run the **Deploy web**
workflow on `main` (**Actions › Deploy web › Run workflow**) or push again to the pull request.

## 9. First sign-in, organizations and connecting code hosts

The GitHub App, the sign-in OAuth apps and the Linear app configured above are shared by the whole
deployment. Everything else is per **organization**: code-host connections, repositories,
profiles, the Linear workspace, harnesses, jobs and ralph runs belong to one organization, and only
its members see them. Roles (`admin`, `member`) are per organization; nobody is an admin of the
whole instance. See [ADR 0004](adr/0004-organizations.md).

1. Open `APP_URL` and sign in. Without an organization you land on onboarding: create an
   organization (you become its admin), accept an invitation, or join one that allows your email
   domain. Anyone who can sign in can create organizations; switch between yours from the
   organization switcher in the sidebar.
2. Under **Settings › Organization**, invite members by email (as `admin` or `member`; invitations
   expire after 14 days, no email is sent: invitees accept after signing in) and optionally set
   email domains and **Allow anyone with a matching email to join**.
3. **Repositories › Connect GitHub** ([github-app.md](github-app.md)) and/or **Connect GitLab**
   ([gitlab.md](gitlab.md)), as an admin of the organization. Each GitHub installation and GitLab
   connection belongs to the organization that connected it.
4. **Harnesses › Enroll harness** and follow [deploy-harness.md](deploy-harness.md). Harnesses run only their
   organization's jobs.
5. Optionally tune **Settings › Profiles** and each repository's **Settings** (profile, triggers,
   path excludes, instructions, pinning) and **Rules**.

Open a PR in a connected repository: the review appears under **Jobs** and **Reviews**, and the
summary comment links back to `/reviews/<id>`.

## Troubleshooting

- **Install fails with 401/404 for `@iamthemcmaster/ui`:** the `NPM_TOKEN` Actions secret is
  missing, or the token can't read the package.
- **The deploy workflow fails at `vercel pull`:** `VERCEL_TOKEN` is missing or can't access the
  team, or `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` are wrong.
- **Migrations fail with `getaddrinfo EAI_AGAIN base`:** the database URL was empty (`pg` parses
  `""` as host `base`), e.g. a sensitive variable read from `vercel pull`.
- **Vercel also builds every push:** `apps/web/vercel.json`'s `git.deploymentEnabled: false` was
  removed, or the project's root directory isn't `apps/web`.
- **Harnesses get 401 right after enrolling:** `KMS_AGENT_ISSUER_ID` is missing, or the issuer has no
  grant for this project and environment.
- **GitHub installation callback fails with KMS but works with the PEM:** the issuer is RS512.
  `vercel kms inspect` shows it; re-import with `--algorithm RS256` into a new issuer.
- **Jobs stay queued:** no harness of the repository's organization is online that accepts the
  job's task type at the job's minimum version (**Harnesses**; harnesses of other organizations never take its jobs), the repository is
  pinned to an offline harness.
- **"Installation belongs to another organization" / "already connected to another
  organization":** a GitHub installation, GitLab token user or Linear workspace can only be
  connected to one organization. Disconnect a Linear workspace there first; remove a GitHub
  installation or GitLab connection there under **Repositories › Code-host connections** (or
  uninstall the GitHub App), or use another GitLab bot token.
