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
link.

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
