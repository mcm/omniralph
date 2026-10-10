# Chat (Slack and Discord)

The chat front door lets people ask Omniralph about their organization from Slack or Discord.
Mention the bot in a channel of a connected workspace or server and it answers in a thread; reply
in that thread to continue the conversation. The answers come from the **control-panel agent**, an
LLM that runs in the control panel through the [Vercel AI SDK](https://ai-sdk.dev) and the
[Vercel AI Gateway](https://vercel.com/docs/ai-gateway) and reads the organization's ralph runs,
reviews, jobs, agents and repositories through tools. See
[ADR 0005](adr/0005-chat-front-door.md) for the design.

The control panel does all of it: it holds the Slack and Discord credentials, receives their
events, keeps each thread's history in Postgres and calls the model. Agent hosts are only involved
when the bot hands work off: [code questions](#code-questions) run as read-only `chat.ask` jobs and
[ralph requests](#ralph-from-chat) as ralph jobs; the control panel never reads code itself.

Setting chat up takes these steps (Slack and Discord are independent; set up either or both):

1. [Create the Slack app](#1-create-the-slack-app) and/or
   [the Discord application](#2-create-the-discord-application).
2. [Set up the AI Gateway](#3-set-up-the-ai-gateway).
3. [Set the env vars](#4-set-the-env-vars) and redeploy.
4. [Connect a workspace or server](#5-connect-from-settings--integrations) from **Settings ›
   Integrations**.
5. [Ask a question](#6-ask-a-question), and [link your account](#account-linking).

## 1. Create the Slack app

One Slack app serves the whole deployment; each organization installs it into its own workspace.
A preview deployment that should receive Slack events needs its own app.

1. Open [api.slack.com/apps](https://api.slack.com/apps) › **Create New App** › **From a
   manifest**, pick a workspace you develop in (this only decides who owns the app) and paste
   [slack-app-manifest.yaml](slack-app-manifest.yaml) after replacing every
   `https://omniralph.example.com` with the control panel's `APP_URL`. The manifest sets:
   - the redirect URL `<APP_URL>/api/integrations/slack/callback`;
   - the event request URL `<APP_URL>/api/webhooks/slack` with the `app_mention`,
     `message.channels`, `message.groups`, `app_uninstalled` and `tokens_revoked` events;
   - interactivity on the same request URL, for buttons on the bot's cards (e.g. **Create** /
     **Cancel** on a Linear issue draft). An app created from an older manifest needs it turned on
     under **Interactivity & Shortcuts**;
   - the bot scopes (`app_mentions:read`, `channels:history`, `channels:read`, `chat:write`,
     `files:read`, `groups:history`, `groups:read`, `reactions:read`, `reactions:write`,
     `users:read`, `users:read.email`). `users:read.email` is what lets Omniralph
     [recognize people by email](#automatic-linking-by-slack-email), and `files:read` lets the bot
     [see attached files](#attachments). An app created from an older manifest needs `files:read`
     added, and each workspace must reconnect to grant it.
2. Under **Basic Information › App Credentials**, copy the **Client ID**, **Client Secret** and
   **Signing Secret** into `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and `SLACK_SIGNING_SECRET`.
3. **Turn on distribution** so workspaces other than the app's own can install it: **Manage
   Distribution** › check the items under **Share Your App with Other Workspaces** (remove
   hard-coded information, use HTTPS redirect URLs) › **Activate Public Distribution**. This doesn't
   list the app in the Slack Marketplace; it only allows OAuth installs from other workspaces.
   Without it, only the workspace that owns the app can connect.
   If Slack asks for a privacy policy URL (as the Slack Marketplace does), use `<APP_URL>/privacy`.

Slack verifies the event request URL when you save it. If the control panel isn't deployed with
the signing secret yet, Slack reports the URL as failing; set the env vars, redeploy and click
**Retry** under **Event Subscriptions**.

The manifest allows org-wide installs on Enterprise Grid (`org_deploy_enabled`): an org-wide
install is connected as the enterprise and covers its workspaces.

## 2. Create the Discord application

One Discord application serves the whole deployment; each organization adds its bot to its own
server, and the same bot token is used for every server.

1. In the [Discord Developer Portal](https://discord.com/developers/applications), **New
   Application**, named `Omniralph`.
2. **General Information**: copy the **Application ID** (`DISCORD_APPLICATION_ID`) and the
   **Public Key** (`DISCORD_PUBLIC_KEY`). Set the **Interactions Endpoint URL** to
   `<APP_URL>/api/webhooks/discord` (Discord checks it when you save, so do this after deploying
   with the env vars). Set the **Terms of Service URL** to `<APP_URL>/terms` and the **Privacy
   Policy URL** to `<APP_URL>/privacy`.
3. **OAuth2**: copy the **Client Secret** (`DISCORD_CLIENT_SECRET`) and add the redirect
   `<APP_URL>/api/integrations/discord/callback` under **Redirects**.
4. **Bot**: **Reset Token** and copy it (`DISCORD_BOT_TOKEN`). Keep **Public Bot** on so admins of
   other servers can add it. Under **Privileged Gateway Intents**, turn on **Message Content
   Intent**: without it the bot receives messages with empty text and can't follow a thread.
   (Applications in more than 100 servers need Discord's approval for this intent.)

**Connect Discord** requests the scopes `bot applications.commands` and these bot permissions:
View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Read Message History
and Add Reactions. You don't set them in the portal.

### The Discord Gateway cron

Mentions and replies in Discord don't arrive as webhooks: Discord only sends ordinary messages
over the Gateway WebSocket. The control panel keeps a Gateway connection open with a cron,
`/api/cron/discord-gateway` (declared in `apps/web/vercel.json`): every 9 minutes it starts a
listener that stays connected for 10 minutes and forwards each event to
`/api/webhooks/discord`. Runs overlap by a minute so no message falls into a gap; events that
both listeners forward are deduplicated.

- **It needs a Vercel Pro (or Enterprise) plan.** The route runs for up to 800 seconds
  (`maxDuration`), which Hobby doesn't allow, and Hobby cron jobs run at most once a day. With
  Hobby, Discord can be connected but the bot won't see messages.
- Like every cron, it only runs on the production deployment and authenticates with
  `CRON_SECRET` ([deploy-control-panel.md](deploy-control-panel.md#7-vercel-cron-cron_secret)).
  Without the Discord env vars it does nothing.
- Each run keeps a function instance busy for its whole duration, so Discord adds roughly one
  always-running function to the deployment's usage.
- After a deploy, the bot can take up to 9 minutes to come back online in Discord.

## 3. Set up the AI Gateway

The control-panel agent calls a model through the Vercel AI Gateway. On Vercel, the gateway
authenticates with the deployment's OIDC token: enable the AI Gateway for the team (Vercel
dashboard › **AI Gateway**) and nothing else is needed. Elsewhere (for example `pnpm dev`), create
a key under **AI Gateway › API keys** and set `AI_GATEWAY_API_KEY`.

The model is `anthropic/claude-haiku-5.5` unless `CHAT_AGENT_MODEL` names another AI Gateway
model id. Usage is billed to the Vercel team through the AI Gateway.

Without gateway credentials, Slack and Discord still connect, but the bot answers each thread once
that the assistant isn't configured on this deployment.

## 4. Set the env vars

On the Vercel project (per environment; [env.md](env.md#slack-chat)), then redeploy:

| Variable                 | Value                                                                    |
| ------------------------ | ------------------------------------------------------------------------ |
| `SLACK_CLIENT_ID`        | The Slack app's client ID                                                |
| `SLACK_CLIENT_SECRET`    | The Slack app's client secret                                            |
| `SLACK_SIGNING_SECRET`   | The Slack app's signing secret                                           |
| `DISCORD_APPLICATION_ID` | The Discord application ID                                               |
| `DISCORD_CLIENT_SECRET`  | The Discord OAuth2 client secret                                         |
| `DISCORD_BOT_TOKEN`      | The Discord bot token                                                    |
| `DISCORD_PUBLIC_KEY`     | The Discord application's public key                                     |
| `AI_GATEWAY_API_KEY`     | Only off Vercel: an AI Gateway API key                                   |
| `CHAT_AGENT_MODEL`       | Optional: the AI Gateway model id (default `anthropic/claude-haiku-5.5`) |

Each platform needs all of its variables. With any missing, its card under **Settings ›
Integrations** shows a "not configured" notice with a disabled **Connect** button, and its webhook
route answers `503`. Slack bot tokens are stored encrypted with `ENCRYPTION_KEY`, like the other
integration credentials.

## 5. Connect from Settings › Integrations

As an admin of the Omniralph organization, open **Settings › Integrations**:

- **Connect Slack** opens Slack's consent screen for the workspace you're signed in to; approve it
  and you return to the Integrations page, which lists the workspace and who installed it. Use
  **Connect another workspace** for more.
- **Connect Discord** opens Discord's bot authorization; pick the server (you need **Manage
  Server** there) and authorize. The server is listed the same way; use **Connect another
  server** for more.

Finish within 10 minutes of clicking and in the same browser. A workspace or server belongs to
one organization: connecting one that another organization has is refused; disconnect it there
first. An organization can connect several workspaces and servers.

**Disconnect** removes the connection: Omniralph revokes the workspace's Slack bot token or makes
the bot leave the Discord server. Uninstalling the app in Slack, or
removing the bot from the server in Discord, disconnects it too. Messages from workspaces and
servers that aren't connected are ignored and never reach the model.

## 6. Ask a question

Invite the bot to a channel (`/invite @Omniralph` in Slack; in Discord, give it access to the
channel) and mention it:

> @Omniralph what ralph runs are active?

The bot answers in a thread (in Discord it creates one), and everything it posts stays in that
thread. Replies in the thread continue the same conversation without mentioning the bot again; the
last 50 messages are kept as context. Direct messages to the bot are ignored.

It can answer questions about the organization's ralph runs (status, stories, PRs/MRs, progress),
reviews and their findings, jobs, agents and repositories, with links to the control panel's
pages. It can [answer questions about a repository's code](#code-questions) by handing them to an
agent. Linked members can also [hand work to ralph](#ralph-from-chat), steer runs, and
[file Linear issues](#linear-issues-from-chat) (and delegate them to ralph).

You can attach screenshots and text files (e.g. a log) to your messages: the bot sees them
([Attachments](#attachments)).

Turns are rate-limited to 10 per minute per chat user and 60 per 10 minutes per organization; the
bot says so once when a limit is reached.

## Ralph from chat

Linked members can ask the bot to change code: it hands the request to a ralph session in a
repository, and the session works in the same thread. The run is a request-mode run, like an
[@mention in Linear](linear.md#mentions-request-mode), but it belongs to the chat thread instead
of a Linear issue; it shows up under **Ralph runs** with the platform and channel it came from.
The organization doesn't need Linear for it.

### Starting a request

> @Omniralph fix the typo in the README of acme/website

The control-panel agent works out the repository from the conversation (asking first when it's
ambiguous) and hands the request off with its `start_ralph_request` tool:

- The repository must be one of the organization's repositories with ralph enabled (see
  [linear.md › Configure routing](linear.md#4-configure-routing); Linear routing itself isn't
  used); otherwise the bot lists the ones it can use. The session runs on an agent with the
  `ralph` capability ([deploy-agent.md](deploy-agent.md#ralph)) and waits in the queue until one
  is online.
- The bot posts **"Handing this to ralph in `owner/repo`…"** with the request's first sentence
  and a link to the run's page. The session gets the agent's summary of the request plus the
  quoted chat messages it's based on.
- The session works on a new branch `omniralph/chat-<id>` from the default branch, with the
  repository's quality gates, and asks the control panel to open a PR/MR (a draft until it's
  ready; its description says it was requested in chat). A later request in the same thread for
  the same repository continues that branch and PR/MR.
- One run per thread at a time: while the thread's run is active, new requests go to it as
  [replies](#replies-while-a-session-runs) instead.

While it works, the session keeps **one status message** up to date (`⏳ Working on it`, the
current step and its last action) instead of posting every thought. Its answers, questions and
errors (`⚠️ …`) arrive as new messages, and the PR/MR link is posted once. Questions with options
(as in Linear's pickers) are answered by replying with the option's text. When the request is done,
the control-panel agent takes the thread back.

### Replies while a session runs

While the thread's run has a queued or running `ralph.request` job:

| Reply                                 | Goes to                                                                                                                                                                                                   |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A plain reply (no mention of the bot) | The session, like a reply in a Linear agent session: passed live within one heartbeat (about 20s) when it's running, otherwise queued as the next request. The bot reacts with 👀 and posts nothing else. |
| A reply that @mentions the bot        | The control-panel agent, which can answer questions or forward guidance with its `send_to_session` tool.                                                                                                  |

Files attached to a plain reply go to the session with it: each is listed by name and type, a
text file's content follows (fenced as user data, up to 20,000 characters, within the
[attachment limits](#attachments)), and the session is told it can't see images, so it asks in
the thread what a screenshot shows if that matters. A reply with only attachments is passed on as
well.

Plain replies from someone who isn't a linked member aren't passed on; they get the link prompt.
When no session is working, every reply goes to the control-panel agent as usual, and asking it
for more work in the same repository starts the next request on the same branch.

### Checking on and steering other runs

Ask about any run of the organization by its run ID or its Linear identifier ("how is ENG-42
doing?"): the agent reports its status, current story, pending guidance and last activity
(`get_ralph_run`). A linked member can send it guidance ("tell ENG-42 to skip the migration"):
`send_ralph_guidance` adds it as guidance and a pending request, exactly like a reply in the run's
own session, authored as `<name> (from chat)`; a Linear run's session shows a "Guidance from
<name> (from chat)" note. A finished run can't take guidance, and runs can't be stopped from chat.
The detailed progress of Linear runs stays in Linear.

### PR/MR follow-ups

A chat run's PRs/MRs are looked after like
[those of Linear runs](linear.md#reviews-and-bot-requests-on-ralph-prsmrs): Omniralph's review
findings, `@omniralph fix` requests and failed CI become requests on the run (within the same
capped rounds), and the worktree is cleaned up after the merge. Their news ("CI failed on the pull
request… Working on a fix.", round limits, the cleanup report) is posted to the thread as new
messages. `@omniralph fix` on the PR/MR replies with a pointer to the chat thread instead of a
Linear issue. A cleanup question (what to do with a stash or a kept branch) is answered with a
plain reply in the thread, by a linked member.

### What needs a linked account

Starting a request, plain replies to a running session, guidance with `send_to_session` or
`send_ralph_guidance` and answers to cleanup questions are `action`s: only
[linked members](#access-levels) can do them, as can drafting, creating and delegating
[Linear issues](#linear-issues-from-chat). Slack users admitted by email domain can ask about runs
and [ask code questions](#code-questions) but not change anything; everyone else gets the link
prompt.

## Linear issues from chat

Linked members can turn a conversation into a Linear issue, and have ralph build it. The
organization needs a connected Linear workspace ([linear.md](linear.md#3-connect-from-settings--integrations));
without one the bot says an admin can connect it under **Settings › Integrations**.

### Filing an issue

> @Omniralph file an issue in ENG for the login timeout we just discussed

The control-panel agent drafts the issue from the thread with its `draft_linear_issue` tool: a
title, a self-contained Markdown description (Linear readers don't see the thread), the team and,
if asked, a project, labels and a priority. The team is matched by key, name or id; if it's
unknown (or the workspace has several and you didn't say), the bot asks which one.

Nothing is created yet. The bot posts a **confirmation card** with the draft (team, project,
labels, priority, title and a preview of the description) and three buttons:

| Button                  | Does                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| **Create**              | Creates the issue in Linear. The card then shows its identifier and an **Open ENG-123** link. |
| **Create and delegate** | Creates the issue and [delegates it to ralph](#delegating-to-ralph).                          |
| **Cancel**              | Discards the draft; the card says so.                                                         |

- Only the member who asked can click them; anyone else gets a private note to mention the bot
  and draft their own.
- The draft is kept for **24 hours**; after that the card says it expired. Ask again for a new one.
- A click creates the issue once, even when it's clicked twice or by two devices. If Linear
  fails, the draft stays open and you can click again.
- In Slack, the buttons need **interactivity** on the app (see
  [step 1](#1-create-the-slack-app)); an app created from an older manifest must turn it on.
- Screenshots attached in the thread can go into the issue: when they're relevant, the agent
  passes them to `draft_linear_issue` and the card lists them under **Screenshots**. On **Create**
  they're fetched from the chat platform again, uploaded to Linear and embedded at the end of the
  description (`## Screenshots`). One that can't be fetched anymore is left out, and the card says
  so.

### Delegating to ralph

> @Omniralph file an issue for X and have ralph build it

For a new issue, click **Create and delegate** on the card. For an existing one, ask the bot to
delegate it by identifier ("have ralph build ENG-42"): its `delegate_linear_issue` tool sets the
issue's delegate to the Omniralph app. Either way it's the same as delegating in Linear: Linear
starts an agent session and ralph builds the issue as described in
[linear.md › Delegate an issue](linear.md#5-delegate-an-issue) (the issue's team must be routed to
a repository with ralph enabled).

The run stays a Linear run: its progress, questions and replies are in the Linear issue's agent
session, not in chat. The thread gets the issue's link, and one message each when:

- the run starts (`🚀 Ralph started building ENG-42…`);
- it opens its pull/merge request (with the link);
- it finishes, or fails (`⚠️ Ralph stopped working on ENG-42: …`).

These updates are tied to the thread when the delegation comes from chat and the run starts within
an hour. If Linear refuses the delegation after creating the issue, the issue is kept and the bot
says so; ask it to delegate again, or delegate the issue in Linear.

## Code questions

Ask about a connected repository's code and the bot gets an answer from an agent with a checkout
of it:

> @Omniralph in acme/api, where do we validate webhook signatures?

- The control-panel agent can't read code itself (and never answers from memory). It hands the
  question, made self-contained, to its `ask_about_code` tool. The repository must be one of the
  organization's connected repositories (ralph doesn't need to be enabled); if it's ambiguous the
  bot asks which one first.
- The bot posts **"Looking into `owner/repo`…"**, and the answer follows in the thread as a new
  message, with links to the files it cites. Asking the same question again while it runs doesn't
  queue it twice.
- The question is answered from the repository's **default branch** (other branches aren't
  supported). The agent sees the question, the latest messages of the thread and the thread's
  previous code question and answer, so follow-ups work.
- Attached text files (e.g. a pasted log) can go with the question: the agent passes them to
  `ask_about_code`, and their text (up to 3,000 characters each) is quoted in the question's
  context. The code agent can't see images, so for a screenshot it gets the file name and the
  question describes what the screenshot shows.
- It's usually as quick as a quick review. An answer that runs out of budget says so; try a
  narrower question.

### The read-only sandbox

A code question is a `chat.ask` job under the agent's `review` capability, published on the same
topic as reviews and run in the same sandbox:

- A fresh worktree of the default branch's head, on an agent host
  ([deploy-agent.md](deploy-agent.md)). The control panel never reads code.
- The Claude session gets only **Read, Grep and Glob**, limited to the worktree: it can't write
  files, run commands or push. No project settings are loaded; the branch's `CLAUDE.md` is passed
  as quoted data, as in reviews.
- Up to 30 turns and a token budget of 25% of the repository's review profile's **max tokens per
  review**, with the profile's model.
- If the repository pins reviews to specific agents, only those agents take it.

### Agent version

`chat.ask` needs the `review` capability on **agent version 0.7.0 or later**. Older agents don't
know the job type. Before queueing, the control panel checks the organization's online agents (the
version and capabilities they report in heartbeats); when none that would take the job can run it,
nothing is queued and the bot says so: "no agent … is online", or that the online ones need the
review capability on 0.7.0 or later. Update or start an agent ([deploy-agent.md](deploy-agent.md))
and ask again.

## Attachments

Images and text files attached to messages in the thread reach the model:

- **Images**: PNG, JPEG, GIF and WebP, up to 5 MB each.
- **Text files**: `text/*`, JSON, XML, YAML, TOML and similar (or a `.log`, `.txt`, `.md`, `.csv`…
  file without a useful type), UTF-8, up to 256 KB each.
- At most 5 attachments per message are read. Anything else (video, audio, PDFs, archives, other
  binaries), a file over its cap or one that can't be fetched is skipped, and the model is told
  (`[attachment skipped: demo.mov — unsupported type (video/quicktime)]`), so it can say so. The
  turn goes on either way.
- Omniralph stores only each attachment's metadata (name, type, size, the platform's URL) with the
  message, never the file. Each turn fetches the files again from Slack or Discord: the latest 10
  attachments of the thread are shown to the model; older ones are listed by name, and tools can
  still use them.
- Attachment content is treated as untrusted user data, like the messages: the model uses it as
  information and doesn't follow instructions in it. Text files are passed inside an
  untrusted-content fence.
- In Slack, downloading files needs the bot's `files:read` scope ([step 1](#1-create-the-slack-app)).
  A workspace connected before the scope was added must reconnect under **Settings ›
  Integrations**; until then its files are skipped as "couldn't be fetched". Discord's attachment
  links expire after about a day, so an old screenshot may no longer be fetchable.
- Screenshots can be [embedded in Linear issues](#filing-an-issue) and attached files included in
  [code questions](#code-questions).

## Access levels

Who may ask what depends on whether Omniralph knows who's asking. Each tool the agent uses has a
tier: `read` (questions about the organization, including [code questions](#code-questions)) or
`action` (changing something: starting, steering and replying to [ralph runs](#ralph-from-chat),
and [filing and delegating Linear issues](#linear-issues-from-chat)).

| Who                                                                                                                                                                             | Gets                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Linked member**: a chat user [linked](#account-linking) to an Omniralph account that is a member of the organization owning the connection                                    | `read` and `action` tools                                                   |
| **Slack user on the organization's email domains**: not linked, but their Slack profile email's domain is one of the organization's email domains (**Settings › Organization**) | `read` tools only                                                           |
| **Everyone else**                                                                                                                                                               | No tools; the bot answers without organization data and posts a link prompt |

- An organization without email domains grants no domain-based access, and the deployment-wide
  `ALLOWED_EMAIL_DOMAINS` is never used for chat.
- **Discord never exposes emails to bots**, so Discord users always need an explicit link,
  whatever their email.
- When someone without access asks for something that needs it, the bot replies with a link
  prompt: privately in Slack (an ephemeral message only they see), by direct message in Discord
  (with a "check your DMs" note in the thread). If Discord refuses the DM (the user blocks DMs
  from server members), the prompt is posted in the thread as a mention and a warning is logged.
- The organization always comes from the workspace or server the message arrived in, never from
  the message itself, and every tool only reads that organization's data. Messages are treated as
  untrusted input, and everything the bot posts goes through the same output sanitizer as review
  comments.

## Account linking

A chat identity (a Slack or Discord user in one organization) can be linked to one Omniralph
member.

- **Linking by hand.** The link prompt contains a link to `<APP_URL>/chat/link` that works for 15
  minutes and only once: after it was used, opening it again says so. Open it, sign in if needed, and confirm **Link** on "Link <platform> user <name> to your
  account in <organization>?". You must be a member of the organization, and the workspace or
  server must still be connected to it. Linking an identity that another account had replaces
  that link.
- **Linked identities** are listed under **Settings › Chat accounts**, across all your
  organizations, each with **Unlink**.

### Automatic linking by Slack email

When a Slack user's profile email exactly matches the sign-in email of a member of the
organization (case-insensitive), Omniralph links them automatically the first time they talk to
the bot, and tells them once, privately, which email it matched and where to unlink. Slack
profiles are read with `users.info` and cached for an hour, so email changes in Slack take up to
an hour to show. Bots, deactivated users and profiles without an email aren't linked.

**To opt out**, unlink the identity under **Settings › Chat accounts**. Omniralph remembers that
you unlinked it and never links that Slack user automatically again; linking by hand later lifts
the opt-out. Leaving the organization ends the link's access straight away.

## Troubleshooting

| Symptom                                             | Check                                                                                                                                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Connect** is disabled                             | The platform's env vars are all set for this environment, and the deployment was redeployed after setting them.                                                                                              |
| Slack install fails for other workspaces            | Public distribution is activated (step 1.3).                                                                                                                                                                 |
| The bot doesn't react to a Slack mention            | The bot is in the channel; the event request URL is verified under **Event Subscriptions**; the workspace is listed under **Settings › Integrations**.                                                       |
| The bot doesn't react to a Discord mention          | The Vercel plan is Pro or Enterprise; the `/api/cron/discord-gateway` cron is running (Vercel › **Cron Jobs**) and `CRON_SECRET` is set; the **Message Content Intent** is on; the bot can view the channel. |
| "The Omniralph assistant isn't configured"          | The AI Gateway is enabled for the Vercel team, or `AI_GATEWAY_API_KEY` is set off Vercel.                                                                                                                    |
| The bot asks to link although you're a member       | On Discord, always link by hand. On Slack, your Slack email isn't your Omniralph sign-in email (and its domain isn't one of the organization's), or you unlinked before: link by hand.                       |
| A reply didn't reach the ralph session              | It must not mention the bot (a mention goes to the control-panel agent), you must be a linked member, and the session must still be working: once its request is done, replies go to the agent.              |
| The bot won't start a ralph request                 | You're a linked member; the repository has ralph enabled and is written as `owner/repo`; the thread has no active run (reply to it instead).                                                                 |
| The Linear card's buttons do nothing (Slack)        | **Interactivity** is on under **Interactivity & Shortcuts** with the request URL `<APP_URL>/api/webhooks/slack`.                                                                                             |
| "Only the person who asked…" on a card              | Only the member who asked for the draft can click it; mention the bot to draft your own.                                                                                                                     |
| A code question says no capable agent is online     | An agent with the `review` capability on version 0.7.0 or later is online (and, if the repository pins reviews to agents, it's one of them).                                                                 |
| The bot says it couldn't fetch a Slack attachment   | The app has the `files:read` scope and the workspace reconnected after it was added.                                                                                                                         |
| A delegated issue's thread got no "started" message | The issue's team is routed to a repository with ralph enabled and an agent with `ralph` is online; the run must start within an hour of the delegation.                                                      |
