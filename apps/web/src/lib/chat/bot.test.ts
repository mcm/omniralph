import { createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import type { AttachmentTransport } from "@chat-adapter/slack";
import { createMockLogger, createMockState } from "@chat-adapter/tests";
import {
  chatIdentities,
  chatMessages,
  chatThreads,
  closeDb,
  createDb,
  getChatConnectionByExternalId,
  organizationMembers,
  organizations,
  saveChatConnection,
  users,
  type ChatConnection,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import type { Message, Thread } from "chat";
import { MockLanguageModelV2 } from "ai/test";
import { asc, eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatConversationContext, ChatConversationHandler } from "./bot";
import type { SlackCredentials } from "./slack-oauth";

vi.mock("server-only", () => ({}));
const ENCRYPTION_KEY = randomBytes(32).toString("base64");

const { createChatBot, requireMember, SENT_BY_DM_NOTE } = await import("./bot");
const { createChatAgentHandler } = await import("./agent/handler");
const {
  DISCORD_GATEWAY_TOKEN_HEADER,
  handleDiscordWebhook,
  handleSlackWebhook,
  slackUninstalledId,
} = await import("./webhooks");

const databaseAvailable = testDatabaseAvailable();

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

const ENV = {
  APP_URL: "https://omniralph.example.com",
  AUTH_SECRET: "test-auth-secret",
} as unknown as NodeJS.ProcessEnv;

// ── Fake Slack and Discord APIs ──────────────────────────────────────────────

const posts: Array<{
  platform: string;
  channel: string;
  text: string;
  thread?: string;
  /** Set for Slack ephemeral messages: who sees it. */
  ephemeralTo?: string;
}> = [];
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
      text: (body.get("text") ?? body.get("markdown_text"))!,
      thread: body.get("thread_ts") ?? undefined,
    });
    return HttpResponse.json({ ok: true, channel: body.get("channel"), ts: "1700000099.000100" });
  }),
  http.post("https://slack.com/api/chat.postEphemeral", async ({ request }) => {
    const body = new URLSearchParams(await request.text());
    posts.push({
      platform: "slack",
      channel: body.get("channel")!,
      text: body.get("text")!,
      thread: body.get("thread_ts") ?? undefined,
      ephemeralTo: body.get("user")!,
    });
    return HttpResponse.json({ ok: true, message_ts: "1700000098.000100" });
  }),
  http.post("https://slack.com/api/assistant.threads.setStatus", () =>
    HttpResponse.json({ ok: true }),
  ),
  http.post(
    "https://discord.com/api/v10/channels/:channel/typing",
    () => new HttpResponse(null, { status: 204 }),
  ),
  http.post(
    "https://discord.com/api/v10/channels/:channel/messages/:message/threads",
    ({ params }) =>
      HttpResponse.json({ id: `thread-of-${String(params.message)}`, parent_id: params.channel }),
  ),
  http.post("https://discord.com/api/v10/users/@me/channels", async ({ request }) => {
    const body = (await request.json()) as { recipient_id: string };
    return HttpResponse.json({ id: `dm-${body.recipient_id}`, type: 1 });
  }),
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

/**
 * Attachment downloads through `fetch`, so msw serves them: the adapters'
 * own transport resolves DNS itself, which msw doesn't intercept.
 */
const fetchFileTransport: AttachmentTransport = async (url, signal, headers) => {
  const res = await fetch(url, { signal, headers });
  const body = Readable.from([Buffer.from(await res.arrayBuffer())]) as IncomingMessage;
  return Object.assign(body, {
    statusCode: res.status,
    statusMessage: res.statusText,
    headers: Object.fromEntries(res.headers),
  });
};

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
  data: {
    id: string;
    channel: string;
    content: string;
    author?: string;
    mention?: boolean;
    attachments?: Array<Record<string, unknown>>;
  },
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
      attachments: data.attachments ?? [],
    },
  };
}

// ── Suite ────────────────────────────────────────────────────────────────────

interface Handled {
  threadId: string;
  text: string;
  context: ChatConversationContext;
}

describe.skipIf(!databaseAvailable)("chat bot webhooks", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let otherOrgId: string;
  let slackConnection: ChatConnection;
  let discordConnection: ChatConnection;
  let handled: Handled[];
  let tasks: Promise<unknown>[];
  let bot: ReturnType<typeof createChatBot>;
  let state: ReturnType<typeof createMockState>;
  let logger: ReturnType<typeof createMockLogger>;

  const recordingHandler: ChatConversationHandler = {
    async handle(thread: Thread, message: Message, context) {
      handled.push({ threadId: thread.id, text: message.text, context });
    },
  };

  const build = (handler: ChatConversationHandler = recordingHandler) => {
    state = createMockState();
    logger = createMockLogger();
    bot = createChatBot({
      db,
      slack: SLACK,
      discord: DISCORD,
      state,
      handler,
      logger,
      encryptionKey: ENCRYPTION_KEY,
      slackOptions: {
        webClientOptions: { retryConfig: { retries: 0 } },
        fileTransport: fetchFileTransport,
      },
      env: ENV,
    });
    // Discord takes no transport: its downloads go through `fetch` (msw) too.
    Object.assign(bot.adapters.discord!, {
      async downloadAttachment(url: string) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to fetch file: ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
      },
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
    testDb = await createTestDatabase();
    server.listen({ onUnhandledFrame: "error" });
    db = createDb(testDb.uri);
    const [org, other] = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Other" }])
      .returning();
    orgId = org!.id;
    otherOrgId = other!.id;
    await db.insert(users).values({ id: "ada", email: "ada@acme.test", name: "Ada" });
    await db.insert(organizationMembers).values({ organizationId: orgId, userId: "ada" });
  });

  beforeEach(async () => {
    await db.delete(chatIdentities);
    await db.execute("DELETE FROM chat_identity_opt_outs");
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
    await testDb?.stop();
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

    it("ignores direct messages to the bot, even from a connected workspace", async () => {
      const res = await slack(
        slackEvent("T1", {
          type: "message",
          channel_type: "im",
          user: "U1",
          text: "what is running?",
          ts: "1700000003.000100",
          channel: "D1",
        }),
      );
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

    it("answers in the thread with the control-panel agent and records it", async () => {
      const model = new MockLanguageModelV2({
        doGenerate: {
          content: [{ type: "text", text: "Nothing is running right now." }],
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          warnings: [],
        },
      });
      build(createChatAgentHandler({ db, model, tools: {}, env: ENV }));
      await slack(slackMention("T1"));
      expect(posts[0]).toEqual({
        platform: "slack",
        channel: "C1",
        text: "Nothing is running right now.",
        thread: MENTION_TS,
      });
      // U1 isn't linked: the link follows, only for them.
      expect(posts.slice(1)).toEqual([
        expect.objectContaining({ ephemeralTo: "U1", thread: MENTION_TS }),
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

  describe("attachments", () => {
    /** A tiny PNG (signature + IHDR start): enough for the type check. */
    const PNG = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    type CallOptions = Parameters<MockLanguageModelV2["doGenerate"]>[0];

    /** The control-panel agent with a model that records what it was sent. */
    function agentWithModel() {
      const calls: CallOptions[] = [];
      const model = new MockLanguageModelV2({
        doGenerate: async (options) => {
          calls.push(options);
          return {
            content: [{ type: "text", text: "I see it." }],
            finishReason: "stop",
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            warnings: [],
          };
        },
      });
      build(createChatAgentHandler({ db, model, tools: {}, env: ENV }));
      return calls;
    }

    /** The user messages' parts the model got in a call. */
    const userParts = (call: CallOptions) =>
      call.prompt.flatMap((m) =>
        m.role === "user"
          ? m.content.map((p) =>
              p.type === "text"
                ? { type: "text", text: p.text }
                : {
                    type: p.type,
                    mediaType: p.mediaType,
                    data: Buffer.from(p.data as Uint8Array),
                  },
            )
          : [],
      );

    const storedAttachments = async () =>
      (await db.select({ attachments: chatMessages.attachments }).from(chatMessages)).map(
        (r) => r.attachments,
      );

    it("passes a Slack image to the model, fetched with the bot token, and fetches it again on a later turn", async () => {
      const FILE = "https://files.slack.com/files-pri/T1-F1/shot.png";
      const auth: Array<string | null> = [];
      server.use(
        http.get(FILE, ({ request }) => {
          auth.push(request.headers.get("authorization"));
          return new HttpResponse(PNG, { headers: { "content-type": "image/png" } });
        }),
      );
      const calls = agentWithModel();
      await slack(
        slackEvent("T1", {
          type: "app_mention",
          user: "U1",
          text: `<@${SLACK_BOT_USER}> what is wrong here?`,
          ts: MENTION_TS,
          channel: "C1",
          files: [
            {
              id: "F1",
              name: "shot.png",
              mimetype: "image/png",
              size: PNG.length,
              url_private: FILE,
            },
          ],
        }),
      );

      expect(calls).toHaveLength(1);
      const parts = userParts(calls[0]!);
      expect(parts[0]).toMatchObject({ type: "text" });
      expect((parts[0] as { text: string }).text).toMatch(
        /\[attachment [0-9a-f]{8}-1: shot\.png \(image\/png, 16 B\) — image follows\]/,
      );
      expect(parts[1]).toEqual({ type: "file", mediaType: "image/png", data: PNG });
      // Only metadata is recorded, never the bytes.
      const [stored] = await storedAttachments();
      expect(stored).toEqual([
        {
          type: "image",
          name: "shot.png",
          mimeType: "image/png",
          size: PNG.length,
          url: FILE,
          fetchMetadata: expect.objectContaining({ url: FILE, teamId: "T1" }),
        },
      ]);
      expect(JSON.stringify(stored)).not.toContain(PNG.toString("base64"));

      // A later reply: the screenshot is fetched again from the stored metadata.
      await slack(slackReply("T1", "and now?", "1700000001.000100"));
      expect(calls).toHaveLength(2);
      expect(userParts(calls[1]!)).toContainEqual({
        type: "file",
        mediaType: "image/png",
        data: PNG,
      });
      expect(auth).toEqual(["Bearer xoxb-T1", "Bearer xoxb-T1"]);
    });

    it("passes a Discord text file and tells the model which files it skipped", async () => {
      const LOG = "https://cdn.discordapp.com/attachments/1/2/app.log";
      const MISSING = "https://cdn.discordapp.com/attachments/1/3/gone.png";
      server.use(
        http.get(LOG, () =>
          HttpResponse.text("Error: boom at login.ts:12", {
            headers: { "content-type": "text/plain" },
          }),
        ),
        http.get(MISSING, () => new HttpResponse(null, { status: 404 })),
      );
      const calls = agentWithModel();
      const file = (id: string, filename: string, contentType: string, size: number) => ({
        id,
        filename,
        content_type: contentType,
        size,
        url: `https://cdn.discordapp.com/attachments/1/${id}/${filename}`,
        proxy_url: `https://media.discordapp.net/attachments/1/${id}/${filename}`,
      });
      await discord(
        discordMessage("G1", {
          id: "M1",
          channel: "CH1",
          content: `<@${DISCORD_APP_ID}> why does login fail?`,
          mention: true,
          attachments: [
            file("2", "app.log", "text/plain; charset=utf-8", 26),
            file("3", "gone.png", "image/png", 100),
            file("4", "demo.mov", "video/quicktime", 1000),
            file("5", "huge.png", "image/png", 50 * 1024 * 1024),
          ],
        }),
      );

      expect(calls).toHaveLength(1);
      const parts = userParts(calls[0]!);
      const text = (parts[0] as { text: string }).text;
      expect(text).toContain("app.log (text, 26 B) — its text follows as a file]");
      expect(text).toContain("[attachment skipped: gone.png — couldn't be fetched]");
      expect(text).toContain("[attachment skipped: demo.mov — unsupported type (video/quicktime)]");
      expect(text).toContain(
        "[attachment skipped: huge.png — too large (50 MB; the limit is 5 MB)]",
      );
      expect(parts.slice(1)).toHaveLength(1);
      expect(parts[1]).toMatchObject({ type: "file", mediaType: "text/plain" });
      const fileText = (parts[1] as { data: Buffer }).data.toString("utf8");
      expect(fileText).toContain("<untrusted-chat-attachment>");
      expect(fileText).toContain("Error: boom at login.ts:12");
      expect((await storedAttachments())[0]).toHaveLength(4);
      // The turn itself was answered.
      expect(posts.map((p) => p.text)).toContain("I see it.");
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

    it("ignores direct messages to the bot and opens no thread", async () => {
      const dm = discordMessage("G1", {
        id: "M1",
        channel: "DM1",
        content: `<@${DISCORD_APP_ID}> hi`,
        mention: true,
      });
      const { guild_id: _guild, ...data } = dm.data;
      const res = await discord({ ...dm, data: { ...data, channel_type: 1 } });
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

  describe("identities", () => {
    /** Slack's `users.info` answering `email` for U1. */
    const slackEmail = (email: string) =>
      server.use(
        http.post("https://slack.com/api/users.info", async ({ request }) => {
          const user = new URLSearchParams(await request.text()).get("user");
          return HttpResponse.json({
            ok: true,
            user: {
              id: user,
              name: `user-${user}`,
              real_name: `User ${user}`,
              profile: user === "U1" ? { email } : {},
            },
          });
        }),
      );

    /** Records what `requireMember` returned for each message. */
    const requiring = (results: unknown[]): ChatConversationHandler => ({
      async handle(thread, message, context) {
        handled.push({ threadId: thread.id, text: message.text, context });
        results.push(await requireMember(context));
      },
    });

    it("links a Slack user with a member's email automatically and tells them once, privately", async () => {
      slackEmail("Ada@Acme.test");
      await slack(slackMention("T1"));
      expect(handled[0]!.context.actor).toEqual({
        kind: "member",
        userId: "ada",
        role: "member",
        name: "Ada",
        autoLinked: { email: "Ada@Acme.test" },
      });
      expect(posts).toEqual([
        {
          platform: "slack",
          channel: "C1",
          thread: MENTION_TS,
          ephemeralTo: "U1",
          text: expect.stringContaining(
            "because both use Ada@Acme.test. To unlink it, open https://omniralph.example.com/settings/linked-accounts",
          ),
        },
      ]);

      await slack(slackReply("T1", "and the reviews?", "1700000001.000100"));
      expect(handled[1]!.context.actor).toEqual({
        kind: "member",
        userId: "ada",
        role: "member",
        name: "Ada",
      });
      expect(posts).toHaveLength(1);
    });

    it("lets a linked member through requireMember without a prompt", async () => {
      slackEmail("ada@acme.test");
      const results: unknown[] = [];
      build(requiring(results));
      await slack(slackMention("T1"));
      expect(results).toEqual([expect.objectContaining({ kind: "member", userId: "ada" })]);
      // Only the auto-link note.
      expect(posts).toHaveLength(1);
    });

    it("sends an unlinked Slack user an ephemeral link prompt from requireMember", async () => {
      const results: unknown[] = [];
      build(requiring(results));
      await slack(slackMention("T1"));
      expect(handled[0]!.context.actor).toEqual({ kind: "unlinked" });
      expect(results).toEqual([null]);
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({ channel: "C1", thread: MENTION_TS, ephemeralTo: "U1" });
      const url = /https:\/\/\S+/.exec(posts[0]!.text)![0];
      expect(url.startsWith("https://omniralph.example.com/chat/link?state=")).toBe(true);
      const { readLinkState } = await import("./link");
      expect(await readLinkState(new URL(url).searchParams.get("state"), ENV)).toEqual({
        ok: true,
        state: {
          id: expect.any(String),
          expiresAt: expect.any(Date),
          organizationId: orgId,
          connectionId: slackConnection.id,
          platform: "slack",
          externalUserId: "U1",
          displayName: "User U1",
        },
      });
    });

    const discordMention = () =>
      discord(
        discordMessage("G1", {
          id: "M1",
          channel: "CH1",
          content: `<@${DISCORD_APP_ID}> hi`,
          mention: true,
        }),
      );

    it("DMs an unlinked Discord user the link prompt and only notes it in the thread", async () => {
      const results: unknown[] = [];
      build(requiring(results));
      await discordMention();
      expect(handled[0]!.context.actor).toEqual({ kind: "unlinked" });
      expect(results).toEqual([null]);
      expect(posts).toHaveLength(2);
      const [dm, note] = posts;
      expect(dm).toMatchObject({ platform: "discord", channel: "dm-D1" });
      expect(dm!.text).toMatch(
        /^To do that.*Link your Discord account .*https:\/\/omniralph\.example\.com\/chat\/link\?state=/,
      );
      expect(note).toEqual({
        platform: "discord",
        channel: "thread-of-M1",
        text: `<@D1> ${SENT_BY_DM_NOTE}`,
      });
      expect(note!.text).not.toContain("/chat/link");
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("falls back to the thread with a warning when the Discord DM fails", async () => {
      server.use(
        http.post("https://discord.com/api/v10/users/@me/channels", () =>
          HttpResponse.json(
            { message: "Cannot send messages to this user", code: 50007 },
            { status: 403 },
          ),
        ),
      );
      const results: unknown[] = [];
      build(requiring(results));
      await discordMention();
      expect(results).toEqual([null]);
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({ platform: "discord", channel: "thread-of-M1" });
      expect(posts[0]!.text).toMatch(
        /^<@D1> .*Link your Discord account .*https:\/\/omniralph\.example\.com\/chat\/link\?state=/,
      );
      expect(logger.warn).toHaveBeenCalledWith(
        "Couldn't DM a chat user: posting in the thread instead",
        expect.objectContaining({ threadId: expect.stringContaining("thread-of-M1") }),
      );
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
