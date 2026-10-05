# Omniralph

Self-hosted AI code review for GitHub and GitLab, plus the shared foundation for the cyralph agent.

- **Control panel** (`apps/web`): Next.js 16 on Vercel. The single integration point: holds code-host
  credentials, receives webhooks, owns job state and brokers short-lived credentials to agents.
- **Agent host** (`apps/agent`, `omniralph-agent`): a Node 22 daemon on Coder instances that pulls
  jobs through the control panel and runs capabilities (v1: code review via the Claude Agent SDK).

## Layout

| Path              | Package                           | Purpose                                                      |
| ----------------- | --------------------------------- | ------------------------------------------------------------ |
| `apps/web`        | `@omniralph/web`                  | Control panel UI, agent API, queue proxy, webhooks           |
| `apps/agent`      | `@iamthemcmaster/omniralph-agent` | Agent daemon (`bin: omniralph-agent`)                        |
| `packages/engine` | `@omniralph/engine`               | Review core: diff parsing, budgets, prompts, Claude provider |
| `packages/scm`    | `@omniralph/scm`                  | SCM adapter interface + GitHub and GitLab implementations    |
| `packages/db`     | `@omniralph/db`                   | Drizzle schema, migrations, typed queries                    |
| `packages/shared` | `@omniralph/shared`               | zod schemas and shared types                                 |

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
```

Workspace packages export their TypeScript source under the `@omniralph/source` export condition
(used by `tsc`, Vitest and `tsx`), and compiled `dist/` output for everything else (`node`, Next.js).
`turbo` builds dependencies first for `build` and `dev`.

## Deployment

Every Vercel build runs `pnpm --filter @omniralph/db migrate` before `turbo run build`
(`apps/web/vercel.json`), so each deployment migrates the database it's connected to: its own
Neon branch for previews, the main branch for production. It runs outside `turbo` so the remote
cache can't skip it. Migrations apply before the new deployment serves traffic, so they must stay
compatible with the code that's still live.

## Setting up the control panel

1. **Environment.** Set the variables in `.env.example` on the Vercel project: database (Neon
   integration), `ENCRYPTION_KEY`, `APP_URL`, `AUTH_*` + `ALLOWED_EMAIL_DOMAINS`, `KMS_AGENT_ISSUER_ID`
   (one Vercel KMS issuer per environment), `QUEUE_REGIONS`, `CRON_SECRET` and `NPM_RC`. The first
   person to sign in becomes admin.
2. **GitHub App** (one per control panel). Permissions: contents read, pull requests write, metadata
   read. Events: pull request, issue comment, pull request review comment. Webhook URL
   `<APP_URL>/api/webhooks/github` with a secret (`GITHUB_WEBHOOK_SECRET`). Setup URL
   `<APP_URL>/repositories/github/callback` with "Redirect on update" on. Set `GITHUB_APP_ID` and
   either `GITHUB_APP_KMS_ISSUER_ID` (private key imported into Vercel KMS) or
   `GITHUB_APP_PRIVATE_KEY`.
3. **Connect repositories** (admin) under **Repositories**: "Connect GitHub" installs the App and
   lets you pick repositories; "Connect GitLab" takes the base URL (gitlab.com or self-managed), a bot
   access token with the `api` scope and the projects, validates the token and creates each project's
   webhook (`<APP_URL>/api/webhooks/gitlab`) itself.
4. **Enroll an agent** under **Agents › Enroll agent** and run the command it shows (once, within
   an hour) on the agent host; see below.

New PRs/MRs (open, reopen, ready for review, push; drafts skipped) in enabled repositories are then
reviewed with the Standard profile.

## Running an agent

Agents run from a checkout for now (`pnpm turbo run build --filter=@iamthemcmaster/omniralph-agent`), as a
dedicated Unix user with Node 22, git and a logged-in `claude`. They only make outbound HTTPS calls
to the control panel.

The Agents page shows the enrollment command as `omniralph-agent enroll ...`. From a checkout,
put the built CLI on `PATH` first, e.g.
`chmod +x apps/agent/dist/cli.js && ln -s "$PWD/apps/agent/dist/cli.js" ~/.local/bin/omniralph-agent`
(it has a `node` shebang), or
run it as `node apps/agent/dist/cli.js`.

```bash
# One-time: exchange an enrollment token from the Agents page for a refresh token.
node apps/agent/dist/cli.js enroll --server https://omniralph.example --token <enrollment-token> \
  [--name <name>] [--workspace-root <dir>]   # writes ~/.config/omniralph/agent.json (mode 0600)
# Run under systemd or tmux; SIGTERM waits up to 60s for running jobs.
node apps/agent/dist/cli.js start [--healthz-port 9310]
```

Concurrency, poll interval, capabilities and topics come from the control panel with every
heartbeat. If the control panel rejects the refresh token (agent revoked, or token reuse detected)
the agent exits non-zero and has to be enrolled again.

Repositories are cached under `workspaceRoot` (blobless bare clones in
`<workspaceRoot>/<provider>/<repo path>`, one git worktree per job in `.worktrees/<jobId>`, removed
afterwards and pruned on startup). Git never uses the host's credentials: job git commands reset
`credential.helper` and use `omniralph-agent git-credential`, which fetches a short-lived read-only
token for the job's repository from the control panel with the job's token. Pinning a repository to
an agent makes it pre-clone the repository (`repo.sync`). git ≥ 2.44 is recommended (older versions
lazily fetch commits while checking whether they're cached).
