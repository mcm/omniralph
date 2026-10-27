import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { createDiscordAdapter } from "@chat-adapter/discord";
import { createSlackAdapter, type SlackAdapterConfig } from "@chat-adapter/slack";
import { createPostgresState } from "@chat-adapter/state-pg";
import {
  appendChatMessage,
  ensureChatThread,
  getChatConnectionByExternalId,
  getChatConnectionWithCredentials,
  type ChatConnection,
  type ChatPlatform,
  type ChatThread,
  type Database,
} from "@omniralph/db";
import {
  Chat,
  ConsoleLogger,
  type Adapter,
  type Logger,
  type Message,
  type MessageContext,
  type StateAdapter,
  type Thread,
} from "chat";
import { gateway } from "ai";
import { getAppUrl } from "@/lib/app-url";
import { getDb } from "@/lib/db";
import type { WorkItemTracker } from "@/lib/work-items/tracker";
import { chatAgentConfig } from "./agent/config";
import { attachmentMetadata } from "./attachments";
import { createChatAgentHandler } from "./agent/handler";
import { discordOAuthConfig, type DiscordOAuthConfig } from "./discord-oauth";
import { resolveChatActor, type ChatActor, type ChatMemberActor } from "./identity";
import { createLinkUrl } from "./link";
import { handleLinearIssueAction, LINEAR_ISSUE_ACTIONS } from "./linear-issue";
import { CHAT_ACCOUNTS_PATH } from "./link-paths";
import { slackOAuthConfig, type SlackCredentials, type SlackOAuthConfig } from "./slack-oauth";
import { createWebAdapter, webChatConnection } from "./web-adapter";

/**
 * The Chat SDK bot behind the Slack and Discord webhooks and the web's Ask
 * (`./web-adapter`). Mentioning it in a connected workspace or server, or
 * starting a web chat, starts a thread it subscribes to; every
 * message of that thread is recorded in `chat_messages` and handed to the
 * {@link ChatConversationHandler}, together with the organization of the
 * connection that received it.
 */

/** What a conversation handler knows besides the thread and the message. */
export interface ChatConversationContext {
  /** The organization of the connection that received the message: never the message's say. */
  organizationId: string;
  connection: ChatConnection;
  /** The thread's `chat_threads` row. */
  chatThread: ChatThread;
  /** Messages that arrived while the previous turn ran (recorded already), oldest first. */
  skipped: Message[];
  /** The thread and message being answered (as passed to `handle`). */
  thread: Thread;
  message: Message;
  /** Who wrote the message, in the connection's organization. */
  actor: ChatActor;
  /** A link for the message's author to link their chat identity (valid 15 minutes, once). */
  linkUrl(): Promise<string>;
  logger?: Logger;
}

/** Answers a message in a thread the bot is part of (the control-panel agent plugs in here). */
export interface ChatConversationHandler {
  handle(thread: Thread, message: Message, context: ChatConversationContext): Promise<void>;
}

const PLATFORM_NAMES: Record<ChatPlatform, string> = {
  slack: "Slack",
  discord: "Discord",
  web: "Omniralph",
};

/** The thread note when `text` went to the author by DM. */
export const SENT_BY_DM_NOTE = "I sent you a direct message: check your DMs.";

/**
 * Posts `text` so only `message`'s author sees it: ephemeral where the
 * platform has it (Slack), else by DM with a short note in the thread
 * (Discord). If the DM fails, it goes in the thread mentioning them, with a
 * warning logged.
 */
export async function postToAuthor(
  thread: Thread,
  message: Message,
  text: string,
  logger?: Logger,
): Promise<void> {
  const mention = thread.mentionUser(message.author.userId);
  if (await thread.postEphemeral(message.author, text, { fallbackToDM: false })) return;
  let error: unknown;
  try {
    if (await thread.postEphemeral(message.author, text, { fallbackToDM: true })) {
      await thread.post(`${mention} ${SENT_BY_DM_NOTE}`);
      return;
    }
  } catch (dmError) {
    error = dmError;
  }
  (logger ?? console).warn("Couldn't DM a chat user: posting in the thread instead", {
    threadId: thread.id,
    error: error instanceof Error ? error.message : error,
  });
  await thread.post(`${mention} ${text}`);
}

/** The prompt asking a chat user to link their account, with the link. */
export function linkPrompt(platform: ChatPlatform, url: string): string {
  return `To do that, I need to know who you are in Omniralph. Link your ${PLATFORM_NAMES[platform]} account to your Omniralph account here (the link works for 15 minutes): ${url}`;
}

/**
 * The author as a linked member, or null after asking them (privately where
 * the platform allows) to link their account. Tools of the `action` tier
 * call this first.
 */
export async function requireMember(
  context: ChatConversationContext,
): Promise<ChatMemberActor | null> {
  if (context.actor.kind === "member") return context.actor;
  await postToAuthor(
    context.thread,
    context.message,
    linkPrompt(context.connection.platform, await context.linkUrl()),
    context.logger,
  );
  return null;
}

/** The one-time note to a Slack user linked automatically by email. */
export function autoLinkedNote(platform: ChatPlatform, email: string, appUrl: string): string {
  return `I linked your ${PLATFORM_NAMES[platform]} account to your Omniralph account because both use ${email}. To unlink it, open ${appUrl}${CHAT_ACCOUNTS_PATH}.`;
}

export interface ChatBotDeps {
  db: Database;
  /** Null leaves Slack out (its webhook answers 503). */
  slack: SlackOAuthConfig | null;
  /** Null leaves Discord out (its webhook answers 503). */
  discord: DiscordOAuthConfig | null;
  state: StateAdapter;
  handler: ChatConversationHandler;
  logger?: Logger;
  /** `ENCRYPTION_KEY` override for Slack credentials (tests). */
  encryptionKey?: string | Buffer;
  /** Extra Slack adapter options (tests: API URL, retries). */
  slackOptions?: Partial<SlackAdapterConfig>;
  /** Discord API base URL override (tests). */
  discordApiUrl?: string;
  /** Slack `users.info` goes through it (tests fake it). */
  fetch?: typeof fetch;
  /** `APP_URL` and `AUTH_SECRET` for link URLs (tests). */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** An organization's work item tracker, for issues drafted in chat (default: `getWorkItemTracker`). */
  tracker?: (organizationId: string) => Promise<WorkItemTracker>;
}

export interface ChatBot {
  chat: Chat;
  /** The adapter of each configured platform (`web` always). */
  adapters: Partial<Record<ChatPlatform, Adapter>>;
  /** The Chat SDK state (subscriptions, locks, thread state). */
  state: StateAdapter;
  discord: DiscordOAuthConfig | null;
}

/**
 * The Slack connection that resolved the token of the event being handled.
 * The Slack adapter only dispatches an event after `installationProvider`
 * found its workspace, so a handler reached from a Slack webhook finds the
 * connection here (the Slack thread ID doesn't carry the workspace).
 */
interface SlackRequestScope {
  connection?: ChatConnection;
}
const slackRequestScope = new AsyncLocalStorage<SlackRequestScope>();

/** Runs a Slack webhook so its handlers can see the connection that received it. */
export function withSlackRequestScope<T>(fn: () => T): T {
  return slackRequestScope.run({}, fn);
}

/**
 * Runs `fn` as if a webhook of `connection` was being handled, so the bot's
 * handlers find the connection (Slack) outside a webhook: a wake-up handing
 * back messages queued while it held the thread's lock.
 */
export function withChatConnection<T>(connection: ChatConnection, fn: () => T): T {
  return slackRequestScope.run({ connection }, fn);
}

/** The Discord guild of a Chat SDK thread ID (`discord:{guildId}:{channelId}[:{threadId}]`). */
function discordGuildId(threadId: string): string | null {
  const [prefix, guildId] = threadId.split(":");
  return prefix === "discord" && guildId && guildId !== "@me" ? guildId : null;
}

/** Builds the bot with the configured platforms' adapters, and the web's (it needs no config). */
export function createChatBot(deps: ChatBotDeps): ChatBot {
  const { db, handler } = deps;
  const logger = deps.logger ?? new ConsoleLogger("info", "chat");
  const adapters: Partial<Record<ChatPlatform, Adapter>> = {};

  if (deps.slack) {
    adapters.slack = createSlackAdapter({
      // Multi-workspace: no `botToken`; each workspace's comes from its connection.
      signingSecret: deps.slack.signingSecret,
      clientId: deps.slack.clientId,
      clientSecret: deps.slack.clientSecret,
      installationProvider: {
        async getInstallation(installationId) {
          const connection = await getChatConnectionWithCredentials<SlackCredentials>(
            db,
            "slack",
            installationId,
            deps.encryptionKey,
          );
          if (!connection?.credentials) return null;
          const { credentials, ...rest } = connection;
          const scope = slackRequestScope.getStore();
          if (scope) scope.connection = rest;
          return {
            botToken: credentials.botToken,
            botUserId: credentials.botUserId,
            enterpriseId: credentials.enterpriseId,
            isEnterpriseInstall: credentials.isEnterpriseInstall,
            teamName: connection.name,
          };
        },
      },
      logger: logger.child("slack"),
      ...deps.slackOptions,
    });
  }
  if (deps.discord) {
    adapters.discord = createDiscordAdapter({
      applicationId: deps.discord.applicationId,
      botToken: deps.discord.botToken,
      publicKey: deps.discord.publicKey,
      logger: logger.child("discord"),
      ...(deps.discordApiUrl && { apiUrl: deps.discordApiUrl }),
    });
  }
  adapters.web = createWebAdapter({ db });

  const chat = new Chat({
    userName: "omniralph",
    adapters: adapters as Record<string, Adapter>,
    state: deps.state,
    // A burst of replies waits for the turn in progress instead of being dropped.
    concurrency: "queue",
    logger,
  });

  /** The connection that received an event in a thread, or null (not connected, or a DM). */
  async function connectionFor(
    adapter: Adapter,
    threadId: string,
    isDM: boolean,
  ): Promise<ChatConnection | null> {
    if (isDM) return null;
    if (adapter.name === "slack") return slackRequestScope.getStore()?.connection ?? null;
    if (adapter.name === "discord") {
      const guildId = discordGuildId(threadId);
      return guildId ? getChatConnectionByExternalId(db, "discord", guildId) : null;
    }
    if (adapter.name === "web") return webChatConnection(db, threadId);
    return null;
  }

  const identityDeps = {
    db,
    fetch: deps.fetch,
    encryptionKey: deps.encryptionKey,
    now: deps.now,
    logger,
  };

  async function converse(
    thread: Thread,
    message: Message,
    context: MessageContext | undefined,
    subscribe: boolean,
  ): Promise<void> {
    if (message.author.isMe) return;
    const connection = await connectionFor(thread.adapter, thread.id, thread.isDM);
    if (!connection) {
      logger.info("Ignoring a message from an unconnected workspace", { threadId: thread.id });
      return;
    }
    const chatThread = await ensureChatThread(db, {
      connectionId: connection.id,
      externalThreadId: thread.id,
      channelId: thread.channelId,
      startedByExternalUserId: message.author.userId,
    });
    // The connection was removed since it was looked up.
    if (!chatThread) return;
    if (subscribe) await thread.subscribe();
    const skipped = (context?.skipped ?? []).filter((m) => !m.author.isMe);
    for (const m of [...skipped, message]) {
      await appendChatMessage(db, {
        threadId: chatThread.id,
        role: "user",
        externalUserId: m.author.userId,
        authorName: m.author.fullName || m.author.userName,
        content: m.text,
        attachments: attachmentMetadata(m.attachments),
      });
    }
    const author = message.author;
    const actor = await resolveChatActor(identityDeps, {
      organizationId: connection.organizationId,
      connection,
      platform: connection.platform,
      externalUserId: author.userId,
    });
    if (actor.kind === "member" && actor.autoLinked) {
      await postToAuthor(
        thread,
        message,
        autoLinkedNote(connection.platform, actor.autoLinked.email, getAppUrl(deps.env)),
        logger,
      );
    }
    await handler.handle(thread, message, {
      organizationId: connection.organizationId,
      connection,
      chatThread,
      skipped,
      thread,
      message,
      actor,
      logger,
      linkUrl: () =>
        createLinkUrl(
          {
            organizationId: connection.organizationId,
            connectionId: connection.id,
            platform: connection.platform,
            externalUserId: author.userId,
            displayName: author.fullName || author.userName || author.userId,
          },
          deps.env,
          deps.now?.(),
        ),
    });
  }

  chat.onNewMention((thread, message, context) => converse(thread, message, context, true));
  chat.onAction(LINEAR_ISSUE_ACTIONS, async (event) => {
    const connection = await connectionFor(
      event.adapter,
      event.threadId,
      event.thread?.isDM ?? event.adapter.isDM?.(event.threadId) ?? false,
    );
    if (!connection) return;
    await handleLinearIssueAction(
      {
        db,
        resolveActor: (c, externalUserId) =>
          resolveChatActor(identityDeps, {
            organizationId: c.organizationId,
            connection: c,
            platform: c.platform,
            externalUserId,
          }),
        tracker: deps.tracker,
        now: deps.now,
        logger,
      },
      event,
      connection,
    );
  });
  chat.onSubscribedMessage((thread, message, context) => converse(thread, message, context, false));

  return { chat, adapters, state: deps.state, discord: deps.discord };
}

let bot: ChatBot | undefined;

/**
 * The deployment's bot (built on first use from the env): Postgres state on
 * the migration-owned Chat SDK tables, the control-panel agent as handler.
 */
export function getChatBot(): ChatBot {
  if (!bot) {
    const db = getDb();
    const agent = chatAgentConfig();
    bot = createChatBot({
      db,
      slack: slackOAuthConfig(),
      discord: discordOAuthConfig(),
      state: createPostgresState({ client: db.$client, autoCreateSchema: false }),
      handler: createChatAgentHandler({ db, model: agent && gateway(agent.model) }),
    });
  }
  return bot;
}
