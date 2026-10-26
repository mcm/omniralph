# Omniralph

Self-hosted AI code review and Linear-driven builds for GitHub and GitLab.

## Capabilities

Harnesses run jobs for these **capabilities**. Each harness accepts task types (`query`, `review`, `coding`) chosen in its own local config (`acceptedTaskTypes` in `harness.json`, all by default): review and triage jobs are `query` and `review` tasks, ralph jobs `coding` tasks.

| Capability         | Jobs                                                                                                   | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `review` (default) | `review.task`, `review.correlate`, `review.reply`, `review.learn-rule`, `chat.ask`                     | PRs/MRs in connected repositories are reviewed automatically (or on `@omniralph review`) at the repository's review depth (Quick, Standard or Deep). Each PR/MR event starts one review run: every review task the repository enables (default `builtin:review-pr`; `builtin:summarize-pr` adds a PR/MR summary in a comment that's edited in place) runs in parallel, a correlation task merges findings several tasks reported, and one review is posted, its findings inline. Dismissed false positives turn into learned rules for later reviews. Read-only: sessions can't write, run commands or push; a task's setup commands (e.g. Semgrep) can feed them deterministic tool output. See [ADR 0008](docs/adr/0008-agents-tasks-and-the-harness.md#review-runs).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ralph`            | `ralph.story`, `ralph.describe-pr`, `ralph.request`, `ralph.push`, `worktree.exec`, `worktree.cleanup` | The ralph loop, ported from cyralph: delegate a Linear epic (or issue) to the Omniralph Linear app and it's built story by story, one Claude session per story, with quality gates, a `feat(<ID>)` commit and a push after each, and ends with a PR/MR to the default branch with a harness-written description; stories routed to other repositories get their own branch and PR/MR (lanes). @mention the app for a single request instead, and reply to steer a running session live. Linked members can also start a request from a Slack or Discord thread, where the session reports and takes replies ([docs/chat.md](docs/chat.md#ralph-from-chat)), and check on or steer any run from chat. Ralph then looks after its PRs/MRs: it fixes Omniralph's review findings, `@omniralph fix` requests and failed CI (within capped rounds) and cleans up the worktree after the merge (keeping the branch when the PR/MR is closed unmerged or the run stopped). Opt-in per repository, with cyralph's per-repository settings; stories and requests are coding runs of the repository's story and request tasks (built-in `builtin:implement-story` and `builtin:handle-request`), whose sessions push only through the harness's `ship` tool. See [docs/linear.md](docs/linear.md). Moving from cyralph: [docs/cutover-from-cyralph.md](docs/cutover-from-cyralph.md). |
| `triage`           | `triage.run`                                                                                           | Unattended PRD triage of Linear issues: `@omniralph /triage` on an issue (or the `coding:triage` label) rewrites it as a PRD in the format ralph builds, splits L/XL work into sub-issues (one per story plus a validation story), reformats already-triaged issues and their sub-issues, and lists what it couldn't decide under `## Open Questions` (Backlog until answered, else Todo). Never touches issues in progress or done. Read-only: sessions only read the routed repository's default branch, and the control panel makes every Linear change; see [docs/linear.md](docs/linear.md#triage).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

All of them share the control panel, job dispatch, harnesses, repo cache and credential broker. Only
`ralph` jobs can get write credentials (one repository, short-lived), and the control panel
performs every code-host and Linear API call for all of them.

**Chat front door.** Connect a Slack workspace or Discord server under **Settings › Integrations**
and mention the bot in a channel: the control-panel agent, an LLM running in the control panel on
the Vercel AI Gateway, answers in a thread about the organization's ralph runs, reviews, jobs,
harnesses and repositories, with links to the control panel. Replies in the thread continue the
conversation. Linked members can also hand a change to a ralph session, which works and answers in
the same thread, and check on or steer any ralph run. Linked members (and Slack users on the organization's email domains, read-only) get
answers; everyone else is asked to link their chat account. See [docs/chat.md](docs/chat.md).

## Organizations

Everything in Omniralph belongs to an **organization**: code-host connections, repositories,
review settings and rules, reviews, the Linear workspace, harnesses and their enrollments, settings
(such as the harnesses' desired version), jobs and ralph runs. Members of an organization share all
of it; nobody outside it sees any of it, and its jobs only ever reach its own harnesses.

- **Any signed-in user can create an organization** and becomes its admin. Users can belong to
  several organizations and switch between them with the organization switcher in the sidebar;
  the active one is remembered per user.
- **Roles are per organization.** `admin`s connect code hosts and Linear, enroll and configure
  harnesses, change settings and rules, and manage members; `member`s see everything in the
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
   │                            │ • harness API: claim, heartbeat, │
   │                            │   credential broker            │
   │                            │ • Vercel KMS-signed tokens     │
   │ Slack / Discord ─webhooks─▶│ • chat bot (Chat SDK) and      │        ┌──────────────┐
   │   ▲                        │   control-panel agent ─────────┼──────▶ │ Vercel AI    │
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
  reviews, ralph runs, rules, harnesses, jobs) lives here.
- **The control panel orchestrates ralph runs.** Each story attempt is one `ralph.story` coding run; the control
  panel selects the next story, applies job outcomes under a per-run lock, talks to Linear and
  opens the PR/MR. A run sticks to one harness, which keeps the branch worktree warm. Stories and
  requests are coding runs of the repository's story and request tasks (built-in
  `builtin:implement-story` and `builtin:handle-request`), whose sessions push only through the
  harness.
  See [ADR 0003: ralph orchestration](docs/adr/0003-ralph-orchestration.md) and
  [ADR 0008](docs/adr/0008-agents-tasks-and-the-harness.md#coding-runs).
- **Postgres is the job queue.** The `jobs` table holds every job's state, and harnesses claim jobs
  from it through the control panel (`POST /api/harness/claim`, which holds the request for up to
  50s while there's nothing to claim). The claim only hands a harness jobs of its organization and
  accepted task types and free pools, and jobs targeted at it (pinned repos, running ralph runs, `repo.sync`)
  come first. The heartbeat renews the leases of running jobs: a crashed harness's jobs are taken
  over once their 2-minute lease lapses, and rate-limited jobs are retried after a backoff.
  See [ADR 0006: Postgres job queue](docs/adr/0006-postgres-job-queue.md). With `ABLY_API_KEY` set,
  harnesses don't hold claims: a dispatch publishes an Ably wake message and the harness claims at
  once, with the heartbeat's `claimable` flag as the fallback. See
  [ADR 0009: Ably wake signals](docs/adr/0009-ably-wake-signals.md).
- **Chat runs in the control panel.** Slack events arrive as webhooks; Discord messages arrive over
  its Gateway WebSocket, which the control panel doesn't connect to yet (to be redesigned).
  Chat SDK handles both platforms, with its state in Postgres; Slack bot tokens and the
  workspace/server → organization mappings live in our own tables. The control-panel agent
  answers with a model from the Vercel AI Gateway through `read`-tier tools scoped to the
  connection's organization; `action`-tier tools (for later features) require a linked member.
  See [ADR 0005: chat front door](docs/adr/0005-chat-front-door.md).
- **Harnesses make only outbound connections.** Each harness belongs to the organization it was
  enrolled in and only runs that organization's jobs. `omniralph-harness` runs on Coder instances, has no
  inbound port and a minimal local config (server, harness ID, rotating refresh token, workspace
  root, and optionally the task types it accepts, which it reports in every heartbeat and claim).
  Concurrency (also per pool, so ralph never takes every slot), pins,
  cancellations, the desired harness version (pm2 harnesses update themselves and roll back a broken
  release) and replies for running ralph sessions come back with each heartbeat. It
  authenticates with 15-minute RS256 access tokens signed by Vercel KMS, and rotating refresh tokens
  with reuse detection. See [ADR 0002: harness auth](docs/adr/0002-agent-auth.md).
- **Credential broker.** Harnesses never hold code-host API tokens. For git, the harness's
  `git-credential` helper asks the control panel (with a job-scoped token) for a short-lived token
  for that job's repository: a GitHub installation token limited to `contents: read` (≤ 1 hour) or
  a GitLab `read_repository` project access token (1 day, rotated). Only the harness's own git
  commands of a coding run (its `lifecycle` token), legacy `ralph.*` jobs and the
  `worktree.cleanup` RPC, whose tokens carry `credentials:write`, get a write token instead
  (`contents: write` / `write_repository`) to push their branch; a Claude session's `session`
  token never can, so coding-run sessions push through the harness's `ship` tool, and review jobs
  never push. Git traffic goes straight to the
  code host.
- **Security boundary.** PR content is untrusted. Review sessions are read-only: only `Read`, `Grep`
  and `Glob` inside the job's worktree, no shell, writes or network tools, and `settingSources: []`
  so nothing from the PR head (`.claude/`, MCP config, `CLAUDE.md`) is loaded. A task's setup
  commands run before the session without either job token, and their output reaches it fenced as
  untrusted data. Repo conventions come from the base branch's `CLAUDE.md`, passed as quoted data;
  a deterministic pre-pass flags prompt-injection text; bot-posted text goes through an output sanitizer. Ralph sessions build
  code from issues people delegated, in repositories that opted in: they run with full permissions
  in the run's branch worktree and the repository's own Claude settings, but without the job token:
  story sessions leave committing and pushing to the job. Request sessions (mentions, review and CI
  follow-ups) push their branch themselves through the `git-credential` helper, which reads the job
  token from a private file the harness keeps current; a `pre-push` hook rejects any other ref.

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
   from **Harnesses › Enroll harness** and run under pm2, tmux or systemd
   → [docs/deploy-harness.md](docs/deploy-harness.md), [docs/claude-auth.md](docs/claude-auth.md).

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
   every review task confirms fixed, along with their threads. `@omniralph dismiss [reason]` in a finding's thread to dismiss it,
   or ask a question there. On PRs/MRs ralph opened, `@omniralph fix [text]` (or any other
   request outside finding threads, or in them when the run has a Linear agent session, with
   the finding's whole review as context) has ralph make the change. Admins can also use **Re-run** on a review's page or history row.
6. **Build Linear issues** (optional): create the Linear app, connect it under **Settings ›
   Integrations**, enable ralph and its Linear routing on a repository and `coding` tasks
   on a harness, then delegate an epic to the app (or @mention it with a request)
   → [docs/linear.md](docs/linear.md). Runs show up under **Coding tasks**. Replacing cyralph?
   Follow [docs/cutover-from-cyralph.md](docs/cutover-from-cyralph.md).
7. **Chat in Slack or Discord** (optional): create the Slack app from its manifest and/or the
   Discord application, enable the AI Gateway, set the env vars, connect the workspace or server
   under **Settings › Integrations** and mention the bot: `@Omniralph what ralph runs are active?`
   Link your chat account when it asks (Slack users whose email matches their sign-in are linked
   automatically) → [docs/chat.md](docs/chat.md).
8. **Tune** per-repo settings (triggers, review tasks,
   path excludes, custom instructions, harness pinning) and rules (**Repository › Rules**). **Analytics**
   shows tokens per review by review depth, dismissal rates per repo and jobs per harness over 7/30/90 days,
   plus ralph's tokens, runs by status and story outcomes. Pick the harnesses' version on **Settings ›
   Harnesses**, and trigger an update with **Update now** on a harness's page or `omniralph-harness update`
   on its host.

## Documentation

| Doc                                                                                      | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [deploy-control-panel.md](docs/deploy-control-panel.md)                                  | Vercel, deploying from GitHub Actions, Neon and migrations, KMS issuers, job dispatch, Cron                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| [deploy-harness.md](docs/deploy-harness.md)                                              | Installing on Coder, enrolling, the harness's user (workspace user or an optional dedicated one) and pm2/tmux/systemd, self-update and rollback under pm2, local accepted task types, central config (per-pool concurrency), ralph and its host prerequisites, branch worktrees, disk usage, re-enrollment                                                                                                                                                                                                                         |
| [installables.md](docs/installables.md)                                                  | Writing an installable (the `omniralph` manifest, commands, MCP servers, caches), installing it on a harness, host tools and their negotiated paths, requiring them in tasks, locking a host down with `installables.allow` and `blockedExecPaths`                                                                                                                                                                                                                                                                           |
| [linear.md](docs/linear.md)                                                              | The Linear app, connecting a workspace, ralph's per-repository settings, routing issues (and stories) to repositories, delegating, replies and live messages, @mentions (request mode), review/`@bot`/CI follow-up and cleanup on ralph PRs/MRs, attachments                                                                                                                                                                                                                                                                 |
| [chat.md](docs/chat.md)                                                                  | The Slack app (manifest, distribution) and Discord application (bot, Message Content intent), the AI Gateway, connecting workspaces and servers, asking questions, ralph from chat (starting requests, reply routing, guidance, PR/MR follow-ups), filing and delegating Linear issues (the confirmation card), code questions (`chat.ask`, its read-only sandbox and minimum harness version), access levels, account linking and opting out of automatic linking, the Discord Gateway cron and its Vercel plan requirement |
| [cutover-from-cyralph.md](docs/cutover-from-cyralph.md)                                  | Mapping cyralph's `config.json` to Omniralph, the ordered switch-over checklist with checks, and rollback                                                                                                                                                                                                                                                                                                                                                                                                                    |
| [claude-auth.md](docs/claude-auth.md)                                                    | The host `claude` login, `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`, shared rate limits, terms                                                                                                                                                                                                                                                                                                                                                                                                                          |
| [github-app.md](docs/github-app.md)                                                      | GitHub App manifest, permissions (incl. Actions: read for ralph's CI fixes), events (incl. `workflow_run`), KMS-held private key                                                                                                                                                                                                                                                                                                                                                                                             |
| [gitlab.md](docs/gitlab.md)                                                              | Service account bot token (`api`, Maintainer), project picker, daily token rotation, connection health and webhooks, ralph's merge requests, self-managed GitLab                                                                                                                                                                                                                                                                                                                                                             |
| [env.md](docs/env.md)                                                                    | Every environment variable for the control panel and the harness                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| [evals/README.md](evals/README.md)                                                       | The review eval harness (`pnpm eval`): precision, recall and tokens per profile against a baseline                                                                                                                                                                                                                                                                                                                                                                                                                           |
| [ADR 0001: job dispatch](docs/adr/0001-job-dispatch.md)                                  | Superseded by ADR 0006: Postgres job state + Vercel Queues delivery through the proxy                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| [ADR 0002: harness auth](docs/adr/0002-agent-auth.md)                                    | GitHub App JWTs via KMS, harness enrollment, token rotation and reuse detection                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| [ADR 0003: ralph orchestration](docs/adr/0003-ralph-orchestration.md)                    | One job per story, sticky harnesses, attempts vs deliveries, the run lock, Vercel Workflows deferred; addendum: request mode, lanes, live messages, PR follow-up, concurrency, self-update; addendum: run origin (Linear or chat) and `RunConversation`                                                                                                                                                                                                                                                                      |
| [ADR 0004: organizations](docs/adr/0004-organizations.md)                                | The tenancy model, per-org roles, invitations and email domains, job isolation, uniqueness rules                                                                                                                                                                                                                                                                                                                                                                                                                             |
| [ADR 0005: chat front door](docs/adr/0005-chat-front-door.md)                            | Chat SDK, our tables owning installations, the Discord Gateway cron, the control-panel agent on the AI Gateway, tool tiers and access levels                                                                                                                                                                                                                                                                                                                                                                                 |
| [ADR 0006: Postgres job queue](docs/adr/0006-postgres-job-queue.md)                      | The `jobs` table as the queue: the claim query, the long-poll, leases renewed by the heartbeat, delayed retry, the cutover from Vercel Queues                                                                                                                                                                                                                                                                                                                                                                                |
| [ADR 0007: Redis hot state](docs/adr/0007-redis-hot-state.md)                            | What idle paths keep in Redis (Upstash over TCP) so Neon can suspend: the keys and their writers, rules for writers, the epoch rebuild, the Postgres fallback, what still queries Postgres while idle                                                                                                                                                                                                                                                                                                                        |
| [ADR 0008: agents, tasks and the harness](docs/adr/0008-agents-tasks-and-the-harness.md) | Agent and task definitions, task types and their lifecycles, run specs resolved at claim time, sinks, pools, lifecycle and session tokens, setup commands; review runs: fan-out per review task, correlation, one posted review, sticky comments                                                                                                                                                                                                                                                                             |
| [ADR 0009: Ably wake signals](docs/adr/0009-ably-wake-signals.md)                        | Wake messages on dispatch instead of the claim long-poll: channels, subscribe-only JWTs on the heartbeat, the `claimable` fallback flag, harness modes, the cutover                                                                                                                                                                                                                                                                                                                                                          |

## Layout

| Path              | Package              | Purpose                                                      |
| ----------------- | -------------------- | ------------------------------------------------------------ |
| `apps/web`        | `@omniralph/web`     | Control panel UI, harness API, job claims, webhooks          |
| `apps/harness`    | `@omniralph/harness` | Harness host daemon (`bin: omniralph-harness`)               |
| `packages/engine` | `@omniralph/engine`  | Review core: diff parsing, budgets, prompts, Claude provider |
| `packages/scm`    | `@omniralph/scm`     | SCM adapter interface + GitHub and GitLab implementations    |
| `packages/db`     | `@omniralph/db`      | Drizzle schema, migrations, typed queries                    |
| `packages/ralph`  | `@omniralph/ralph`   | Ralph loop logic: PRD parsing, story selection, prompts      |
| `packages/shared` | `@omniralph/shared`  | zod schemas and shared types                                 |
| `packages/tasks`  | `@omniralph/tasks`   | Agent and task definitions, built-ins, templates, variables  |
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
