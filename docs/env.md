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
| `NPM_TOKEN` | yes (CI) | — | GitHub Actions secret: `ci.yml` writes it to `.npmrc` before `pnpm install`. Never commit an `.npmrc` with a token. The control panel doesn't need it at runtime: **Settings › Agents › Use latest on npm** reads the public `@omniralph/agent` package without a token. |
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
| `BOT_HANDLE` | no | `omniralph` | The `@handle` for mention commands on GitHub (`@omniralph review`, `dismiss`, questions, and on ralph PRs `fix` and other requests to ralph). GitHub only: on GitLab the handle is the connection's bot username. A leading `@` is ignored. |

### Sign-in (Auth.js)

| Variable | Required | Default | Description |
| -- | -- | -- | -- |
| `AUTH_SECRET` | yes | — | Auth.js session/cookie secret: `openssl rand -base64 32`. |
| `AUTH_GITHUB_ID` | one provider | — | GitHub OAuth app client ID (callback `<APP_URL>/api/auth/callback/github`). This is a plain OAuth app, separate from the GitHub App. |
| `AUTH_GITHUB_SECRET` | with `AUTH_GITHUB_ID` | — | GitHub OAuth app client secret. |
| `AUTH_GITLAB_ID` | one provider | — | GitLab OAuth application ID, scope `read_user` (callback `<APP_URL>/api/auth/callback/gitlab`). |
| `AUTH_GITLAB_SECRET` | with `AUTH_GITLAB_ID` | — | GitLab OAuth application secret. |
| `AUTH_GITLAB_URL` | no | `https://gitlab.com` | Self-managed GitLab instance for sign-in. |
| `ALLOWED_EMAIL_DOMAINS` | yes | — (nobody but invited emails) | Comma-separated email domains allowed to sign in (exact match, no subdomains), in addition to emails with a pending, unexpired invitation to an organization. The only instance-wide access setting: there are no instance admins. Signed-in users create organizations (becoming their admin) or join them; roles and organization email domains are managed per organization under **Settings › Organization** and never widen this gate. |

### GitHub App

See [github-app.md](github-app.md). One GitHub App serves the whole deployment; each of its
installations is connected to one organization.

| Variable | Required | Default | Description |
| -- | -- | -- | -- |
| `GITHUB_APP_ID` | for GitHub | — | The App ID (or its `Iv…` client ID). |
| `GITHUB_APP_SLUG` | no | looked up with `GET /app` | The App's slug, for the installation link `github.com/apps/<slug>`. |
| `GITHUB_WEBHOOK_SECRET` | for GitHub | — | Webhook secret configured on the App; verifies `X-Hub-Signature-256`. |
| `GITHUB_APP_KMS_ISSUER_ID` | one of these two | — | Preferred: an external-origin, **RS256** Vercel KMS issuer holding the App's private key. When set, the PEM isn't used. |
| `GITHUB_APP_PRIVATE_KEY` | one of these two | — | Fallback / local dev: the App's PEM private key (PKCS#1 or PKCS#8; literal `\n` accepted). |
| `GITHUB_API_URL` | no | `https://api.github.com` | GitHub Enterprise Server REST base URL, e.g. `https://ghe.example.com/api/v3`. |

GitLab has no env vars: the base URL, bot token and webhook secret are entered per organization
under **Repositories › Connect GitLab** and stored encrypted. See [gitlab.md](gitlab.md).

### Linear app (ralph)

See [linear.md](linear.md). One OAuth application in Linear (**Settings › API › OAuth applications**) for the whole
deployment, which each organization's admins install into their organization's Linear workspace
from **Settings › Integrations** (one workspace per organization, one organization per workspace). Callback URL `<APP_URL>/api/integrations/linear/callback`; enable
webhooks to `<APP_URL>/api/webhooks/linear` with the **Agent session events** and **Issues** events.
The app is installed with `actor=app` and scopes `read,write,app:assignable,app:mentionable`; its
tokens are stored encrypted (`ENCRYPTION_KEY`) and refreshed automatically.

| Variable | Required | Default | Description |
| -- | -- | -- | -- |
| `LINEAR_CLIENT_ID` | for ralph | — | The Linear OAuth application's client ID. Without it, **Connect Linear** is disabled. |
| `LINEAR_CLIENT_SECRET` | for ralph | — | The Linear OAuth application's client secret (code exchange and token refresh). |
| `LINEAR_WEBHOOK_SECRET` | for ralph | — | The Linear app's webhook signing secret; verifies the `Linear-Signature` HMAC-SHA256 header. Unset → Linear webhooks are rejected. |

### Slack (chat)

One Slack app for the whole deployment, created from [slack-app-manifest.yaml](slack-app-manifest.yaml)
(replace the placeholder URLs with `APP_URL`). Each organization's admins install it into their
workspace from **Settings › Integrations › Connect Slack** (a workspace belongs to one
organization). Redirect URL `<APP_URL>/api/integrations/slack/callback`; events go to
`<APP_URL>/api/webhooks/slack`. Each workspace's bot token is stored encrypted (`ENCRYPTION_KEY`).
Without all three variables, **Connect Slack** is disabled.

| Variable | Required | Default | Description |
| -- | -- | -- | -- |
| `SLACK_CLIENT_ID` | for Slack | — | The Slack app's client ID (**Basic Information › App Credentials**). |
| `SLACK_CLIENT_SECRET` | for Slack | — | The Slack app's client secret (OAuth code exchange). |
| `SLACK_SIGNING_SECRET` | for Slack | — | The Slack app's signing secret; verifies Slack's request signatures. |

### Discord (chat)

One Discord application for the whole deployment (Discord Developer Portal), with a bot user. Each
organization's admins add the bot to their server from **Settings › Integrations › Connect
Discord** (a server belongs to one organization). Add the redirect
`<APP_URL>/api/integrations/discord/callback` under **OAuth2 › Redirects**; set the **Interactions
Endpoint URL** to `<APP_URL>/api/webhooks/discord`. The deployment-wide bot token is used for every
server, so nothing per-server is stored. Without all four variables, **Connect Discord** is
disabled.

| Variable | Required | Default | Description |
| -- | -- | -- | -- |
| `DISCORD_APPLICATION_ID` | for Discord | — | The application ID (**General Information**); also the OAuth2 client ID. |
| `DISCORD_CLIENT_SECRET` | for Discord | — | The OAuth2 client secret (code exchange when a server adds the bot). |
| `DISCORD_BOT_TOKEN` | for Discord | — | The bot's token (**Bot › Token**); posts replies and leaves servers on disconnect. |
| `DISCORD_PUBLIC_KEY` | for Discord | — | The application's public key; verifies Discord's interaction signatures (Ed25519). |

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
config file, and everything else comes from the control panel, including the organization the agent
was enrolled into (sent with each heartbeat; there's no variable for it). See
[deploy-agent.md](deploy-agent.md).

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
[deploy-agent.md](deploy-agent.md#ralph)). Self-update under pm2 needs none either: it detects pm2 by
the `pm_id` variable pm2 sets, and installs the public package without npm auth.

cyralph's variables (`LINEAR_ACCESS_TOKEN`, `CYRALPH_*`, …) and their equivalents are listed in
[cutover-from-cyralph.md](cutover-from-cyralph.md#environment-variables).
