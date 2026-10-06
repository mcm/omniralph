# Deploying the control panel

The control panel (`apps/web`) is a Next.js 16 app on Vercel. It's the single integration point:
code hosts send webhooks to it, it owns job state in Postgres, publishes jobs to Vercel Queues,
proxies the agents' queue calls, signs agent tokens with Vercel KMS and brokers short-lived clone
credentials. Every variable mentioned below is described in [env.md](env.md).

Prerequisites: a Vercel team with Queues and KMS available (both in beta), the Vercel CLI
(`npm i -g vercel`, logged in), an npm token that can read `@iamthemcmaster/ui`, and admin access
to the GitHub organization and/or GitLab projects you'll connect.

## 1. Create the Vercel project

1. **Add New › Project**, import the GitHub repository (`mcm/omniralph`).
2. **Root Directory:** `apps/web`. Vercel detects Next.js and the pnpm workspace. Leave the build
   command alone: `apps/web/vercel.json` sets it to
   `pnpm --filter @omniralph/db migrate && turbo run build` (see *Migrations*).
3. **Node.js version:** 22.x (**Settings › Build and Deployment**).
4. **Function region** (**Settings › Functions**): the region you'll use for Queues (e.g. `iad1`
   Washington, D.C.), close to your Neon database.
5. Link a local checkout for the CLI steps below: `cd apps/web && vercel link`.

## 2. The private UI package (`NPM_RC`)

`@iamthemcmaster/ui` is a private package on the public npm registry. Vercel reads `NPM_RC` and
writes it to `.npmrc` before installing. Add it for **Production, Preview and Development**:

```sh
vercel env add NPM_RC production   # paste: //registry.npmjs.org/:_authToken=<npm token>
vercel env add NPM_RC preview
vercel env add NPM_RC development
```

Use a read-only (or granular, read-only on `@iamthemcmaster`) npm token. Never commit an `.npmrc`
with a token. CI uses the `NPM_TOKEN` Actions secret instead (`.github/workflows/ci.yml`).

## 3. Postgres (Neon)

1. **Storage › Neon › Create** (Vercel Marketplace) and connect it to the project. Enable
   **preview branches** so each preview deployment gets its own Neon branch.
2. The integration injects `DATABASE_URL` (pooled, used by the app) and `DATABASE_URL_UNPOOLED`
   (direct, used by migrations). Neon Auth isn't used; don't enable it.

### Migrations

Every Vercel build runs `pnpm --filter @omniralph/db migrate` before building, so each deployment
migrates the database it's connected to (its own Neon branch for previews, the main branch for
production). It runs outside `turbo` so the remote cache can't skip it. Migrations apply before the
new deployment serves traffic, so they must stay compatible with the code that's still live.

To migrate by hand (e.g. a local database): `DATABASE_URL=… pnpm --filter @omniralph/db migrate`.
It prefers `DATABASE_URL_UNPOOLED` when that's set.

## 4. KMS issuer for agent tokens (`KMS_AGENT_ISSUER_ID`)

Agent access tokens and job tokens are RS256 JWTs signed by Vercel KMS, so no signing key sits in an
env var. Create **one issuer per environment**: a preview deployment must not be able to mint tokens
that production accepts.

```sh
for env in production preview development; do
  vercel kms create "omniralph-agents-$env" --algorithm RS256
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

## 6. Vercel Queues (`QUEUE_REGIONS`)

Jobs are delivered through Vercel Queues in poll mode ([ADR 0001](adr/0001-job-dispatch.md)).
There's nothing to provision per topic: topics (`review-jobs`, `review-jobs-agent-<agentId>` for
pinned repos, `system-jobs-agent-<agentId>` for `repo.sync`) and the `agents` consumer group are
created on first use. The control panel authenticates to Queues with the deployment's Vercel OIDC token.

1. Make sure Vercel Queues (beta) is enabled for the team that owns the project.
2. Pick a region where Queues is available, ideally your function region. Set
   `QUEUE_REGIONS=iad1` (comma-separated if you list more). Jobs are published to, and agents
   poll, the **first** region; the agent queue proxy (`/api/agent/queue/<region>/…`) only forwards to
   regions in the list.
3. Don't change the first region while jobs are queued: messages can only be received in the region
   they were sent to. Drain the queue (or let the 24h retention expire) first.

Agents never talk to Vercel: they poll through the proxy with their own access token, and the proxy
only allows receive, acknowledge and extend-lease on the agent's topics in the `agents` group.

## 7. Vercel Cron (`CRON_SECRET`)

`apps/web/vercel.json` declares the cron jobs; they're registered on production deployments:

| Path | Schedule | Does |
| -- | -- | -- |
| `/api/cron/expire-jobs` | hourly | Marks jobs still `queued` after 24h as `expired` (their messages have left the queue) |
| `/api/cron/prune-rate-limits` | hourly at :30 | Deletes old agent API rate-limit windows |
| `/api/cron/prune-webhook-deliveries` | daily 03:15 UTC | Deletes webhook delivery IDs (redelivery dedupe) older than a week |
| `/api/cron/ralph-reconcile` | every 10 minutes | Ralph's fallback for missed wake-ups: advances waiting runs, checks open ralph PRs/MRs for merges (cleanup) and failed CI, and deletes kept branches whose cleanup question timed out ([linear.md](linear.md)) |

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
| `ALLOWED_EMAIL_DOMAINS` | e.g. `example.com`. Set it before the first deploy: the first person to sign in becomes admin. |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_WEBHOOK_SECRET` | From [github-app.md](github-app.md) |
| `BOT_HANDLE` | Optional, default `omniralph` |
| `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET` | For ralph: from [linear.md](linear.md) |
| `NPM_TOKEN` | Optional: a read-only npm token, for **Settings › Agents › Use latest on npm** |

Configure at least one sign-in provider. Redeploy after changing variables
(`vercel --prod` or **Deployments › Redeploy**).

## 9. First sign-in and connecting code hosts

1. Open `APP_URL` and sign in. The first allowed user becomes admin; add others under
   **Admin › Users**.
2. **Repositories › Connect GitHub** ([github-app.md](github-app.md)) and/or **Connect GitLab**
   ([gitlab.md](gitlab.md)).
3. **Agents › Enroll agent** and follow [deploy-agent.md](deploy-agent.md).
4. Optionally tune **Settings › Profiles** and each repository's **Settings** (profile, triggers,
   path excludes, instructions, pinning) and **Rules**.

Open a PR in a connected repository: the review appears under **Jobs** and **Reviews**, and the
summary comment links back to `/reviews/<id>`.

## Troubleshooting

- **Install fails with 401/404 for `@iamthemcmaster/ui`:** `NPM_RC` is missing for that environment,
  or the token can't read the package.
- **Agents get 401 right after enrolling:** `KMS_AGENT_ISSUER_ID` is missing, or the issuer has no
  grant for this project and environment.
- **GitHub installation callback fails with KMS but works with the PEM:** the issuer is RS512.
  `vercel kms inspect` shows it; re-import with `--algorithm RS256` into a new issuer.
- **Jobs stay queued:** no agent is online with the capability enabled (**Agents**), the repository
  is pinned to an offline agent, or `QUEUE_REGIONS` changed while jobs were queued.
