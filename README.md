# Omniralph

Self-hosted AI code review for GitHub and GitLab, plus the shared foundation for the cyralph agent.
PRs/MRs in connected repositories are reviewed automatically (or on `@omniralph review`) with a
configurable depth profile, findings are posted inline, and dismissed false positives turn into
learned rules for later reviews.

## Architecture

```
                                ┌────────────────────────────────┐        ┌──────────────┐
 GitHub / GitLab ──webhooks───▶ │ Control panel (apps/web)       │──SQL──▶│ Postgres     │
   ▲          ◀──reviews, ───── │ Next.js on Vercel              │        │ (Neon)       │
   │             replies        │ • UI, webhooks, job state      │        └──────────────┘
   │                            │ • JobDispatcher ──publish──────┼──────▶ ┌──────────────┐
   │                            │ • queue proxy ◀─receive/ack────┼──────▶ │ Vercel Queues│
   │                            │ • agent API, credential broker │        │ (poll mode)  │
   │                            │ • Vercel KMS-signed tokens     │        └──────────────┘
   │                            └───────────────▲────────────────┘
   │                                            │ outbound HTTPS only
   │                            ┌───────────────┴────────────────┐
   └──git clone/fetch ───────── │ Agent hosts (apps/agent)       │
      (read-only, brokered)     │ omniralph-agent on Coder       │
                                │ repo cache, Claude Agent SDK   │
                                └────────────────────────────────┘
```

- **The control panel is the single integration point.** It holds the GitHub App and GitLab bot
  credentials (encrypted at rest), receives webhooks and `@bot` commands, owns all job state in
  Postgres, and performs every code-host write (posting reviews, replies, resolving threads) as a
  typed operation. The UI (repositories, settings, profiles, reviews, rules, agents, jobs) lives here.
- **Dispatch through Vercel Queues and the proxy.** Postgres is the source of truth; Vercel Queues
  (poll mode) only delivers `{ jobId }` messages to capability topics (`review-jobs`, or a per-agent
  topic for pinned repos), with one competing consumer group. Agents never talk to Vercel: they
  poll through the control panel's queue proxy (`/api/agent/queue/<region>/…`), which allows only
  receive, acknowledge and extend-lease on the agent's own topics. Crashed agents' leases lapse
  and jobs are redelivered; rate-limited jobs are retried after a backoff.
  See [ADR 0001: job dispatch](docs/adr/0001-job-dispatch.md).
- **Agents make only outbound connections.** `omniralph-agent` runs on Coder instances, has no
  inbound port and a minimal local config (server, agent ID, rotating refresh token, workspace
  root). Concurrency, capabilities, pins and cancellations come back with each heartbeat. It
  authenticates with 15-minute RS256 access tokens signed by Vercel KMS, and rotating refresh tokens
  with reuse detection. See [ADR 0002: agent auth](docs/adr/0002-agent-auth.md).
- **Credential broker.** Agents never hold code-host write credentials. For git, the agent's
  `git-credential` helper asks the control panel (with a job-scoped token) for a short-lived,
  read-only token for that job's repository: a GitHub installation token limited to `contents: read`
  (≤ 1 hour) or a GitLab `read_repository` project access token (1 day, rotated). Git traffic goes
  straight to the code host.
- **Security boundary.** PR content is untrusted. Review sessions are read-only: only `Read`, `Grep`
  and `Glob` inside the job's worktree, no shell, writes or network tools, and `settingSources: []`
  so nothing from the PR head (`.claude/`, MCP config, `CLAUDE.md`) is loaded. Repo conventions come
  from the base branch's `CLAUDE.md`, passed as quoted data; a deterministic pre-pass flags
  prompt-injection text; bot-posted text goes through an output sanitizer.

## Quickstart

1. **Deploy the control panel** on Vercel: Neon Postgres, `NPM_RC`, a KMS issuer per environment,
   `QUEUE_REGIONS`, `CRON_SECRET`, sign-in and the other variables in [`.env.example`](.env.example).
   → [docs/deploy-control-panel.md](docs/deploy-control-panel.md)
2. **Sign in.** The first allowed user (`ALLOWED_EMAIL_DOMAINS`) becomes admin.
3. **Connect code hosts.** Create the GitHub App from its manifest and install it under
   **Repositories › Connect GitHub** → [docs/github-app.md](docs/github-app.md). Connect GitLab
   projects with a bot token under **Repositories › Connect GitLab** → [docs/gitlab.md](docs/gitlab.md).
4. **Run an agent** on a Coder instance as a dedicated user with its own `claude` login, enrolled
   from **Agents › Enroll agent** and run under systemd, tmux or pm2
   → [docs/deploy-agent.md](docs/deploy-agent.md), [docs/claude-auth.md](docs/claude-auth.md).

   ```bash
   omniralph-agent enroll --server https://omniralph.example.com --token <enrollment-token>
   omniralph-agent start --healthz-port 9310
   ```

5. **Open a PR/MR** in a connected repository. The review shows up under **Jobs** and **Reviews**,
   and the bot posts inline findings plus a summary linking to the review. Comment
   `@omniralph review [quick|standard|deep]` to re-review for new issues,
   `@omniralph review fresh [quick|standard|deep]` to re-review from scratch (matching open
   findings are superseded), `@omniralph dismiss [reason]` in a finding's thread to dismiss it,
   or ask a question there. Admins can also use **Re-run** on a review's page or history row.
6. **Tune** profiles (**Settings › Profiles**), per-repo settings (profile, triggers, path
   excludes, custom instructions, agent pinning) and rules (**Repository › Rules**). **Analytics**
   shows tokens per review by profile, dismissal rates per repo and jobs per agent over 7/30/90 days.

## Documentation

| Doc | Covers |
| -- | -- |
| [deploy-control-panel.md](docs/deploy-control-panel.md) | Vercel, `NPM_RC`, Neon and migrations, KMS issuers, Vercel Queues regions, Cron |
| [deploy-agent.md](docs/deploy-agent.md) | Installing on Coder, enrolling, dedicated user and systemd/tmux/pm2, central config, disk usage, coexisting with cyralph, re-enrollment |
| [claude-auth.md](docs/claude-auth.md) | The host `claude` login, `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`, shared rate limits, terms |
| [github-app.md](docs/github-app.md) | GitHub App manifest, permissions, events, KMS-held private key |
| [gitlab.md](docs/gitlab.md) | Bot token scopes and role, self-managed GitLab |
| [env.md](docs/env.md) | Every environment variable for the control panel and the agent |
| [evals/README.md](evals/README.md) | The review eval harness (`pnpm eval`): precision, recall and tokens per profile against a baseline |
| [ADR 0001: job dispatch](docs/adr/0001-job-dispatch.md) | Postgres job state + Vercel Queues delivery through the proxy |
| [ADR 0002: agent auth](docs/adr/0002-agent-auth.md) | GitHub App JWTs via KMS, agent enrollment, token rotation and reuse detection |

## Layout

| Path              | Package                           | Purpose                                                      |
| ----------------- | --------------------------------- | ------------------------------------------------------------ |
| `apps/web`        | `@omniralph/web`                  | Control panel UI, agent API, queue proxy, webhooks           |
| `apps/agent`      | `@iamthemcmaster/omniralph-agent` | Agent daemon (`bin: omniralph-agent`)                        |
| `packages/engine` | `@omniralph/engine`               | Review core: diff parsing, budgets, prompts, Claude provider |
| `packages/scm`    | `@omniralph/scm`                  | SCM adapter interface + GitHub and GitLab implementations    |
| `packages/db`     | `@omniralph/db`                   | Drizzle schema, migrations, typed queries                    |
| `packages/shared` | `@omniralph/shared`               | zod schemas and shared types                                 |
| `evals`           |                                   | Review eval corpus and baseline (`pnpm eval`)                |

## Development

Requires Node 22 and pnpm 10 (`corepack enable`). `@iamthemcmaster/ui` is a private npm package:
your `~/.npmrc` must be authenticated. Don't commit an `.npmrc` containing a token.

```bash
pnpm install
pnpm dev        # all dev servers
pnpm typecheck  # quality gates: typecheck, lint, test
pnpm lint
pnpm test
pnpm build
pnpm eval       # review eval with real Claude tokens; not part of test/CI (see evals/README.md)
```

Workspace packages export their TypeScript source under the `@omniralph/source` export condition
(used by `tsc`, Vitest and `tsx`), and compiled `dist/` output for everything else (`node`, Next.js).
`turbo` builds dependencies first for `build` and `dev`.
