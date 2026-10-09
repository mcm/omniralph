import { createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import { createMockLogger, createMockState } from "@chat-adapter/tests";
import {
  chatMessages,
  chatThreads,
  closeDb,
  createDb,
  getChatConnectionByExternalId,
  organizations,
  runMigrations,
  saveChatConnection,
  type ChatConnection,
  type Database,
} from "@omniralph/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Message, Thread } from "chat";
import { asc, eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatConversationContext, ChatConversationHandler } from "./bot";
import type { SlackCredentials } from "./slack-oauth";

vi.mock("server-only", () => ({}));
const ENCRYPTION_KEY = randomBytes(32).toString("base64");

const { ACKNOWLEDGEMENT, acknowledgementHandler, createChatBot } = await import("./bot");
const {
  DISCORD_GATEWAY_TOKEN_HEADER,
  handleDiscordWebhook,
  handleSlackWebhook,
  slackUninstalledId,
} = await import("./webhooks");

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

const SLACK = { clientId: "client-1", clientSecret: "secret-1", signingSecret: "signing-1" };
const SLACK_BOT_USER = "UBOT";
const DISCORD_APP_ID = "900000000000000001";
const { publicKey: discordKey, privateKey: discordPrivateKey } = generateKeyPairSync("ed25519");
const DISCORD = {
  applicationId: DISCORD_APP_ID,
  clientSecret: "discord-secret",
  botToken: "discord-bot-token",
  publicKey: discordKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex"),
};

// ── Fake Slack and Discord APIs ──────────────────────────────────────────────

const posts: Array<{ platform: string; channel: string; text: string; thread?: string }> = [];
const server = setupServer(
  http.post("https://slack.com/api/users.info", async ({ request }) => {
    const user = new URLSearchParams(await request.text()).get("user");
    return HttpResponse.json({
      ok: true,
      user: { id: user, name: `user-${user}`, real_name: `User ${user}`, profile: {} },
    });
  }),
  http.post("https://slack.com/api/chat.postMessage", async ({ request }) => {
    const body = new URLSearchParams(await request.text());
    posts.push({
      platform: "slack",
      channel: body.get("channel")!,
      text: body.get("text")!,
      thread: body.get("thread_ts") ?? undefined,
    });
    return HttpResponse.json({ ok: true, channel: body.get("channel"), ts: "1700000099.000100" });
  }),
  http.post(
    "https://discord.com/api/v10/channels/:channel/messages/:message/threads",
    ({ params }) =>
      HttpResponse.json({ id: `thread-of-${String(params.message)}`, parent_id: params.channel }),
  ),
  http.get("https://discord.com/api/v10/channels/:channel", ({ params }) =>
    HttpResponse.json({ id: params.channel, parent_id: "CH1", type: 11 }),
  ),
  http.post(
    "https://discord.com/api/v10/channels/:channel/messages",
    async ({ params, request }) => {
      const body = (await request.json()) as { content: string };
      posts.push({ platform: "discord", channel: String(params.channel), text: body.content });
      return HttpResponse.json({
        id: "reply-1",
        channel_id: params.channel,
        content: body.content,
        author: { id: DISCORD_APP_ID, username: "omniralph", bot: true },
        timestamp: new Date().toISOString(),
        attachments: [],
        embeds: [],
        mentions: [],
      });
    },
  ),
);

// ── Requests ─────────────────────────────────────────────────────────────────

function slackRequest(payload: unknown, secret = SLACK.signingSecret): Request {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return new Request("https://omniralph.example.com/api/webhooks/slack", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body,
  });
}

let eventCount = 0;
function slackEvent(team: string, event: Record<string, unknown>) {
  eventCount += 1;
  return {
    type: "event_callback",
    team_id: team,
    api_app_id: "A1",
    event_id: `Ev${eventCount}`,
    event_time: Math.floor(Date.now() / 1000),
    authorizations: [
      { team_id: team, user_id: SLACK_BOT_USER, is_bot: true, is_enterprise_install: false },
    ],
    event: { team, event_ts: event.ts, ...event },
  };
}

const MENTION_TS = "1700000000.000100";
/** The mention's text as the adapter renders it (`<@UBOT>` resolved through `users.info`). */
const MENTION_TEXT = `@User ${SLACK_BOT_USER} what is running?`;
const slackMention = (team: string, ts = MENTION_TS) =>
  slackEvent(team, {
    type: "app_mention",
    user: "U1",
    text: `<@${SLACK_BOT_USER}> what is running?`,
    ts,
    channel: "C1",
  });
const slackReply = (team: string, text: string, ts: string, user = "U1") =>
  slackEvent(team, {
    type: "message",
    channel_type: "channel",
    user,
    text,
    ts,
    thread_ts: MENTION_TS,
    channel: "C1",
    ...(user === SLACK_BOT_USER && { bot_id: "B1" }),
  });

function discordGatewayRequest(event: unknown, token = DISCORD.botToken): Request {
  return new Request("https://omniralph.example.com/api/webhooks/discord", {
    method: "POST",
    headers: { "content-type": "application/json", [DISCORD_GATEWAY_TOKEN_HEADER]: token },
    body: JSON.stringify(event),
  });
}

function discordMessage(
  guild: string,
  data: { id: string; channel: string; content: string; author?: string; mention?: boolean },
) {
  const author = data.author ?? "D1";
  return {
    type: "GATEWAY_MESSAGE_CREATE",
    timestamp: Date.now(),
    data: {
      id: data.id,
      channel_id: data.channel,
      channel_type: data.channel === "CH1" ? 0 : 11,
      guild_id: guild,
      author: {
        id: author,
        username: `user-${author}`,
        global_name: `User ${author}`,
        bot: author === DISCORD_APP_ID,
      },
      content: data.content,
      timestamp: new Date().toISOString(),
      mentions: data.mention ? [{ id: DISCORD_APP_ID, username: "omniralph" }] : [],
      mention_roles: [],
      attachments: [],
    },
  };
}

// ── Suite ────────────────────────────────────────────────────────────────────

interface Handled {
  threadId: string;
  text: string;
  context: ChatConversationContext;
}

describe.skipIf(!dockerAvailable)("chat bot webhooks", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let orgId: string;
  let otherOrgId: string;
  let slackConnection: ChatConnection;
  let discordConnection: ChatConnection;
  let handled: Handled[];
  let tasks: Promise<unknown>[];
  let bot: ReturnType<typeof createChatBot>;
  let state: ReturnType<typeof createMockState>;

  const recordingHandler: ChatConversationHandler = {
    async handle(thread: Thread, message: Message, context) {
      handled.push({ threadId: thread.id, text: message.text, context });
    },
  };

  const build = (handler: ChatConversationHandler = recordingHandler) => {
    state = createMockState();
    bot = createChatBot({
      db,
      slack: SLACK,
      discord: DISCORD,
      state,
      handler,
      logger: createMockLogger(),
      encryptionKey: ENCRYPTION_KEY,
      slackOptions: { webClientOptions: { retryConfig: { retries: 0 } } },
    });
  };

  const deps = () => ({ db, bot, waitUntil: (task: Promise<unknown>) => void tasks.push(task) });
  /** Delivers a request and waits for the work it deferred. */
  async function deliver(handle: typeof handleSlackWebhook, request: Request): Promise<Response> {
    const res = await handle(request, deps());
    while (tasks.length > 0) await Promise.all(tasks.splice(0));
    return res;
  }
  const slack = (payload: unknown) => deliver(handleSlackWebhook, slackRequest(payload));
  const discord = (event: unknown) => deliver(handleDiscordWebhook, discordGatewayRequest(event));

  const connect = async (
    organizationId: string,
    platform: "slack" | "discord",
    externalId: string,
  ): Promise<ChatConnection> => {
    const credentials: SlackCredentials | null =
      platform === "slack"
        ? {
            botToken: `xoxb-${externalId}`,
            botUserId: SLACK_BOT_USER,
            appId: "A1",
            scope: "app_mentions:read",
            teamId: externalId,
            isEnterpriseInstall: false,
          }
        : null;
    const saved = await saveChatConnection(
      db,
      {
        organizationId,
        platform,
        externalId,
        name: externalId,
        credentials,
        installedByUserId: null,
      },
      ENCRYPTION_KEY,
    );
    if (saved === "other_organization") throw new Error("taken");
    return saved;
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    // After the container: Testcontainers talks HTTP to the Docker API.
    server.listen({ onUnhandledFrame: "error" });
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    const [org, other] = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Other" }])
      .returning();
    orgId = org!.id;
    otherOrgId = other!.id;
  });

  beforeEach(async () => {
    await db.delete(chatThreads);
    await db.delete(chatMessages);
    await db.execute("DELETE FROM chat_connections");
    slackConnection = await connect(orgId, "slack", "T1");
    discordConnection = await connect(orgId, "discord", "G1");
    await connect(otherOrgId, "slack", "T2");
    handled = [];
    tasks = [];
    posts.length = 0;
    build();
  });

  afterEach(() => server.resetHandlers());

  afterAll(async () => {
    server.close();
    if (db) await closeDb(db);
    await container?.stop();
  });

  const threadMessages = async (externalThreadId: string) => {
    const [thread] = await db
      .select()
      .from(chatThreads)
      .where(eq(chatThreads.externalThreadId, externalThreadId));
    if (!thread) return null;
    const messages = await db
      .select({
        role: chatMessages.role,
        content: chatMessages.content,
        user: chatMessages.externalUserId,
      })
      .from(chatMessages)
      .where(eq(chatMessages.threadId, thread.id))
      .orderBy(asc(chatMessages.createdAt));
    return { thread, messages };
  };

  describe("Slack", () => {
    it("hands a mention from a connected workspace to the handler with its organization", async () => {
      const res = await slack(slackMention("T1"));
      expect(res.status).toBe(200);
      expect(handled).toHaveLength(1);
      const [turn] = handled;
      expect(turn!.threadId).toBe(`slack:C1:${MENTION_TS}`);
      expect(turn!.context.organizationId).toBe(orgId);
      expect(turn!.context.connection.id).toBe(slackConnection.id);
      expect(await state.isSubscribed(turn!.threadId)).toBe(true);
      const recorded = await threadMessages(turn!.threadId);
      expect(recorded?.thread).toMatchObject({
        organizationId: orgId,
        connectionId: slackConnection.id,
        platform: "slack",
        channelId: "slack:C1",
        startedByExternalUserId: "U1",
      });
      expect(recorded?.messages).toEqual([{ role: "user", content: MENTION_TEXT, user: "U1" }]);
      expect(turn!.context.chatThread.id).toBe(recorded!.thread.id);
    });

    it("resolves each workspace's own organization", async () => {
      await slack(slackMention("T2"));
      expect(handled.map((h) => h.context.organizationId)).toEqual([otherOrgId]);
    });

    it("ignores a mention from a workspace no organization has connected", async () => {
      const res = await slack(slackMention("T9"));
      expect(res.status).toBe(200);
      expect(handled).toEqual([]);
      expect(posts).toEqual([]);
      expect(await db.select().from(chatThreads)).toEqual([]);
    });

    it("rejects a bad signature before anything is handled", async () => {
      const res = await deliver(handleSlackWebhook, slackRequest(slackMention("T1"), "wrong"));
      expect(res.status).toBe(401);
      expect(handled).toEqual([]);
    });

    it("hands replies in a subscribed thread to the handler and ignores the bot's own", async () => {
      await slack(slackMention("T1"));
      await slack(slackReply("T1", "and the reviews?", "1700000001.000100"));
      await slack(slackReply("T1", "Here you go", "1700000002.000100", SLACK_BOT_USER));
      expect(handled.map((h) => [h.text, h.context.organizationId])).toEqual([
        [MENTION_TEXT, orgId],
        ["and the reviews?", orgId],
      ]);
      const recorded = await threadMessages(`slack:C1:${MENTION_TS}`);
      expect(recorded?.messages.map((m) => m.content)).toEqual([MENTION_TEXT, "and the reviews?"]);
    });

    it("ignores replies in threads the bot isn't part of", async () => {
      await slack(slackReply("T1", "unrelated", "1700000001.000100"));
      expect(handled).toEqual([]);
    });

    it("queues a burst of replies instead of dropping them", async () => {
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => (release = resolve));
      build({
        async handle(thread, message, context) {
          handled.push({ threadId: thread.id, text: message.text, context });
          if (handled.length === 1) await blocked;
        },
      });
      const first = handleSlackWebhook(slackRequest(slackMention("T1")), deps());
      await first;
      await vi.waitFor(() => expect(handled).toHaveLength(1));
      await handleSlackWebhook(slackRequest(slackReply("T1", "one", "1700000001.000100")), deps());
      await handleSlackWebhook(slackRequest(slackReply("T1", "two", "1700000002.000100")), deps());
      release();
      while (tasks.length > 0) await Promise.all(tasks.splice(0));
      expect(handled.map((h) => h.text)).toEqual([MENTION_TEXT, "two"]);
      expect(handled[1]!.context.skipped.map((m) => m.text)).toEqual(["one"]);
      const recorded = await threadMessages(`slack:C1:${MENTION_TS}`);
      expect(recorded?.messages.map((m) => m.content)).toEqual([MENTION_TEXT, "one", "two"]);
    });

    it("answers in the thread with the acknowledgement and records it", async () => {
      build(acknowledgementHandler(db));
      await slack(slackMention("T1"));
      expect(posts).toEqual([
        { platform: "slack", channel: "C1", text: ACKNOWLEDGEMENT, thread: MENTION_TS },
      ]);
      const recorded = await threadMessages(`slack:C1:${MENTION_TS}`);
      expect(recorded?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    });

    it.each([
      ["app_uninstalled", { type: "app_uninstalled" }],
      ["tokens_revoked", { type: "tokens_revoked", tokens: { bot: [SLACK_BOT_USER] } }],
    ])("deletes the connection on %s", async (_name, event) => {
      const res = await slack(slackEvent("T1", event));
      expect(res.status).toBe(200);
      expect(await getChatConnectionByExternalId(db, "slack", "T1")).toBeNull();
      expect(await getChatConnectionByExternalId(db, "slack", "T2")).not.toBeNull();
    });

    it("keeps the connection when only user tokens are revoked or the request is forged", async () => {
      await slack(slackEvent("T1", { type: "tokens_revoked", tokens: { oauth: ["U1"] } }));
      const forged = await deliver(
        handleSlackWebhook,
        slackRequest(slackEvent("T1", { type: "app_uninstalled" }), "wrong"),
      );
      expect(forged.status).toBe(401);
      expect(await getChatConnectionByExternalId(db, "slack", "T1")).not.toBeNull();
    });

    it("reads the workspace of an org-wide uninstall", () => {
      expect(
        slackUninstalledId({
          type: "event_callback",
          team_id: "T1",
          enterprise_id: "E1",
          is_enterprise_install: true,
          event: { type: "app_uninstalled" },
        }),
      ).toBe("E1");
      expect(slackUninstalledId({ type: "event_callback", event: { type: "app_mention" } })).toBe(
        null,
      );
    });
  });

  describe("Discord", () => {
    const THREAD = "discord:G1:CH1:thread-of-M1";

    it("hands a mention from a connected server to the handler with its organization", async () => {
      const res = await discord(
        discordMessage("G1", {
          id: "M1",
          channel: "CH1",
          content: `<@${DISCORD_APP_ID}> hi`,
          mention: true,
        }),
      );
      expect(res.status).toBe(200);
      expect(handled.map((h) => [h.threadId, h.context.organizationId])).toEqual([[THREAD, orgId]]);
      expect(handled[0]!.context.connection.id).toBe(discordConnection.id);
      expect(await state.isSubscribed(THREAD)).toBe(true);
      const recorded = await threadMessages(THREAD);
      expect(recorded?.thread).toMatchObject({ organizationId: orgId, platform: "discord" });
    });

    it("ignores a mention from a server no organization has connected and opens no thread", async () => {
      const res = await discord(
        discordMessage("G9", { id: "M1", channel: "CH1", content: "hi", mention: true }),
      );
      expect(res.status).toBe(200);
      expect(handled).toEqual([]);
      expect(posts).toEqual([]);
      expect(await db.select().from(chatThreads)).toEqual([]);
    });

    it("hands thread replies to the handler and ignores the bot's own", async () => {
      await discord(
        discordMessage("G1", {
          id: "M1",
          channel: "CH1",
          content: `<@${DISCORD_APP_ID}> hi`,
          mention: true,
        }),
      );
      await discord(discordMessage("G1", { id: "M2", channel: "thread-of-M1", content: "more" }));
      await discord(
        discordMessage("G1", {
          id: "M3",
          channel: "thread-of-M1",
          content: "Here you go",
          author: DISCORD_APP_ID,
        }),
      );
      expect(handled.map((h) => [h.threadId, h.text])).toEqual([
        [THREAD, `<@${DISCORD_APP_ID}> hi`],
        [THREAD, "more"],
      ]);
    });

    it("rejects a bad gateway token or interaction signature before anything is handled", async () => {
      const event = discordMessage("G1", {
        id: "M1",
        channel: "CH1",
        content: "hi",
        mention: true,
      });
      const forged = await deliver(handleDiscordWebhook, discordGatewayRequest(event, "wrong"));
      expect(forged.status).toBe(401);
      // Without the token it's treated as an interaction, whose signature is missing.
      const unsigned = new Request("https://omniralph.example.com/api/webhooks/discord", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      });
      expect((await deliver(handleDiscordWebhook, unsigned)).status).toBe(401);

      const body = JSON.stringify({ type: 1 });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const interaction = (signature: string) =>
        new Request("https://omniralph.example.com/api/webhooks/discord", {
          method: "POST",
          headers: { "x-signature-ed25519": signature, "x-signature-timestamp": timestamp },
          body,
        });
      const { sign } = await import("node:crypto");
      const valid = sign(null, Buffer.from(timestamp + body), discordPrivateKey).toString("hex");
      expect((await deliver(handleDiscordWebhook, interaction("00".repeat(64)))).status).toBe(401);
      expect((await deliver(handleDiscordWebhook, interaction(valid))).status).toBe(200);
      expect(handled).toEqual([]);
    });

    it("deletes the connection when the bot is removed from the server", async () => {
      await discord({
        type: "GATEWAY_GUILD_DELETE",
        timestamp: Date.now(),
        data: { id: "G1", unavailable: true },
      });
      expect(await getChatConnectionByExternalId(db, "discord", "G1")).not.toBeNull();
      await discord({ type: "GATEWAY_GUILD_DELETE", timestamp: Date.now(), data: { id: "G1" } });
      expect(await getChatConnectionByExternalId(db, "discord", "G1")).toBeNull();
    });
  });

  it("answers 503 not_configured for a platform without config", async () => {
    bot = createChatBot({
      db,
      slack: null,
      discord: null,
      state: createMockState(),
      handler: recordingHandler,
      logger: createMockLogger(),
    });
    for (const handle of [handleSlackWebhook, handleDiscordWebhook]) {
      const res = await handle(slackRequest(slackMention("T1")), deps());
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "not_configured" });
    }
  });
});
