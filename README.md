# Omniralph

Self-hosted AI code review and Linear-driven builds for GitHub and GitLab.

## Capabilities

Agents run jobs for one or more **capabilities**, enabled per agent under **Agents › <agent>**:

| Capability | Jobs | What it does |
| -- | -- | -- |
| `review` (default) | `review.run`, `review.reply`, `review.learn-rule` | PRs/MRs in connected repositories are reviewed automatically (or on `@omniralph review`) with a configurable depth profile. Findings are posted inline, and dismissed false positives turn into learned rules for later reviews. Read-only: sessions can't write, run commands or push. |
| `ralph` | `ralph.story`, `ralph.describe-pr`, `ralph.prepare`, `ralph.request`, `ralph.cleanup` | The ralph loop, ported from cyralph: delegate a Linear epic (or issue) to the Omniralph Linear app and it's built story by story, one Claude session per story, with quality gates, a `feat(<ID>)` commit and a push after each, and ends with a PR/MR to the default branch with an agent-written description; stories routed to other repositories get their own branch and PR/MR (lanes). @mention the app for a single request instead, and reply to steer a running session live. Ralph then looks after its PRs/MRs: it fixes Omniralph's review findings, `@omniralph fix` requests and failed CI (within capped rounds) and cleans up the worktree after the merge. Opt-in per repository, with cyralph's per-repository settings; see [docs/linear.md](docs/linear.md). Moving from cyralph: [docs/cutover-from-cyralph.md](docs/cutover-from-cyralph.md). |

Both share the control panel, job dispatch, agents, repo cache and credential broker. Only `ralph`
jobs can get write credentials (one repository, short-lived), and the control panel performs every
code-host and Linear API call for both.

## Organizations

Everything in Omniralph belongs to an **organization**: code-host connections, repositories,
review profiles and rules, reviews, the Linear workspace, agents and their enrollments, settings
(such as the agents' desired version), jobs and ralph runs. Members of an organization share all
of it; nobody outside it sees any of it, and its jobs only ever reach its own agents.

- **Any signed-in user can create an organization** and becomes its admin. Users can belong to
  several organizations and switch between them with the organization switcher in the sidebar;
  the active one is remembered per user.
- **Roles are per organization.** `admin`s connect code hosts and Linear, enroll and configure
  agents, change settings, profiles and rules, and manage members; `member`s see everything in the
  organization and can dismiss and restore findings, but not change its setup. There's no
  instance-wide admin. The last admin of an organization can't be demoted, removed or leave.
- **Invitations.** Admins invite people by email under **Settings › Organization**, as `admin` or
  `member`. Invitations expire after 14 days and can be revoked. No email is sent: the invitee
  signs in and accepts it on the onboarding page (also reachable from **New organization** in the
  switcher). A pending invitation also
  lets that email sign in when its domain isn't in `ALLOWED_EMAIL_DOMAINS`.
- **Email domains.** An organization can restrict invitations and joins to some email domains, and
  with **Allow anyone with a matching email to join** list itself for matching signed-in users,
  who join as `member` without an invitation.
- **Sign-in** is the only instance-wide setting: `ALLOWED_EMAIL_DOMAINS`, plus invited emails.
  A signed-in user without an organization lands on onboarding: create one, accept an
  invitation, or join one that allows their email domain.
- A GitHub App installation, a GitLab bot user on an instance and a Linear workspace each belong
  to one organization. To move one, disconnect or remove it in the first organization
  (**Repositories › Code-host connections › Remove** deletes the connection with its repositories;
  uninstalling the GitHub App does the same), then connect it from the other.

See [ADR 0004: organizations](docs/adr/0004-organizations.md).

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

- **The control panel is the single integration point.** It holds the GitHub App, GitLab bot and
  Linear app credentials (encrypted at rest; installations and connections per organization), receives webhooks and `@bot` commands, owns all job
  and ralph run state in Postgres, and performs every code-host write (posting reviews, replies,
  resolving threads, opening ralph's PRs/MRs) as a typed operation. The UI (repositories, settings,
  profiles, reviews, ralph runs, rules, agents, jobs) lives here.
- **The control panel orchestrates ralph runs.** Each story is one `ralph.story` job; the control
  panel selects the next story, applies job outcomes under a per-run lock, talks to Linear and
  opens the PR/MR. A run sticks to one agent, which keeps the branch worktree warm.
  See [ADR 0003: ralph orchestration](docs/adr/0003-ralph-orchestration.md).
- **Dispatch through Vercel Queues and the proxy.** Postgres is the source of truth; Vercel Queues
  (poll mode) only delivers `{ jobId }` messages to per-organization capability topics
  (`review-jobs-org-<orgId>`, `ralph-jobs-org-<orgId>`, or a per-agent topic for pinned repos and
  running ralph runs), with one competing consumer group. Agents never talk to Vercel: they
  poll through the control panel's queue proxy (`/api/agent/queue/<region>/…`), which allows only
  receive, acknowledge and extend-lease on the agent's own topics (its organization's capability
  topics and its agent topics). Crashed agents' leases lapse
  and jobs are redelivered; rate-limited jobs are retried after a backoff.
  See [ADR 0001: job dispatch](docs/adr/0001-job-dispatch.md).
- **Agents make only outbound connections.** Each agent belongs to the organization it was
  enrolled in and only runs that organization's jobs. `omniralph-agent` runs on Coder instances, has no
  inbound port and a minimal local config (server, agent ID, rotating refresh token, workspace
  root). Concurrency (also per capability, so ralph never takes every slot), capabilities, pins,
  cancellations, the desired agent version (pm2 agents update themselves and roll back a broken
  release) and replies for running ralph sessions come back with each heartbeat. It
  authenticates with 15-minute RS256 access tokens signed by Vercel KMS, and rotating refresh tokens
  with reuse detection. See [ADR 0002: agent auth](docs/adr/0002-agent-auth.md).
- **Credential broker.** Agents never hold code-host API tokens. For git, the agent's
  `git-credential` helper asks the control panel (with a job-scoped token) for a short-lived token
  for that job's repository: a GitHub installation token limited to `contents: read` (≤ 1 hour) or
  a GitLab `read_repository` project access token (1 day, rotated). Only running `ralph` jobs, whose
  job token carries `credentials:write`, get a write token instead (`contents: write` /
  `write_repository`) to push their branch; review jobs never can. Git traffic goes straight to the
  code host.
- **Security boundary.** PR content is untrusted. Review sessions are read-only: only `Read`, `Grep`
  and `Glob` inside the job's worktree, no shell, writes or network tools, and `settingSources: []`
  so nothing from the PR head (`.claude/`, MCP config, `CLAUDE.md`) is loaded. Repo conventions come
  from the base branch's `CLAUDE.md`, passed as quoted data; a deterministic pre-pass flags
  prompt-injection text; bot-posted text goes through an output sanitizer. Ralph sessions build
  code from issues people delegated, in repositories that opted in: they run with full permissions
  in the run's branch worktree and the repository's own Claude settings, but without the job token:
  story sessions leave committing and pushing to the job. Request sessions (mentions, review and CI
  follow-ups) push their branch themselves through the `git-credential` helper, which reads the job
  token from a private file the agent keeps current; a `pre-push` hook rejects any other ref.

## Quickstart

1. **Deploy the control panel** on Vercel: Neon Postgres, `NPM_RC`, a KMS issuer per environment,
   `QUEUE_REGIONS`, `CRON_SECRET`, sign-in and the other variables in [`.env.example`](.env.example).
   → [docs/deploy-control-panel.md](docs/deploy-control-panel.md)
2. **Sign in and create an organization.** Anyone allowed by `ALLOWED_EMAIL_DOMAINS` (or invited)
   can sign in and create an organization, becoming its admin. Invite teammates and set email
   domains under **Settings › Organization**; everything below is set up per organization.
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
   or ask a question there. On PRs/MRs ralph opened, `@omniralph fix [text]` (or any other
   request outside finding threads) has ralph make the change. Admins can also use **Re-run** on a review's page or history row.
6. **Build Linear issues** (optional): create the Linear app, connect it under **Settings ›
   Integrations**, enable ralph and its Linear routing on a repository and the `ralph` capability
   on an agent, then delegate an epic to the app (or @mention it with a request)
   → [docs/linear.md](docs/linear.md). Runs show up under **Ralph runs**. Replacing cyralph?
   Follow [docs/cutover-from-cyralph.md](docs/cutover-from-cyralph.md).
7. **Tune** profiles (**Settings › Profiles**), per-repo settings (profile, triggers, path
   excludes, custom instructions, agent pinning) and rules (**Repository › Rules**). **Analytics**
   shows tokens per review by profile, dismissal rates per repo and jobs per agent over 7/30/90 days,
   plus ralph's tokens, runs by status and story outcomes. Pick the agents' version on **Settings ›
   Agents**.

## Documentation

| Doc | Covers |
| -- | -- |
| [deploy-control-panel.md](docs/deploy-control-panel.md) | Vercel, `NPM_RC`, Neon and migrations, KMS issuers, Vercel Queues regions, Cron |
| [deploy-agent.md](docs/deploy-agent.md) | Installing on Coder, enrolling, dedicated user and systemd/tmux/pm2, self-update and rollback under pm2, central config and per-capability concurrency, the `ralph` capability and its host prerequisites, branch worktrees, disk usage, re-enrollment |
| [linear.md](docs/linear.md) | The Linear app, connecting a workspace, ralph's per-repository settings, routing issues (and stories) to repositories, delegating, replies and live messages, @mentions (request mode), review/`@bot`/CI follow-up and cleanup on ralph PRs/MRs, attachments |
| [cutover-from-cyralph.md](docs/cutover-from-cyralph.md) | Mapping cyralph's `config.json` to Omniralph, the ordered switch-over checklist with checks, and rollback |
| [claude-auth.md](docs/claude-auth.md) | The host `claude` login, `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`, shared rate limits, terms |
| [github-app.md](docs/github-app.md) | GitHub App manifest, permissions (incl. Actions: read for ralph's CI fixes), events (incl. `workflow_run`), KMS-held private key |
| [gitlab.md](docs/gitlab.md) | Bot token scopes and role, webhook events (incl. Pipeline events), ralph's merge requests and their follow-up, self-managed GitLab |
| [env.md](docs/env.md) | Every environment variable for the control panel and the agent |
| [evals/README.md](evals/README.md) | The review eval harness (`pnpm eval`): precision, recall and tokens per profile against a baseline |
| [ADR 0001: job dispatch](docs/adr/0001-job-dispatch.md) | Postgres job state + Vercel Queues delivery through the proxy |
| [ADR 0002: agent auth](docs/adr/0002-agent-auth.md) | GitHub App JWTs via KMS, agent enrollment, token rotation and reuse detection |
| [ADR 0003: ralph orchestration](docs/adr/0003-ralph-orchestration.md) | One job per story, sticky agents, attempts vs deliveries, the run lock, Vercel Workflows deferred; addendum: request mode, lanes, live messages, PR follow-up, concurrency, self-update |
| [ADR 0004: organizations](docs/adr/0004-organizations.md) | The tenancy model, per-org roles, invitations and email domains, per-org topics, uniqueness rules |

## Layout

| Path              | Package                           | Purpose                                                      |
| ----------------- | --------------------------------- | ------------------------------------------------------------ |
| `apps/web`        | `@omniralph/web`                  | Control panel UI, agent API, queue proxy, webhooks           |
| `apps/agent`      | `@iamthemcmaster/omniralph-agent` | Agent daemon (`bin: omniralph-agent`)                        |
| `packages/engine` | `@omniralph/engine`               | Review core: diff parsing, budgets, prompts, Claude provider |
| `packages/scm`    | `@omniralph/scm`                  | SCM adapter interface + GitHub and GitLab implementations    |
| `packages/db`     | `@omniralph/db`                   | Drizzle schema, migrations, typed queries                    |
| `packages/ralph`  | `@omniralph/ralph`                | Ralph loop logic: PRD parsing, story selection, prompts      |
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
