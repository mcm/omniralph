# Chat (Slack, Discord and the web)

The chat front door lets people ask Omniralph about their organization from Slack or Discord, and
from the control panel itself ([Ask](#web-ask)).
Mention the bot in a channel of a connected workspace or server and it answers in a thread; reply
in that thread to continue the conversation. The answers come from **Om**, Omniralph's AI, an
LLM that runs in the control panel through the [Vercel AI SDK](https://ai-sdk.dev) and the
[Vercel AI Gateway](https://vercel.com/docs/ai-gateway) and reads the organization's coding runs,
reviews, jobs, agents and repositories through tools. See
[ADR 0005](adr/0005-chat-front-door.md) for the design.

The control panel does all of it: it holds the Slack and Discord credentials, receives their
events, keeps each thread's history in Postgres and calls the model. Agent hosts are only involved
when the bot starts a run: [code questions](#code-questions) run the channel's "ask about code"
playbook and [work requests](#om-from-chat) its "start work" playbook
([chat playbooks](#chat-playbooks)); the control panel never reads code itself. The bot stays in the
conversation while they run: their answers, questions and approval requests come back to it, and
it posts them in the thread.

Setting chat up takes these steps (Slack and Discord are independent; set up either or both):

1. [Create the Slack app](#1-create-the-slack-app) and/or
   [the Discord application](#2-create-the-discord-application).
2. [Set up the AI Gateway](#3-set-up-the-ai-gateway).
3. [Set the env vars](#4-set-the-env-vars) and redeploy.
4. [Connect a workspace or server](#5-connect-from-settings--connections) from **Settings ›
   Connections › Add connection**.
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

### Ordinary Discord messages aren't received yet

Discord only sends ordinary messages (mentions and thread replies) over its Gateway WebSocket,
not as webhooks. The control panel doesn't hold a Gateway connection at the moment: the earlier
cron-based listener didn't work and was removed until it's redesigned. Until then, the bot only
receives what Discord posts to the Interactions Endpoint URL (`/api/webhooks/discord`).

## 3. Set up the AI Gateway

Om calls a model through the Vercel AI Gateway. On Vercel, the gateway
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

Each platform needs all of its variables. With any missing, its **Connect** under **Settings ›
Connections › Add connection** returns to that page with a "Slack app not configured" (or
Discord) notice, and its webhook route answers `503`. Slack bot tokens are stored encrypted with `ENCRYPTION_KEY`, like the other
integration credentials.

## 5. Connect from Settings › Connections

As an admin of the Omniralph organization, open **Settings › Connections › Add connection**:

- **Slack › Connect** opens Slack's consent screen for the workspace you're signed in to; approve
  it and you land on the new connection's page (**Settings › Connections › Slack**), which shows
  the workspace and its linked accounts. Use **Add connection › Slack › Connect** again for more.
- **Discord › Connect** opens Discord's bot authorization; pick the server (you need **Manage
  Server** there) and authorize. The server gets its own page the same way; connect again for
  more.

Finish within 10 minutes of clicking and in the same browser. A workspace or server belongs to
one organization: connecting one that another organization has is refused; disconnect it there
first. An organization can connect several workspaces and servers.

**Disconnect…** in the connection page's **⋯** menu removes the connection: Omniralph revokes the workspace's Slack bot token or makes
the bot leave the Discord server. **⋯ › Edit connection** runs the connect flow again
(reconnecting the workspace, e.g. to grant a new scope). Uninstalling the app in Slack, or
removing the bot from the server in Discord, disconnects it too. Messages from workspaces and
servers that aren't connected are ignored and never reach the model.

### Chat playbooks

Chat is a trigger: each message the bot acts on runs a [playbook](definitions.md). Unless an
admin chooses others, it runs the built-ins:

- **Ask about code** (`ask`): the `chat-ask` playbook a [code question](#code-questions) runs.
  Default: `builtin:ask-about-code`.
- **Start work** (`startWork`): the `request` playbook a [work request](#om-from-chat) runs.
  Default: `builtin:handle-request`.

An admin can choose other playbooks of the same role, built-in or the organization's own
([custom playbooks](definitions.md)), for the whole organization or for one channel, in **Settings ›
Advanced › Chat channel overrides** (`/settings/advanced/chat`): the **Organization default** card
("Answer questions with", "Start work with") and the **Channel overrides** card (Add override: the
connection, the channel and each playbook or "Organization default"). Every member sees them;
only admins change them. The Advanced group shows in the Settings nav for users who turn on **Show
advanced settings**, but the page and the setting work the same whether or not anyone shows it.
The same through the API:

| Request                                                      | Body                                                       | What it does                                                                                                                                                             |
| ------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/ui/integrations/chat-tasks`                        |                                                            | Any member: the organization's choice (`defaults`), the built-in defaults, the playbooks each can run (`choices`) and each connection's channel overrides.               |
| `PUT /api/ui/integrations/chat-tasks`                        | `{ "ask": "<playbook ID>", "startWork": "<playbook ID>" }` | Sets the organization's choice (`chat.playbooks` in `app_settings`).                                                                                                     |
| `PUT /api/ui/integrations/chat-connections/{id}/channels`    | `{ "channel": "C0123ABCD", "ask": …, "startWork": … }`     | Sets a channel's overrides (`chat_channel_task_settings`) and answers the saved override. `null` keeps the organization's choice for that one; at least one must be set. |
| `DELETE /api/ui/integrations/chat-connections/{id}/channels` | `{ "channelId": "slack:C0123ABCD" }`                       | Removes a channel's overrides: it runs the organization's choice again.                                                                                                  |

`channel` is the ID the platform shows (Slack: `C0123ABCD`, from the channel's details; Discord:
the channel's numeric ID, with Developer Mode on), or the channel's name (`#general`), which is
looked up in the Slack workspace (channels the app can see) or the Discord server. Each chosen
playbook must have its slot's role (`chat-ask` for `ask`, `request` for `startWork`); anything else
is refused with a field error, and nothing is saved. Every save publishes a live change event
(`settings`, section `chat_playbooks`), so open pages update.

A channel runs its override where it has one, else the organization's choice, else the built-in.
Changes apply to the next question or request, with no deploy; runs already started keep their
playbook. If a chosen playbook can no longer run (e.g. it was deleted), the bot says an admin
needs to choose another one and starts nothing.

## 6. Ask a question

Invite the bot to a channel (`/invite @Omniralph` in Slack; in Discord, give it access to the
channel) and mention it:

> @Omniralph what coding runs are active?

The bot answers in a thread (in Discord it creates one), and everything it posts stays in that
thread. Replies in the thread continue the same conversation without mentioning the bot again; the
last 50 messages are kept as context. Direct messages to the bot are ignored.

It can answer questions about the organization's coding runs (status, stories, PRs/MRs, progress),
reviews and their findings, jobs, agents and repositories, with links to the control panel's
pages. It can [answer questions about a repository's code](#code-questions) by handing them to an
agent. Linked members can also [hand work to Om](#om-from-chat), steer runs, and
[file Linear issues](#linear-issues-from-chat) (and delegate them to Om).

You can attach screenshots and text files (e.g. a log) to your messages: the bot sees them
([Attachments](#attachments)).

Turns are rate-limited to 10 per minute per chat user and 60 per 10 minutes per organization; the
bot says so once when a limit is reached.

## Web (Ask)

**Ask** is a chat with Om in the control panel, about one repo or all of the organization's repos.
It needs no setup beyond [the AI Gateway](#3-set-up-the-ai-gateway): no app to create, no env var
and nothing to connect. Every organization gets a hidden `web` chat connection the first time one
of its members starts a chat; it is never listed under **Settings › Connections**.

- **The same Om.** A web chat is a Chat SDK thread like a Slack or Discord one: its adapter
  (`apps/web/src/lib/chat/web-adapter.ts`) stores messages in Omniralph's own database. Om answers
  it with the same agent, tools, [access levels](#access-levels) and rate limits (per member and per
  organization), and code questions and work requests start the same runs, whose answers and
  questions come back to the chat as run events. The member is always signed in, so they are a
  linked member with their organization role; nobody needs to [link an account](#account-linking).
- **Private.** A web chat belongs to the member who started it: nobody else in the organization
  sees it or writes in it, and it's gone from their view when they leave the organization. The runs
  it starts appear in **Runs** like any other.
- **Streamed and live.** Om's reply streams into the chat as it is written, with a short line
  saying what Om is doing while it uses a tool ("Looking at runs", "Asking an agent to read
  customer-portal"); when the reply is done, it is replaced by its final, sanitized text. The
  stream is the response of the request that sent the message (server-sent events), and the turn
  finishes even if the page closes. Slack and Discord still get the finished reply. Answers that arrive
  later (a code question an agent read the repo for, a run's news) and card changes reach every
  open view of the chat through live updates, without a refresh; change events name the chat only,
  on the member's own channel.
- **Code answers as written.** A [code question](#code-questions) asked in a web chat runs on the
  chat's repo (unless Om names another) and the branch the chat stored when it started. Its answer
  is posted exactly as the agent wrote it, without a model turn in between, and shows how long the
  agent took, how many files it read, the files it cites (linked on the code host at that branch)
  and the work items it mentions that the organization's tracker knows (linked to their newest
  run, else to the tracker). While the question runs, the chat says that Om is reading the repo,
  with a live count of the files read. A failed question, one that ran out of budget, and a coding
  run's news still go through Om, as on Slack and Discord.
- **Fixed repo and branch.** A new chat offers the organization's connected repos with Ask on,
  or all of its repos. The chat's title is its first message (at most 60 characters), its repo
  can't change once it starts, and its branch is the repo's default branch when it started (the
  last one stored, when the code host can't be reached).
- **Back from Runs.** A code question shows in Runs as an Ask run titled with the question (one
  line, at most 120 characters). Its run detail, and that of a run started from a chat, names the
  chat it came from (`chat` in `GET /api/ui/runs/{id}`); for the member who started a web chat, the
  run's ⋯ menu has **Open chat**, back to it. Other members, and Slack and Discord threads, get no
  link.

The control panel's API for it lives under `/api/ui/ask` (`apps/web/src/lib/api/ask.ts`): the
member's chats (`GET /chats`, newest activity first), a new chat with its first message
(`POST /chats`), a chat with its messages, cards and in-flight question (`GET /chats/{id}`), a
follow-up (`POST /chats/{id}/messages`), a click on a card's button (`POST /chats/{id}/actions`,
handled as the same click on Slack is) and the repos a new chat can pick (`GET /repositories`).
Sending answers with the turn's server-sent events (`apps/web/src/lib/ask/sse.ts`).

## Om from chat

Linked members can ask the bot to change code: it starts a coding run of the channel's **Start
work** [chat playbook](#chat-playbooks) in a repository, and stays the thread's voice while it works. The
run is a request-mode run, like an [@mention in Linear](linear.md#mentions-request-mode), but it
belongs to the chat thread instead of a Linear issue; it shows up under **Coding tasks** with the
platform and channel it came from. The organization doesn't need Linear for it.

### Starting a request

> @Omniralph fix the typo in the README of acme/website

Om works out the repository from the conversation (asking first when it's
ambiguous) and starts the run with its `start_work` tool:

- The repository must be one of the organization's repositories with coding on (see
  [linear.md › Configure routing](linear.md#4-configure-routing); Linear routing itself isn't
  used); otherwise the bot lists the ones it can use. The session runs on an agent that accepts
  the `coding` task type ([deploy-agent.md](deploy-agent.md#coding-work)) and waits in the queue until
  one is online.
- The tool returns the run's ID at once and posts nothing: the bot's reply says the run started,
  with a summary of the request and a link to the run's page. The session gets the agent's
  summary of the request plus the quoted chat messages it's based on.
- The session works on a new branch `omniralph/chat-<id>` from the default branch, with the
  repository's quality gates, and asks the control panel to open a PR/MR (a draft until it's
  ready; its description says it was requested in chat). A later request in the same thread for
  the same repository continues that branch and PR/MR.
- One run per thread at a time: while the thread's run is active, new requests go to it as
  [replies](#replies-while-a-run-works) instead.

### Drafted requests

When the answer to a question is a code change, Om doesn't only describe it: it drafts the request
from the conversation with its `draft_request` tool. Its card follows Om's reply ("I drafted the
request from this conversation:") on every platform, with the request's title and repo and three
buttons:

- **Start request** starts the thread's request run in the draft's repo, as `start_work` does, with
  the draft's description and the chat's latest messages quoted. The card then says **Request
  started** with a link to the run, whose news comes back to the thread as run events. When the run
  can't start (coding is off for the repo, or the thread already has a run), the card says why and
  keeps its buttons.
- **Add to backlog** (only when the repo has a work item match and its tracker is connected) adds
  it to the Backlog exactly as the Backlog's + does (the same `createWorkItem`): a work item in the
  team, project and labels of the repo's work item match, with the draft's title and the request as
  its description. In the web, the card's **Triage now** checkbox (on by default) goes with the
  click; Slack and Discord can't show a checkbox, so the card first asks **Triage it now?** with
  **Triage now** and **Add without triage**. The card then says **Added to the backlog** (plus
  **· Om is triaging it** when triaged now) with the work item. When it can't be added (no work
  item match anymore, the tracker failed), the card says why and keeps its buttons.
- **Not now** dismisses it.

Only the member who asked can click them (anyone else is told so privately), each choice counts
once, and after 24 hours the card says **This draft expired**. Om still uses `start_work` when a
member asks it outright to make a change, and `draft_linear_issue` when they ask to file an issue.

### What the thread sees while a run works

The run never posts in the thread itself. What it has to say is recorded as a **run event** and
wakes the bot for that thread, usually within seconds (a cron catches up within a minute or two
when that fails). The bot then posts it in its own words, as one message per wake-up:

| Run event                                                                              | The bot posts                                                                   |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| A response (an answer, a notice such as "CI failed… working on a fix", the PR/MR link) | The run's answer, with its links                                                |
| A question (with options, as in Linear's pickers)                                      | The question and its options                                                    |
| An approval request (`ask_permission`)                                                 | Which tool call needs approval and why; a linked member answers approve or deny |
| A cleanup question (a stash or a kept branch after the merge)                          | The question and the answers it offers                                          |
| Completion or failure                                                                  | That the run finished, or failed and why                                        |

Om's thoughts, actions and plan changes aren't posted; ask the bot instead
([below](#checking-on-and-steering-runs)). Nothing in an event is an instruction to the bot: run
output is passed to it as data. When an event repeats what the thread was already told, the bot
posts nothing. Wake-ups don't use up the [turn limits](#6-ask-a-question) of the person who
started the run; the organization has a separate cap of 60 wake-ups per 10 minutes, and events
over it are relayed when it frees up.

### Replies while a run works

Every message in the thread goes to the bot, with or without a mention; it passes answers on to
the run with these tools:

| Tool                    | For                                                                                                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reply_to_run`          | An answer to the run's question, or anything else for it (more detail, a correction, "ship it"). Passed live within one heartbeat (about 20s) while its session runs, otherwise queued as the run's next request. |
| `answer_run_permission` | Approving or denying the run's open approval request. Answering one that expired or was already answered tells you so.                                                                                            |
| `answer_run_cleanup`    | Choosing one of a cleanup question's answers.                                                                                                                                                                     |

Files attached in the thread can go to the session with a reply: each is listed by name and type,
a text file's content follows (fenced as user data, up to 20,000 characters, within the
[attachment limits](#attachments)), and the session is told it can't see images, so it asks in
the thread what a screenshot shows if that matters.

The tools act only on the thread's own latest run. Answers from someone who isn't a linked member
aren't passed on; they get the link prompt. When no run is working, asking the bot for more work in
the same repository starts the next request on the same branch.

### Checking on and steering runs

"What's the run doing?" is answered by `get_run_status` from Omniralph's records, without asking
the run: its status, task, current job, what it waits on (an approval, pending requests) and its
latest activity (`post_activity` entries). It reports on the thread's latest run, or on any run
of the organization by run ID, job ID or Linear identifier ("how is ENG-42 doing?");
`get_ralph_run` gives a coding run's stories and pending guidance. A linked member can send any
run guidance ("tell ENG-42 to skip the migration"): `send_ralph_guidance` adds it as guidance and
a pending request, exactly like a reply in the run's own session, authored as `<name> (from
chat)`; a Linear run's session shows a "Guidance from <name> (from chat)" note. A finished run
can't take guidance, and runs can't be stopped from chat. The detailed progress of Linear runs
stays in Linear.

### PR/MR follow-ups

A chat run's PRs/MRs are looked after like
[those of Linear runs](linear.md#reviews-and-bot-requests-on-om-prsmrs): Omniralph's review
findings, `@omniralph fix` requests and failed CI become requests on the run (within the same
capped rounds), and the worktree is cleaned up after the merge. Their news ("CI failed on the pull
request… Working on a fix.", round limits, the cleanup report) reaches the thread as run events,
which the bot relays. `@omniralph fix` on the PR/MR replies with a pointer to the chat thread
instead of a Linear issue. A cleanup question is answered in the thread by a linked member
(`answer_run_cleanup`).

### What needs a linked account

The tools and their [tiers](#access-levels):

| Tool                                                                                                              | Tier     |
| ----------------------------------------------------------------------------------------------------------------- | -------- |
| `ask_about_code` (start a [code question](#code-questions)), `get_run_status`, `get_ralph_run`, `list_ralph_runs` | `read`   |
| `start_work`, `reply_to_run`, `answer_run_permission`, `answer_run_cleanup`, `send_ralph_guidance`                | `action` |
| `draft_linear_issue`, `delegate_linear_issue` ([Linear issues](#linear-issues-from-chat))                         | `action` |
| `draft_request` ([drafted requests](#drafted-requests))                                                           | `action` |

Only [linked members](#access-levels) can use `action` tools. Slack users admitted by email
domain can ask about runs and ask code questions but not change anything or answer a run's
questions and approvals; everyone else gets the link prompt. A wake-up acts for the person who
started the run: with their linked account's tools, else `read` tools only.

## Linear issues from chat

Linked members can turn a conversation into a Linear issue, and have Om build it. The
organization needs a connected Linear workspace ([linear.md](linear.md#3-connect-from-settings--connections));
without one the bot says an admin can connect it under **Settings › Connections › Add connection**.

### Filing an issue

> @Omniralph file an issue in ENG for the login timeout we just discussed

Om drafts the issue from the thread with its `draft_linear_issue` tool: a
title, a self-contained Markdown description (Linear readers don't see the thread), the team and,
if asked, a project, labels and a priority. The team is matched by key, name or id; if it's
unknown (or the workspace has several and you didn't say), the bot asks which one.

Nothing is created yet. The bot posts a **confirmation card** with the draft (team, project,
labels, priority, title and a preview of the description) and three buttons:

| Button                  | Does                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| **Create**              | Creates the issue in Linear. The card then shows its identifier and an **Open ENG-123** link. |
| **Create and delegate** | Creates the issue and [delegates it to Om](#delegating-to-om).                                |
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
  they're fetched from the chat platform again, uploaded to the tracker and embedded at the end of
  the description (`## Screenshots`). One that can't be fetched or uploaded is left out, and the
  card says so.
- The chat creates and delegates work items only through the tracker-neutral `WorkItemTracker`
  (`apps/web/src/lib/work-items/tracker.ts`): **Create** calls its `create`, **Create and
  delegate** and `delegate_linear_issue` its `delegateToOmniralph`, and the team comes from its
  `teams()`. Nothing under `lib/chat`, `lib/ask` or `components/ask` imports the Linear modules (a
  test checks). With no tracker connected, the tools and the card say "Connect a tracker to file
  work items."

### Delegating to Om

> @Omniralph file an issue for X and have Om build it

For a new issue, click **Create and delegate** on the card. For an existing one, ask the bot to
delegate it by identifier ("have Om build ENG-42"): its `delegate_linear_issue` tool sets the
issue's delegate to the Omniralph app. Either way it's the same as delegating in Linear: Linear
starts an agent session and Om builds the issue as described in
[linear.md › Delegate an issue](linear.md#5-delegate-an-issue) (the issue's team must be routed to
a repository with coding on).

The run stays a Linear run: its progress, questions and replies are in the Linear issue's agent
session, not in chat. The thread gets the issue's link, and one message each when:

- the run starts (`🚀 Omniralph started building ENG-42…`);
- it opens its pull/merge request (with the link);
- it finishes, or fails (`⚠️ Omniralph stopped working on ENG-42: …`).

These updates are tied to the thread when the delegation comes from chat and the run starts within
an hour. If Linear refuses the delegation after creating the issue, the issue is kept and the bot
says so; ask it to delegate again, or delegate the issue in Linear.

## Code questions

Ask about a connected repository's code and the bot gets an answer from a Claude session with a
checkout of it:

> @Omniralph in acme/api, where do we validate webhook signatures?

- Om can't read code itself in chat (and never answers from memory). It hands the
  question, made self-contained, to its `ask_about_code` tool, which starts a run of the
  channel's **Ask about code** [chat playbook](#chat-playbooks) and returns its ID at once. The repository
  must be one of the organization's connected repositories (Om doesn't need to be enabled); if
  it's ambiguous the bot asks which one first.
- The bot replies that it's looking into it. When the run answers, the bot is
  [woken](#what-the-thread-sees-while-a-run-works) and posts the answer as a new message, with
  links to the files it cites, or says why the run failed. Asking the same question again while it
  runs doesn't queue it twice. A code question's run takes no replies: ask a follow-up instead.
- The question is answered from the repository's **default branch** (other branches aren't
  supported; a [web chat](#web-ask) uses the default branch it read when it started). The agent sees the question, the latest messages of the thread and the thread's
  previous code question and answer, so follow-ups work.
- Attached text files (e.g. a pasted log) can go with the question: the agent passes them to
  `ask_about_code`, and their text (up to 3,000 characters each) is quoted in the question's
  context. The code agent can't see images, so for a screenshot it gets the file name and the
  question describes what the screenshot shows.
- It's usually as quick as a quick review. An answer that runs out of budget says so; try a
  narrower question.

### The read-only sandbox

A code question is a run of the channel's query task, by default the built-in
`builtin:ask-about-code` (role `chat-ask`, job type `chat.ask`, pool `short`); its
`chat-thread` sink records the answer (or the failure) as a run event, which the bot relays. The
built-in runs in a read-only sandbox:

- A fresh worktree of the default branch's head, on an agent host
  ([deploy-agent.md](deploy-agent.md)), run through the fixed query lifecycle
  ([ADR 0008](adr/0008-agents-tasks-and-the-harness.md)): the prompt, tools and model come from
  the task and agent definitions, sent with the job. The control panel never reads code.
- The Claude session gets only **Read, Grep and Glob**, limited to the worktree: it can't write
  files, run commands or push. No project settings are loaded; the branch's `CLAUDE.md` is passed
  as quoted data, as in reviews.
- Up to 30 turns and a token budget of 25% of the token cap of the repository's review depth
  (Quick, Standard or Deep), with the depth's model.
- If the repository pins jobs to specific agents, only those agents take it.
- When the default branch doesn't exist (e.g. an empty repository), the run finishes without a
  session and the bot says there's no branch to read.

### Agent version

A code question needs an agent that accepts **query** tasks on **version 0.9.0 or later** (the
first release with the query task lifecycle); the job carries that in `jobs.min_agent_version`,
so older agents leave it queued (the claim only gives a job to an agent whose reported version
is at least the job's minimum). Before queueing, the control panel checks the organization's
online agents (the version and task types they report in heartbeats); when none that would take
the job can run it, nothing is queued and the bot says so: "no agent … is online", or that the
online ones need to accept query tasks on 0.9.0 or later. Update or start an agent
([deploy-agent.md](deploy-agent.md)) and ask again.

## Attachments

Images and text files attached to messages in the thread reach the model:

- **Images**: PNG, JPEG, GIF and WebP, up to 5 MB each.
- **Text files**: `text/*`, JSON, XML, YAML, TOML and similar (or a `.log`, `.txt`, `.md`, `.csv`…
  file without a useful type), UTF-8, up to 256 KB each.
- At most 5 attachments per message are read. Anything else (video, audio, PDFs, archives, other
  binaries), a file over its cap, one whose size the platform didn't report, or one that can't be
  fetched within 30 seconds is skipped, and the model is told
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
  A workspace connected before the scope was added must reconnect (**Settings › Connections › Slack › ⋯ ›
  Edit connection**); until then its files are skipped as "couldn't be fetched". Discord's attachment
  links expire after about a day, so an old screenshot may no longer be fetchable.
- Screenshots can be [embedded in Linear issues](#filing-an-issue) and attached files included in
  [code questions](#code-questions).

## Access levels

Who may ask what depends on whether Omniralph knows who's asking. Each tool the agent uses has a
tier: `read` (questions about the organization and its runs, including
[code questions](#code-questions)) or `action` (changing something: starting, steering and
answering [coding runs](#om-from-chat), and
[filing and delegating Linear issues](#linear-issues-from-chat)); see
[What needs a linked account](#what-needs-a-linked-account) for each tool's tier.

| Who                                                                                                                                                                        | Gets                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Linked member**: a chat user [linked](#account-linking) to an Omniralph account that is a member of the organization owning the connection                               | `read` and `action` tools                                                   |
| **Slack user on the organization's email domains**: not linked, but their Slack profile email's domain is one of the organization's email domains (**Settings › Members**) | `read` tools only                                                           |
| **Everyone else**                                                                                                                                                          | No tools; the bot answers without organization data and posts a link prompt |

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
- **Linked identities** are listed under **Settings › Linked chat accounts**, across all your
  organizations, each with **Unlink**.

### Automatic linking by Slack email

When a Slack user's profile email exactly matches the sign-in email of a member of the
organization (case-insensitive), Omniralph links them automatically the first time they talk to
the bot, and tells them once, privately, which email it matched and where to unlink. Slack
profiles are read with `users.info` and cached for an hour, so email changes in Slack take up to
an hour to show. Bots, deactivated users and profiles without an email aren't linked.

**To opt out**, unlink the identity under **Settings › Linked chat accounts**. Omniralph remembers that
you unlinked it and never links that Slack user automatically again; linking by hand later lifts
the opt-out. Leaving the organization ends the link's access straight away.

## Troubleshooting

| Symptom                                                  | Check                                                                                                                                                                                  |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Connect** returns "… app not configured"               | The platform's env vars are all set for this environment, and the deployment was redeployed after setting them.                                                                        |
| Slack install fails for other workspaces                 | Public distribution is activated (step 1.3).                                                                                                                                           |
| The bot doesn't react to a Slack mention                 | The bot is in the channel; the event request URL is verified under **Event Subscriptions**; the workspace is listed under **Settings › Connections**.                                  |
| The bot doesn't react to a Discord mention               | Expected for now: no Gateway connection delivers ordinary messages ([Ordinary Discord messages aren't received yet](#ordinary-discord-messages-arent-received-yet)).                   |
| "Om isn't set up in chat"                                | The AI Gateway is enabled for the Vercel team, or `AI_GATEWAY_API_KEY` is set off Vercel.                                                                                              |
| The bot asks to link although you're a member            | On Discord, always link by hand. On Slack, your Slack email isn't your Omniralph sign-in email (and its domain isn't one of the organization's), or you unlinked before: link by hand. |
| A reply didn't reach the coding session                  | You're a linked member, and the thread's run is still unfinished; the bot passes replies on with `reply_to_run` (ask it to if it didn't).                                              |
| A run's answer or question never showed up in the thread | The `/api/cron/chat-run-events` cron is running (Vercel › **Cron Jobs**) and `CRON_SECRET` is set; the AI Gateway is configured. `get_run_status` shows what the run is doing.         |
| The bot says the channel's playbook can't run            | An admin chooses another **Ask about code** or **Start work** playbook for the organization (or removes the channel's override): see [Chat playbooks](#chat-playbooks).                |
| The bot won't start an Om request                        | You're a linked member; the repository has coding on and is written as `owner/repo`; the thread has no active run (reply to it instead).                                               |
| The Linear card's buttons do nothing (Slack)             | **Interactivity** is on under **Interactivity & Shortcuts** with the request URL `<APP_URL>/api/webhooks/slack`.                                                                       |
| "Only the person who asked…" on a card                   | Only the member who asked for the draft can click it; mention the bot to draft your own.                                                                                               |
| A code question says no agent can take it                | An agent that accepts `query` tasks on version 0.9.0 or later is online (and, if the repository pins jobs to agents, it's one of them).                                                |
| The bot says it couldn't fetch a Slack attachment        | The app has the `files:read` scope and the workspace reconnected after it was added.                                                                                                   |
| A delegated issue's thread got no "started" message      | The issue's team is routed to a repository with coding on and an agent that accepts `coding` is online; the run must start within an hour of the delegation.                           |
