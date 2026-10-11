# Omniralph

Self-hosted AI code review and Linear-driven builds for GitHub and GitLab.

## Capabilities

Agents run jobs for one or more **capabilities**, enabled per agent under **Agents › <agent>**:

| Capability         | Jobs                                                                                  | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `review` (default) | `review.run`, `review.reply`, `review.learn-rule`, `chat.ask`                         | PRs/MRs in connected repositories are reviewed automatically (or on `@omniralph review`) with a configurable depth profile. Findings are posted inline, and dismissed false positives turn into learned rules for later reviews. Read-only: sessions can't write, run commands or push.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ralph`            | `ralph.story`, `ralph.describe-pr`, `ralph.prepare`, `ralph.request`, `ralph.cleanup` | The ralph loop, ported from cyralph: delegate a Linear epic (or issue) to the Omniralph Linear app and it's built story by story, one Claude session per story, with quality gates, a `feat(<ID>)` commit and a push after each, and ends with a PR/MR to the default branch with an agent-written description; stories routed to other repositories get their own branch and PR/MR (lanes). @mention the app for a single request instead, and reply to steer a running session live. Linked members can also start a request from a Slack or Discord thread, where the session reports and takes replies ([docs/chat.md](docs/chat.md#ralph-from-chat)), and check on or steer any run from chat. Ralph then looks after its PRs/MRs: it fixes Omniralph's review findings, `@omniralph fix` requests and failed CI (within capped rounds) and cleans up the worktree after the merge. Opt-in per repository, with cyralph's per-repository settings; see [docs/linear.md](docs/linear.md). Moving from cyralph: [docs/cutover-from-cyralph.md](docs/cutover-from-cyralph.md). |
| `triage`           | `triage.run`                                                                          | Unattended PRD triage of Linear issues: `@omniralph /triage` on an issue (or the `ralph:triage` label) rewrites it as a PRD in the format ralph builds, splits L/XL work into sub-issues (one per story plus a validation story), reformats already-triaged issues and their sub-issues, and lists what it couldn't decide under `## Open Questions` (Backlog until answered, else Todo). Never touches issues in progress or done. Read-only: sessions only read the routed repository's default branch, and the control panel makes every Linear change; see [docs/linear.md](docs/linear.md#triage).                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

All of them share the control panel, job dispatch, agents, repo cache and credential broker. Only
`ralph` jobs can get write credentials (one repository, short-lived), and the control panel
performs every code-host and Linear API call for all of them.

**Chat front door.** Connect a Slack workspace or Discord server under **Settings › Integrations**
and mention the bot in a channel: the control-panel agent, an LLM running in the control panel on
the Vercel AI Gateway, answers in a thread about the organization's ralph runs, reviews, jobs,
agents and repositories, with links to the control panel. Replies in the thread continue the
conversation. Linked members can also hand a change to a ralph session, which works and answers in
the same thread, and check on or steer any ralph run. Linked members (and Slack users on the organization's email domains, read-only) get
answers; everyone else is asked to link their chat account. See [docs/chat.md](docs/chat.md).

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

**Terms of service and privacy policy.** The control panel serves them at `<APP_URL>/terms` and
`<APP_URL>/privacy`, without sign-in, and links them from the sign-in page; use those URLs where
GitHub, GitLab, Linear, Slack or Discord app settings ask for them. They are written for the
operator of the deployment; edit `apps/web/src/app/(legal)` to name yourself and add contact
details.

## Architecture

```
                                ┌────────────────────────────────┐        ┌──────────────┐
 GitHub / GitLab ──webhooks───▶ │ Control panel (apps/web)       │──SQL──▶│ Postgres     │
   ▲          ◀──reviews, ───── │ Next.js on Vercel              │        │ (Neon)       │
   │             replies        │ • UI, webhooks, job state      │        └──────────────┘
   │                            │ • JobDispatcher (jobs table)   │
   │                            │ • agent API: claim, heartbeat, │
   │                            │   credential broker            │
   │                            │ • Vercel KMS-signed tokens     │
   │ Slack / Discord ─webhooks─▶│ • chat bot (Chat SDK) and      │        ┌──────────────┐
   │   ▲  (Discord Gateway cron)│   control-panel agent ─────────┼──────▶ │ Vercel AI    │
   │   └──thread replies ────── │   (AI SDK)                     │        │ Gateway      │
   │                            └───────────────▲────────────────┘        └──────────────┘
   │                                            │ outbound HTTPS only
   │                            ┌───────────────┴────────────────┐
   └──git clone/fetch ───────── │ Harness hosts (apps/harness)   │
      (read-only, brokered)     │ omniralph-harness on Coder     │
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
- **Postgres is the job queue.** The `jobs` table holds every job's state, and agents claim jobs
  from it through the control panel (`POST /api/agent/claim`, which holds the request for up to
  50s while there's nothing to claim). The claim only hands an agent jobs of its organization and
  enabled capabilities, and jobs targeted at it (pinned repos, running ralph runs, `repo.sync`)
  come first. The heartbeat renews the leases of running jobs: a crashed agent's jobs are taken
  over once their 2-minute lease lapses, and rate-limited jobs are retried after a backoff.
  See [ADR 0006: Postgres job queue](docs/adr/0006-postgres-job-queue.md).
- **Chat runs in the control panel.** Slack events arrive as webhooks; Discord messages arrive over
  its Gateway WebSocket, which a cron keeps connected and forwards to the Discord webhook route.
  Chat SDK handles both platforms, with its state in Postgres; Slack bot tokens and the
  workspace/server → organization mappings live in our own tables. The control-panel agent
  answers with a model from the Vercel AI Gateway through `read`-tier tools scoped to the
  connection's organization; `action`-tier tools (for later features) require a linked member.
  See [ADR 0005: chat front door](docs/adr/0005-chat-front-door.md).
- **Agents make only outbound connections.** Each agent belongs to the organization it was
  enrolled in and only runs that organization's jobs. `omniralph-harness` runs on Coder instances, has no
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

1. **Deploy the control panel** on Vercel, built by GitHub Actions: Neon Postgres, the deploy
   workflow's secrets, a KMS issuer per environment, `CRON_SECRET`, sign-in and
   the other variables in [`.env.example`](.env.example).
   → [docs/deploy-control-panel.md](docs/deploy-control-panel.md)
2. **Sign in and create an organization.** Anyone allowed by `ALLOWED_EMAIL_DOMAINS` (or invited)
   can sign in and create an organization, becoming its admin. Invite teammates and set email
   domains under **Settings › Organization**; everything below is set up per organization.
3. **Connect code hosts.** Create the GitHub App from its manifest and install it under
   **Repositories › Connect GitHub** → [docs/github-app.md](docs/github-app.md). Connect GitLab
   projects with a bot token under **Repositories › Connect GitLab** → [docs/gitlab.md](docs/gitlab.md).
4. **Run a harness** on a Coder workspace as the workspace user, logged in with `claude`, enrolled
   from **Agents › Enroll agent** and run under pm2, tmux or systemd
   → [docs/deploy-agent.md](docs/deploy-agent.md), [docs/claude-auth.md](docs/claude-auth.md).

   ```bash
   omniralph-harness enroll --server https://omniralph.example.com --token <enrollment-token>
   omniralph-harness start --healthz-port 9310
   ```

   `enroll` writes the harness config to `~/.config/omniralph/harness.json` (`--config` or
   `OMNIRALPH_HARNESS_CONFIG` choose another path). The package is `@omniralph/harness` on npm.

5. **Open a PR/MR** in a connected repository. The review shows up under **Jobs** and **Reviews**,
   and the bot posts inline findings plus a summary linking to the review. Comment
   `@omniralph review [quick|standard|deep]` to re-review for new issues,
   `@omniralph review fresh [quick|standard|deep]` to re-review from scratch (matching open
   findings are superseded). Other re-reviews re-check the open findings and resolve the ones
   they confirm fixed, along with their threads. `@omniralph dismiss [reason]` in a finding's thread to dismiss it,
   or ask a question there. On PRs/MRs ralph opened, `@omniralph fix [text]` (or any other
   request outside finding threads) has ralph make the change. Admins can also use **Re-run** on a review's page or history row.
6. **Build Linear issues** (optional): create the Linear app, connect it under **Settings ›
   Integrations**, enable ralph and its Linear routing on a repository and the `ralph` capability
   on an agent, then delegate an epic to the app (or @mention it with a request)
   → [docs/linear.md](docs/linear.md). Runs show up under **Ralph runs**. Replacing cyralph?
   Follow [docs/cutover-from-cyralph.md](docs/cutover-from-cyralph.md).
7. **Chat in Slack or Discord** (optional): create the Slack app from its manifest and/or the
   Discord application, enable the AI Gateway, set the env vars, connect the workspace or server
   under **Settings › Integrations** and mention the bot: `@Omniralph what ralph runs are active?`
   Link your chat account when it asks (Slack users whose email matches their sign-in are linked
   automatically) → [docs/chat.md](docs/chat.md).
8. **Tune** profiles (**Settings › Profiles**), per-repo settings (profile, triggers, path
   excludes, custom instructions, agent pinning) and rules (**Repository › Rules**). **Analytics**
   shows tokens per review by profile, dismissal rates per repo and jobs per agent over 7/30/90 days,
   plus ralph's tokens, runs by status and story outcomes. Pick the agents' version on **Settings ›
   Agents**, and trigger an update with **Update now** on an agent's page or `omniralph-harness update`
   on its host.

## Documentation

| Doc                                                                   | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [deploy-control-panel.md](docs/deploy-control-panel.md)               | Vercel, deploying from GitHub Actions, Neon and migrations, KMS issuers, job dispatch, Cron                                                                                                                                                                                                                                                                                                                                                                                                                                |
| [deploy-agent.md](docs/deploy-agent.md)                               | Installing on Coder, enrolling, the agent's user (workspace user or an optional dedicated one) and pm2/tmux/systemd, self-update and rollback under pm2, central config and per-capability concurrency, the `ralph` capability and its host prerequisites, branch worktrees, disk usage, re-enrollment                                                                                                                                                                                                                     |
| [linear.md](docs/linear.md)                                           | The Linear app, connecting a workspace, ralph's per-repository settings, routing issues (and stories) to repositories, delegating, replies and live messages, @mentions (request mode), review/`@bot`/CI follow-up and cleanup on ralph PRs/MRs, attachments                                                                                                                                                                                                                                                               |
| [chat.md](docs/chat.md)                                               | The Slack app (manifest, distribution) and Discord application (bot, Message Content intent), the AI Gateway, connecting workspaces and servers, asking questions, ralph from chat (starting requests, reply routing, guidance, PR/MR follow-ups), filing and delegating Linear issues (the confirmation card), code questions (`chat.ask`, its read-only sandbox and minimum agent version), access levels, account linking and opting out of automatic linking, the Discord Gateway cron and its Vercel plan requirement |
| [cutover-from-cyralph.md](docs/cutover-from-cyralph.md)               | Mapping cyralph's `config.json` to Omniralph, the ordered switch-over checklist with checks, and rollback                                                                                                                                                                                                                                                                                                                                                                                                                  |
| [claude-auth.md](docs/claude-auth.md)                                 | The host `claude` login, `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`, shared rate limits, terms                                                                                                                                                                                                                                                                                                                                                                                                                        |
| [github-app.md](docs/github-app.md)                                   | GitHub App manifest, permissions (incl. Actions: read for ralph's CI fixes), events (incl. `workflow_run`), KMS-held private key                                                                                                                                                                                                                                                                                                                                                                                           |
| [gitlab.md](docs/gitlab.md)                                           | Service account bot token (`api`, Maintainer), project picker, daily token rotation, connection health and webhooks, ralph's merge requests, self-managed GitLab                                                                                                                                                                                                                                                                                                                                                           |
| [env.md](docs/env.md)                                                 | Every environment variable for the control panel and the agent                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| [evals/README.md](evals/README.md)                                    | The review eval harness (`pnpm eval`): precision, recall and tokens per profile against a baseline                                                                                                                                                                                                                                                                                                                                                                                                                         |
| [ADR 0001: job dispatch](docs/adr/0001-job-dispatch.md)               | Superseded by ADR 0006: Postgres job state + Vercel Queues delivery through the proxy                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| [ADR 0002: agent auth](docs/adr/0002-agent-auth.md)                   | GitHub App JWTs via KMS, agent enrollment, token rotation and reuse detection                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| [ADR 0003: ralph orchestration](docs/adr/0003-ralph-orchestration.md) | One job per story, sticky agents, attempts vs deliveries, the run lock, Vercel Workflows deferred; addendum: request mode, lanes, live messages, PR follow-up, concurrency, self-update; addendum: run origin (Linear or chat) and `RunConversation`                                                                                                                                                                                                                                                                       |
| [ADR 0004: organizations](docs/adr/0004-organizations.md)             | The tenancy model, per-org roles, invitations and email domains, job isolation, uniqueness rules                                                                                                                                                                                                                                                                                                                                                                                                                           |
| [ADR 0005: chat front door](docs/adr/0005-chat-front-door.md)         | Chat SDK, our tables owning installations, the Discord Gateway cron, the control-panel agent on the AI Gateway, tool tiers and access levels                                                                                                                                                                                                                                                                                                                                                                               |
| [ADR 0006: Postgres job queue](docs/adr/0006-postgres-job-queue.md)   | The `jobs` table as the queue: the claim query, the long-poll, leases renewed by the heartbeat, delayed retry, the cutover from Vercel Queues                                                                                                                                                                                                                                                                                                                                                                              |

## Layout

| Path              | Package              | Purpose                                                      |
| ----------------- | -------------------- | ------------------------------------------------------------ |
| `apps/web`        | `@omniralph/web`     | Control panel UI, agent API, job claims, webhooks            |
| `apps/harness`    | `@omniralph/harness` | Harness host daemon (`bin: omniralph-harness`)               |
| `packages/engine` | `@omniralph/engine`  | Review core: diff parsing, budgets, prompts, Claude provider |
| `packages/scm`    | `@omniralph/scm`     | SCM adapter interface + GitHub and GitLab implementations    |
| `packages/db`     | `@omniralph/db`      | Drizzle schema, migrations, typed queries                    |
| `packages/ralph`  | `@omniralph/ralph`   | Ralph loop logic: PRD parsing, story selection, prompts      |
| `packages/shared` | `@omniralph/shared`  | zod schemas and shared types                                 |
| `evals`           |                      | Review eval corpus and baseline (`pnpm eval`)                |

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
