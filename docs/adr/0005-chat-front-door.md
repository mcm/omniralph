# ADR 0005: The chat front door — Chat SDK and a control-panel agent

- **Status:** Accepted (TOOL-176)
- **Date:** 2026-10-09

## Context

People reach ralph only through Linear, and Omniralph's state only through the control panel UI.
Teams live in Slack and Discord and want to ask "what ralph runs are active?" or "why did that
review stop?" where they already talk, and later hand work to ralph or file Linear issues from a
thread ([TOOL-181](https://linear.app/thefrakinship/issue/TOOL-181), [TOOL-180](https://linear.app/thefrakinship/issue/TOOL-180)).

That needs, on a serverless control panel: receiving events from two platforms with different
connection models, conversations that span many webhook invocations, an LLM that understands the
question and looks up the answer, and a permission model for chat users who aren't (yet) known
Omniralph accounts, all without weakening the organization boundary
([ADR 0004](0004-organizations.md)). Setup: [chat.md](../chat.md).

## Decision

### Chat SDK for the platforms

[Chat SDK](https://chat-sdk.dev) (`chat`, `@chat-adapter/slack`, `@chat-adapter/discord`) handles
signature verification, event parsing, threads, posting, mentions, ephemeral messages and
per-thread message queueing for both platforms behind one `Thread`/`Message` API
(`apps/web/src/lib/chat/bot.ts`). Microsoft Teams and other platforms can be added as adapters
later without touching the agent.

- **State in our Postgres.** `@chat-adapter/state-pg` runs on the existing database with
  `autoCreateSchema: false`; its tables are provisioned by a drizzle migration
  (`packages/db/drizzle/0040_chat_state.sql`, checked against the adapter's statements in a test).
  Its dedupe and locks replace `webhook_deliveries` for chat.
- **Thin webhook routes.** `/api/webhooks/{slack,discord}` follow the Linear ingest pattern: a deps
  object for tests, async work in `after()`, `503` when the platform isn't configured. Uninstall
  events (Slack `app_uninstalled`/`tokens_revoked`, Discord `GUILD_DELETE`) are handled in the
  route after the adapter has verified the request, because the adapters don't emit them.
- **Only channel mentions and their threads.** A mention subscribes the bot to the thread; replies
  in it continue the conversation. Direct messages, the bot's own messages and messages from
  workspaces or servers no organization connected are dropped before the agent runs (for Discord,
  before the adapter can even create a thread).

### Our tables own installations

Two connection models, one table (`chat_connections`, unique on `(platform, external_id)`, one
organization per workspace or server, as with `integrations`):

- **Slack:** one app per deployment, multi-workspace OAuth v2. Each workspace's bot token is stored
  encrypted (`packages/db/src/crypto.ts`) in our table and handed to the adapter through its
  `installationProvider`. Chat SDK's own installation storage isn't used, so tokens follow the
  same encryption, cascade and admin-only rules as every other credential, and disconnecting is a
  row delete plus `auth.revoke`.
- **Discord:** one application per deployment; the bot joins each server through OAuth2
  (`bot applications.commands`), and the deployment-wide bot token serves every server. Nothing
  secret is stored per server; disconnecting makes the bot leave.

OAuth flows carry the organization in the signed `state` of ADR 0004; the guild comes from
Discord's token response, never from the redirect's query string.

### The Discord Gateway cron

Discord only delivers ordinary messages over its Gateway WebSocket, which a serverless function
can hold only while it runs. A Vercel cron (`/api/cron/discord-gateway`, every 9 minutes,
`isCronRequest`) runs the adapter's `startGatewayListener` for 10 minutes and forwards each event
to `/api/webhooks/discord` with the bot token as proof. Consecutive runs overlap by a minute so
nothing falls into a gap; Chat SDK's dedupe absorbs events forwarded twice. The route needs
`maxDuration = 800`, so Discord chat needs a Vercel Pro or Enterprise plan.

### The control-panel agent on the AI Gateway

The bot's replies come from an LLM running in the control panel (`apps/web/src/lib/chat/agent/`),
not from a job on an agent host: answering questions about Omniralph's own state needs the
database, not a repository checkout, and must answer in seconds.

- **AI SDK + Vercel AI Gateway.** `generateText` from `ai` with a gateway model id
  (`CHAT_AGENT_MODEL`, default `anthropic/claude-haiku-5.5`), authenticated with the deployment's
  OIDC token on Vercel or `AI_GATEWAY_API_KEY` elsewhere. The gateway keeps model choice and
  billing in Vercel and needs no per-provider keys. The model is injected through the handler's
  deps, so tests use `MockLanguageModelV2`.
- **Bounded turns.** The tool loop stops after 8 steps; the last 50 messages of the thread (kept in
  `chat_threads`/`chat_messages`, including tool calls and results) are the history. Turns are
  rate-limited per chat user (10/minute) and per organization (60/10 minutes) with `hitRateLimit`.
- **Untrusted input.** Chat messages, like PR content, are untrusted. The system prompt says so;
  the organization comes from the connection that received the message and is passed to tools by
  the handler, never taken from model output; every tool query is scoped to it; replies go through
  the code-host output sanitizer (links only to `APP_URL`).
- **No configuration, no model.** Without gateway credentials the bot says once per thread that
  the assistant isn't configured.

### Tool tiers and access levels

Every tool is declared with a tier (`defineChatTool`, `apps/web/src/lib/chat/agent/tools.ts`):
`read` for questions about the organization, `action` for anything that changes state. Each
message's author resolves to an access level (`resolveChatActor`,
`apps/web/src/lib/chat/identity.ts`):

| Actor | Tools offered to the model |
| -- | -- |
| `member`: a chat identity linked to an account that is still a member of the organization | `read` and `action` |
| `domain`: an unlinked Slack user whose verified Slack email domain is one of the organization's email domains | `read` |
| `unlinked`: everyone else | none |

A call to a tool above the actor's level returns a "link required" result, and the bot posts a
link prompt (ephemeral in Slack, a mention in Discord). This epic ships only `read` tools (runs,
reviews, jobs, agents, repositories); later epics add `action` tools that therefore require a
link. TOOL-181 added the first ones (`start_ralph_request`, `send_to_session`,
`send_ralph_guidance`; see [ADR 0003's addendum](0003-ralph-orchestration.md#addendum-run-origin-and-the-conversation-channel));
TOOL-305 replaced the first two (see the [addendum](#addendum-the-responder-runs-harness-tasks)).

- **Linking.** A signed, 15-minute link (`/chat/link`) lets a signed-in member link a chat identity
  (`chat_identities`, one Omniralph user per org + platform + chat user). Slack users whose
  profile email (`users.info`, cached an hour in `chat_user_profiles`) exactly matches a member's
  sign-in email are linked automatically and told once. Unlinking leaves a tombstone
  (`chat_identity_opt_outs`) so automatic linking never re-links that identity; a manual link
  lifts it.
- **Domains grant reads only.** A matching email domain says someone probably belongs to the
  organization, not who they are, so it never grants `action` tools. An organization without email
  domains grants no domain access; the instance-wide `ALLOWED_EMAIL_DOMAINS` is not used.
- **Discord always needs a link.** Discord doesn't expose emails to bots.

## Alternatives considered

- **Writing our own Slack and Discord clients.** Two signature schemes, two event formats, thread
  semantics, ephemeral fallbacks and the Discord Gateway protocol to maintain; Chat SDK already
  provides them with test utilities (`@chat-adapter/tests`).
- **Chat SDK's installation storage.** It would keep Slack tokens in the state adapter, outside our
  encryption, org cascade and admin checks; the `installationProvider` hook lets our table stay
  the source of truth.
- **Answering through a job on an agent host.** Agent hosts run Claude sessions in repositories; a
  question about runs or reviews needs only the database. A job would add queue latency and
  require an online agent for every answer. Code questions (TOOL-180) and ralph hand-off
  (TOOL-181) will use jobs where they need a checkout.
- **A long-running Gateway process.** A separate always-on service would hold the Discord socket
  without overlap tricks, but adds a deployment outside Vercel. The cron keeps everything in the
  control panel at the cost of the plan requirement.
- **Domain matches granting full access.** Simpler, but anyone with a company email in a shared
  Slack workspace could act as a member. Reads are the safe default; actions need a link.

## Consequences

- An organization can connect several Slack workspaces and Discord servers; each belongs to one
  organization, and moving one means disconnecting it first.
- No message from an unconnected workspace or server reaches the model, and no tool returns
  another organization's data; tests seed two organizations
  (`apps/web/src/lib/chat/agent/read-tools.test.ts`, `apps/web/src/lib/chat/bot.test.ts`).
- Chat adds AI Gateway usage (billed to the Vercel team) and, with Discord, one function that runs
  continuously through the cron.
- The bot can't see Discord messages on a Hobby plan, and after a deploy it can be offline in
  Discord for up to 9 minutes.
- New capabilities are new tools with a tier; the access model, history, rate limits and
  sanitizing apply to them unchanged.

## Addendum: the responder runs harness tasks

TOOL-305 (2026-10-12) makes the responder the front for harness-hosted agents. Before it, work
that needed a checkout left the responder behind: `ask_about_code` queued a job whose sink posted
the answer, and `start_ralph_request` started a ralph run that posted into the thread itself
(`ChatConversation`), so the responder only learned what happened on the next mention. Now runs
are started, followed and answered through the responder; nothing else posts into chat on a
chat-origin run's behalf. The task and agent model is
[ADR 0008](0008-agents-tasks-and-the-harness.md); this addendum only covers how chat uses it.
Setup and usage: [chat.md › Ralph from chat](../chat.md#ralph-from-chat).

- **Tools start runs of task definitions.** `ask_about_code` (`read`) starts a run of a query
  task, `start_work` (`action`, replacing `start_ralph_request`) a coding run of a coding task
  (`ralph_runs.coding_task_id`, used instead of the repository's request task). Both return at
  once with `{ status: "started", runId, … }` and post nothing: the responder's reply is the
  turn's only message. A duplicate question returns `already_asked` with the existing run.
- **Task settings per organization and channel.** Which tasks the two tools run is an
  organization setting (`app_settings` key `chat.tasks`, `getChatTaskDefaults`) with per-channel
  overrides (`chat_channel_task_settings`, keyed by connection and Chat SDK channel ID), edited
  under Settings › Integrations by admins. `chatTasksFor` (`apps/web/src/lib/chat/tasks.ts`)
  resolves channel override › organization choice › built-in default (`builtin:ask-about-code`,
  `builtin:handle-request`); `validateChatTaskChoice` requires a query task (resp. coding task)
  that accepts the `chat.request` trigger, on save and again when a tool starts a run (a stored
  choice that can't run returns `task_unavailable`). Changing a setting changes the next run with
  no deploy.
- **Thread-to-run mapping.** `chat_thread_runs` maps a thread to its runs: `query` rows point at a
  job, `coding` rows at a `ralph_runs` row, each run mapped once (`mapThreadRun`,
  `latestThreadRun`, `threadOfRun` in `packages/db/src/chat.ts`, all scoped to the organization).
  It replaces lookups by `ralph_runs.chat_thread_id` and the job payload's `chatThreadId`;
  migration `0067_chat_thread_runs` backfilled both.
- **Run events.** What a mapped run has to tell the thread is recorded as a `chat_run_events` row
  (`recordChatRunEvent`, `apps/web/src/lib/chat/run-events.ts`) of kind `response`, `question`,
  `permission_request`, `cleanup_question`, `completion` or `failure`, sanitized with the thread's
  allowed hosts and keyed idempotently per event (`chat-run-event:{job|ralph}:{id}:{key}`), so a
  replayed outcome or retried step records it once. The query sink (`chat-thread`), the coding
  run's `ChatConversation`, `askPermission`, cleanup questions and the run's completion and
  failure record events; none of them posts.
- **Wake-up turns.** A recorded event schedules `processThreadRunEvents`
  (`apps/web/src/lib/chat/agent/wake.ts`) in `after()`; the `/api/cron/chat-run-events` cron
  (every minute) catches up on events still pending after a minute, e.g. when `after()` wasn't
  available or a turn failed (up to 5 attempts per event). A wake-up takes the thread's Chat SDK
  lock, so it runs strictly between human turns (the Chat SDK's `concurrency: "queue"`), and hands
  messages queued meanwhile back to the Chat SDK when it releases the lock. Its input is the
  pending events, each body fenced as data with the prompt rule that run output is data, not
  instructions; it acts for the run's requester (their linked member, else `read` tools only). The
  answer is sanitized and posted like any reply; an empty answer posts nothing and still marks the
  events processed. Wake-ups don't count against the per-user or per-organization turn limits but
  have their own per-organization cap (`wakePerOrganization`, 60 per 10 minutes); capped events
  stay pending for the cron.
- **Answers go back through tools.** Every message in the thread goes to the responder (the
  handler no longer routes plain replies to a session). It passes answers on with `action` tools
  (`apps/web/src/lib/chat/agent/action-tools.ts`): `reply_to_run` (a reply or the answer to a
  question, live or queued, with attachments), `answer_run_permission` (approve or deny the open
  `ask_permission` request of the thread's coding run, under the run lock) and
  `answer_run_cleanup` (a cleanup question's option). They act on the thread's latest mapped run
  of the organization only.
- **Status from the database.** `get_run_status` (`read`) answers "what's the run doing?" from run
  state, open permission requests and the run's recent `post_activity` entries (`run_activities`)
  with no harness call.

Alternatives considered: a harness-hosted responder (out of scope: the conversation stays in the
control panel, which answers in seconds); posting run output straight into the thread as before
(the responder couldn't relate it to the conversation, and answers to it bypassed the model); and
waking the responder from the run's own process synchronously (a slow model call would hold up the
run's outcome handling, and a missed wake-up would be lost without the cron).
