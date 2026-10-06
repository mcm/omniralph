# Environment variables

Every variable the control panel (`apps/web`) and the agent (`apps/agent`) read, with what it does
and its default. [`.env.example`](../.env.example) lists the same variables with copy-paste
examples. `apps/web/src/env-docs.test.ts` fails if the two lists drift apart, or if the code reads a
variable that's documented in neither.

Columns: **Required** is "yes" when the feature can't work without it in production. "—" in
**Default** means unset.

## Control panel (Vercel project)

Set these on the Vercel project (**Settings › Environment Variables**), per environment. Locally,
put them in `apps/web/.env.local`.

### Build

| Variable | Required | Default | Description |
| -- | -- | -- | -- |
| `NPM_RC` | yes (Vercel) | — | Full `.npmrc` contents Vercel writes before installing, so the private `@iamthemcmaster/ui` package installs: `//registry.npmjs.org/:_authToken=<token>`. Set it for every environment (Production, Preview, Development). |
| `NPM_TOKEN` | yes (CI); optional (Vercel) | — | GitHub Actions secret: `ci.yml` writes it to `.npmrc` before `pnpm install`. Never commit an `.npmrc` with a token. As a Vercel variable (runtime, read-only token is enough), it lets **Settings › Agents › Use latest on npm** read the restricted `@iamthemcmaster/omniralph-agent` package's latest version from `registry.npmjs.org`; without it the button is hidden and versions are typed in. |
| `NODE_ENV` | no | set by Next.js / the process manager | `production` in builds and on Vercel. Don't set it by hand. |

### Database

| Variable | Required | Default | Description |
| -- | -- | -- | -- |
| `DATABASE_URL` | yes | — | Pooled Neon Postgres URL, used by the app. Injected by the Neon integration. |
| `DATABASE_URL_UNPOOLED` | no | falls back to `DATABASE_URL` | Direct (unpooled) Neon URL, preferred by `pnpm --filter @omniralph/db migrate`. Injected by the Neon integration. |

### Secrets and URLs

| Variable | Required | Default | Description |
| -- | -- | -- | -- |
| `ENCRYPTION_KEY` | yes | — | 32-byte AES-256-GCM key (base64 or hex) encrypting SCM and Linear credentials at rest: `openssl rand -base64 32`. Changing it makes stored GitLab and Linear tokens unreadable (reconnect GitLab and Linear). |
| `APP_URL` | yes (except Vercel production) | `https://$VERCEL_PROJECT_PRODUCTION_URL` on Vercel | Public base URL of the control panel. Webhook URLs, review links in summary comments and the enrollment command use it. |
| `BOT_HANDLE` | no | `omniralph` | The `@handle` for mention commands (`@omniralph review`, `dismiss`, questions). On GitLab set it to the bot user's username. A leading `@` is ignored. |

### Sign-in (Auth.js)

| Variable | Required | Default | Description |
| -- | -- | -- | -- |
| `AUTH_SECRET` | yes | — | Auth.js session/cookie secret: `openssl rand -base64 32`. |
| `AUTH_GITHUB_ID` | one provider | — | GitHub OAuth app client ID (callback `<APP_URL>/api/auth/callback/github`). This is a plain OAuth app, separate from the GitHub App. |
| `AUTH_GITHUB_SECRET` | with `AUTH_GITHUB_ID` | — | GitHub OAuth app client secret. |
| `AUTH_GITLAB_ID` | one provider | — | GitLab OAuth application ID, scope `read_user` (callback `<APP_URL>/api/auth/callback/gitlab`). |
| `AUTH_GITLAB_SECRET` | with `AUTH_GITLAB_ID` | — | GitLab OAuth application secret. |
| `AUTH_GITLAB_URL` | no | `https://gitlab.com` | Self-managed GitLab instance for sign-in. |
| `ALLOWED_EMAIL_DOMAINS` | yes | — (nobody but invited emails) | Comma-separated email domains allowed to sign in (exact match, no subdomains), in addition to emails added under **Admin › Users**. The first person to sign in becomes admin. |

### GitHub App

See [github-app.md](github-app.md).

| Variable | Required | Default | Description |
| -- | -- | -- | -- |
| `GITHUB_APP_ID` | for GitHub | — | The App ID (or its `Iv…` client ID). |
| `GITHUB_APP_SLUG` | no | looked up with `GET /app` | The App's slug, for the installation link `github.com/apps/<slug>`. |
| `GITHUB_WEBHOOK_SECRET` | for GitHub | — | Webhook secret configured on the App; verifies `X-Hub-Signature-256`. |
| `GITHUB_APP_KMS_ISSUER_ID` | one of these two | — | Preferred: an external-origin, **RS256** Vercel KMS issuer holding the App's private key. When set, the PEM isn't used. |
| `GITHUB_APP_PRIVATE_KEY` | one of these two | — | Fallback / local dev: the App's PEM private key (PKCS#1 or PKCS#8; literal `\n` accepted). |
| `GITHUB_API_URL` | no | `https://api.github.com` | GitHub Enterprise Server REST base URL, e.g. `https://ghe.example.com/api/v3`. |

GitLab has no env vars: the base URL, bot token and webhook secret are entered under
**Repositories › Connect GitLab** and stored encrypted. See [gitlab.md](gitlab.md).

### Linear app (ralph)

See [linear.md](linear.md). An OAuth application in Linear (**Settings › API › OAuth applications**) that admins install from
**Settings › Integrations**. Callback URL `<APP_URL>/api/integrations/linear/callback`; enable
webhooks to `<APP_URL>/api/webhooks/linear` with the **Agent session events** and **Issues** events.
The app is installed with `actor=app` and scopes `read,write,app:assignable,app:mentionable`; its
tokens are stored encrypted (`ENCRYPTION_KEY`) and refreshed automatically.

| Variable | Required | Default | Description |
| -- | -- | -- | -- |
| `LINEAR_CLIENT_ID` | for ralph | — | The Linear OAuth application's client ID. Without it, **Connect Linear** is disabled. |
| `LINEAR_CLIENT_SECRET` | for ralph | — | The Linear OAuth application's client secret (code exchange and token refresh). |
| `LINEAR_WEBHOOK_SECRET` | for ralph | — | The Linear app's webhook signing secret; verifies the `Linear-Signature` HMAC-SHA256 header. Unset → Linear webhooks are rejected. |

### Agent tokens

See [ADR 0002](adr/0002-agent-auth.md).

| Variable | Required | Default | Description |
| -- | -- | -- | -- |
| `KMS_AGENT_ISSUER_ID` | yes (production) | — | Vercel KMS issuer that signs agent access and job tokens (RS256, 15 minutes). **One issuer per Vercel environment.** Verified against `https://kms.vercel.com/<issuer>/jwks.json`. |
| `LOCAL_AGENT_SIGNING_KEY` | no | an in-memory key | Local dev/tests only, used when `KMS_AGENT_ISSUER_ID` is unset: an RSA private key PEM. With the in-memory key, tokens die on restart and agents refresh. Refused when `VERCEL_ENV=production`. |

### Job dispatch and cron

See [ADR 0001](adr/0001-job-dispatch.md).

| Variable | Required | Default | Description |
| -- | -- | -- | -- |
| `QUEUE_REGIONS` | yes | — | Comma-separated Vercel Queues regions, e.g. `iad1`. Jobs are published to (and agents poll) the first one; the agent queue proxy only forwards to listed regions. |
| `CRON_SECRET` | yes | — | Vercel Cron sends `Authorization: Bearer $CRON_SECRET` to `/api/cron/*`; requests without it get 401. |

### Set by Vercel

The control panel also reads `VERCEL_ENV` (refuses the local agent-token signer in `production`) and
`VERCEL_PROJECT_PRODUCTION_URL` (the `APP_URL` default). Vercel sets both; don't set them yourself.
Publishing jobs, the queue proxy and KMS calls authenticate with the deployment's Vercel OIDC token,
which needs no variable either.

## Agent host (`omniralph-agent`)

Set these in the agent's environment (the systemd unit, or the shell that starts tmux or pm2), never
on Vercel. The agent's own settings (server, agent ID, refresh token, `workspaceRoot`) live in its
config file, and everything else comes from the control panel. See [deploy-agent.md](deploy-agent.md).

| Variable | Required | Default | Description |
| -- | -- | -- | -- |
| `OMNIRALPH_AGENT_CONFIG` | no | `~/.config/omniralph/agent.json` | Path of the agent config file (written by `enroll`, mode 0600). `--config` overrides it. |
| `OMNIRALPH_LOG_LEVEL` | no | `info` | pino log level: `trace`, `debug`, `info`, `warn`, `error`. |
| `ANTHROPIC_API_KEY` | no | — (the host's `claude` login) | Use an Anthropic API key for Claude instead of the logged-in `claude`. See [claude-auth.md](claude-auth.md). |
| `CLAUDE_CODE_OAUTH_TOKEN` | no | — (the host's `claude` login) | A long-lived Claude Code OAuth token (`claude setup-token`) instead of the login on disk. |

The agent sets `OMNIRALPH_JOB_TOKEN` and `OMNIRALPH_JOB_ID` itself for processes inside a job (the
`git-credential` helper). Don't set them. Ralph's Claude sessions, quality gates, setup and
preparation commands get the agent's environment without any `OMNIRALPH_*` variable, so they can't
fetch credentials; whatever else the agent's environment holds, they can read.

Ralph needs no extra agent variables: no `GH_TOKEN`, `GITLAB_TOKEN` or Linear token (see
[deploy-agent.md](deploy-agent.md#ralph)).
