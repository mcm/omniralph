# Chat (Slack and Discord)

The chat front door lets people ask Omniralph about their organization from Slack or Discord.
Mention the bot in a channel of a connected workspace or server and it answers in a thread; reply
in that thread to continue the conversation. The answers come from the **control-panel agent**, an
LLM that runs in the control panel through the [Vercel AI SDK](https://ai-sdk.dev) and the
[Vercel AI Gateway](https://vercel.com/docs/ai-gateway) and reads the organization's ralph runs,
reviews, jobs, agents and repositories through tools. See
[ADR 0005](adr/0005-chat-front-door.md) for the design.

The control panel does all of it: it holds the Slack and Discord credentials, receives their
events, keeps each thread's history in Postgres and calls the model. Agent hosts aren't involved.

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
   - the bot scopes (`app_mentions:read`, `channels:history`, `channels:read`, `chat:write`,
     `groups:history`, `groups:read`, `reactions:read`, `reactions:write`, `users:read`,
     `users:read.email`). `users:read.email` is what lets Omniralph
     [recognize people by email](#automatic-linking-by-slack-email).
2. Under **Basic Information › App Credentials**, copy the **Client ID**, **Client Secret** and
   **Signing Secret** into `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and `SLACK_SIGNING_SECRET`.
3. **Turn on distribution** so workspaces other than the app's own can install it: **Manage
   Distribution** › check the items under **Share Your App with Other Workspaces** (remove
   hard-coded information, use HTTPS redirect URLs) › **Activate Public Distribution**. This doesn't
   list the app in the Slack Marketplace; it only allows OAuth installs from other workspaces.
   Without it, only the workspace that owns the app can connect.

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
   with the env vars).
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

| Variable | Value |
| -- | -- |
| `SLACK_CLIENT_ID` | The Slack app's client ID |
| `SLACK_CLIENT_SECRET` | The Slack app's client secret |
| `SLACK_SIGNING_SECRET` | The Slack app's signing secret |
| `DISCORD_APPLICATION_ID` | The Discord application ID |
| `DISCORD_CLIENT_SECRET` | The Discord OAuth2 client secret |
| `DISCORD_BOT_TOKEN` | The Discord bot token |
| `DISCORD_PUBLIC_KEY` | The Discord application's public key |
| `AI_GATEWAY_API_KEY` | Only off Vercel: an AI Gateway API key |
| `CHAT_AGENT_MODEL` | Optional: the AI Gateway model id (default `anthropic/claude-haiku-5.5`) |

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
pages. It can't start or steer ralph runs, create Linear issues or answer questions about code yet.

Turns are rate-limited to 10 per minute per chat user and 60 per 10 minutes per organization; the
bot says so once when a limit is reached.

## Access levels

Who may ask what depends on whether Omniralph knows who's asking. Each tool the agent uses has a
tier: `read` (questions about the organization) or `action` (changing something, for later
features).

| Who | Gets |
| -- | -- |
| **Linked member**: a chat user [linked](#account-linking) to an Omniralph account that is a member of the organization owning the connection | `read` and `action` tools |
| **Slack user on the organization's email domains**: not linked, but their Slack profile email's domain is one of the organization's email domains (**Settings › Organization**) | `read` tools only |
| **Everyone else** | No tools; the bot answers without organization data and posts a link prompt |

- An organization without email domains grants no domain-based access, and the deployment-wide
  `ALLOWED_EMAIL_DOMAINS` is never used for chat.
- **Discord never exposes emails to bots**, so Discord users always need an explicit link,
  whatever their email.
- When someone without access asks for something that needs it, the bot replies with a link
  prompt: privately in Slack (an ephemeral message only they see), as a mention in the thread in
  Discord.
- The organization always comes from the workspace or server the message arrived in, never from
  the message itself, and every tool only reads that organization's data. Messages are treated as
  untrusted input, and everything the bot posts goes through the same output sanitizer as review
  comments.

## Account linking

A chat identity (a Slack or Discord user in one organization) can be linked to one Omniralph
member.

- **Linking by hand.** The link prompt contains a link to `<APP_URL>/chat/link` that works for 15
  minutes. Open it, sign in if needed, and confirm **Link** on "Link <platform> user <name> to your
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

| Symptom | Check |
| -- | -- |
| **Connect** is disabled | The platform's env vars are all set for this environment, and the deployment was redeployed after setting them. |
| Slack install fails for other workspaces | Public distribution is activated (step 1.3). |
| The bot doesn't react to a Slack mention | The bot is in the channel; the event request URL is verified under **Event Subscriptions**; the workspace is listed under **Settings › Integrations**. |
| The bot doesn't react to a Discord mention | The Vercel plan is Pro or Enterprise; the `/api/cron/discord-gateway` cron is running (Vercel › **Cron Jobs**) and `CRON_SECRET` is set; the **Message Content Intent** is on; the bot can view the channel. |
| "The Omniralph assistant isn't configured" | The AI Gateway is enabled for the Vercel team, or `AI_GATEWAY_API_KEY` is set off Vercel. |
| The bot asks to link although you're a member | On Discord, always link by hand. On Slack, your Slack email isn't your Omniralph sign-in email (and its domain isn't one of the organization's), or you unlinked before: link by hand. |
