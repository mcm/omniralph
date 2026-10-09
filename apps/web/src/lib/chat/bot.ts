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
import { getDb } from "@/lib/db";
import { discordOAuthConfig, type DiscordOAuthConfig } from "./discord-oauth";
import { slackOAuthConfig, type SlackCredentials, type SlackOAuthConfig } from "./slack-oauth";

/**
 * The Chat SDK bot behind the Slack and Discord webhooks. Mentioning it in a
 * connected workspace or server starts a thread it subscribes to; every
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
}

/** Answers a message in a thread the bot is part of (the control-panel agent plugs in here). */
export interface ChatConversationHandler {
  handle(thread: Thread, message: Message, context: ChatConversationContext): Promise<void>;
}

export const ACKNOWLEDGEMENT =
  "Thanks, I got your message. I can't answer questions here yet, but I will soon.";

/** Replies with {@link ACKNOWLEDGEMENT} and records the reply. */
export function acknowledgementHandler(db: Database): ChatConversationHandler {
  return {
    async handle(thread, _message, { chatThread }) {
      await thread.post(ACKNOWLEDGEMENT);
      await appendChatMessage(db, {
        threadId: chatThread.id,
        role: "assistant",
        content: ACKNOWLEDGEMENT,
      });
    },
  };
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
}

export interface ChatBot {
  chat: Chat;
  /** The adapter of each configured platform. */
  adapters: Partial<Record<ChatPlatform, Adapter>>;
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

/** The Discord guild of a Chat SDK thread ID (`discord:{guildId}:{channelId}[:{threadId}]`). */
function discordGuildId(threadId: string): string | null {
  const [prefix, guildId] = threadId.split(":");
  return prefix === "discord" && guildId && guildId !== "@me" ? guildId : null;
}

/** Builds the bot with the configured platforms' adapters. */
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

  const chat = new Chat({
    userName: "omniralph",
    adapters: adapters as Record<string, Adapter>,
    state: deps.state,
    // A burst of replies waits for the turn in progress instead of being dropped.
    concurrency: "queue",
    logger,
  });

  /** The connection that received a message in `thread`, or null (not connected, or a DM). */
  async function connectionFor(thread: Thread): Promise<ChatConnection | null> {
    if (thread.isDM) return null;
    if (thread.adapter.name === "slack") return slackRequestScope.getStore()?.connection ?? null;
    if (thread.adapter.name === "discord") {
      const guildId = discordGuildId(thread.id);
      return guildId ? getChatConnectionByExternalId(db, "discord", guildId) : null;
    }
    return null;
  }

  async function converse(
    thread: Thread,
    message: Message,
    context: MessageContext | undefined,
    subscribe: boolean,
  ): Promise<void> {
    if (message.author.isMe) return;
    const connection = await connectionFor(thread);
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
      });
    }
    await handler.handle(thread, message, {
      organizationId: connection.organizationId,
      connection,
      chatThread,
      skipped,
    });
  }

  chat.onNewMention((thread, message, context) => converse(thread, message, context, true));
  chat.onSubscribedMessage((thread, message, context) => converse(thread, message, context, false));

  return { chat, adapters, discord: deps.discord };
}

let bot: ChatBot | undefined;

/**
 * The deployment's bot (built on first use from the env): Postgres state on
 * the migration-owned Chat SDK tables, the acknowledgement handler.
 */
export function getChatBot(): ChatBot {
  if (!bot) {
    const db = getDb();
    bot = createChatBot({
      db,
      slack: slackOAuthConfig(),
      discord: discordOAuthConfig(),
      state: createPostgresState({ client: db.$client, autoCreateSchema: false }),
      handler: acknowledgementHandler(db),
    });
  }
  return bot;
}
