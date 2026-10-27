import { randomBytes, randomUUID } from "node:crypto";
import { createMockLogger, createMockState } from "@chat-adapter/tests";
import {
  chatMessages,
  chatWebMessages,
  closeDb,
  connectRepository,
  createDb,
  createRun,
  createWebChatThread,
  ensureWebChatConnection,
  getWebMessage,
  listRunEvents,
  organizationMembers,
  organizations,
  upsertScmConnection,
  users,
  type ChatThread,
  type ChatWebMessage,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { MockLanguageModelV2 } from "ai/test";
import { Actions, Button, Card, CardText, type Logger, type Message, type Thread } from "chat";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChangeMessage } from "@/lib/live/publisher";
import type { RateLimit } from "@/lib/rate-limit";
import type { ChatConversationContext, ChatConversationHandler } from "./bot";

vi.mock("server-only", () => ({}));

const {
  createWebAdapter,
  decodeWebThreadId,
  encodeWebThreadId,
  handleWebMessage,
  webCardRef,
  webChatConnection,
  webMessageContent,
} = await import("./web-adapter");
const { cancelledCard, draftCard, LINEAR_ISSUE_ACTIONS } = await import("./linear-issue");
const { createChatBot } = await import("./bot");
const { createChatAgentHandler } = await import("./agent/handler");
const { processThreadRunEvents } = await import("./agent/wake");
const { linkedMemberActor, resolveChatActor } = await import("./identity");
const { recordChatRunEvent } = await import("./run-events");
const { loadChatTarget } = await import("@/lib/ralph/conversation");
const { withLiveChanges } = await import("@/lib/live/request");

const databaseAvailable = testDatabaseAvailable();

const ORG = "11111111-1111-4111-8111-111111111111";
const CHAT = "22222222-2222-4222-8222-222222222222";
const APP_URL = "https://omniralph.example.com";
const ENV = { APP_URL, AUTH_SECRET: "test-auth-secret" } as unknown as NodeJS.ProcessEnv;
const USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
type CallOptions = Parameters<MockLanguageModelV2["doGenerate"]>[0];

const silent = {
  child: () => silent,
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

const linearDraft = {
  id: "33333333-3333-4333-8333-333333333333",
  teamKey: "ENG",
  title: "Fix the login bug",
  description: "Users can't log in.",
  projectName: null,
  labels: [],
  priority: null,
  attachments: [],
  linearIssueIdentifier: null,
  linearIssueUrl: null,
};

/** A model answering `text` and keeping what it was called with. */
function mockModel(text: string) {
  const calls: CallOptions[] = [];
  const model = new MockLanguageModelV2({
    doGenerate: async (options) => {
      calls.push(options);
      return {
        content: [{ type: "text", text }],
        finishReason: "stop",
        usage: USAGE,
        warnings: [],
      };
    },
  });
  return { model, calls };
}

/** The system prompt of a model call. */
const systemOf = (options: CallOptions) =>
  options.prompt
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");

/** Runs `fn` as a request whose change events go to a fake publisher; returns what it published. */
async function published<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; messages: ChangeMessage[] }> {
  const messages: ChangeMessage[] = [];
  const work: Promise<void>[] = [];
  const result = await withLiveChanges(fn, {
    publisher: { publish: async (batch) => void messages.push(...batch) },
    schedule: (task) => void work.push(task()),
  });
  await Promise.all(work);
  return { result, messages };
}

describe("web thread IDs", () => {
  it("encodes and decodes web:{organizationId}:{threadId}", () => {
    const id = encodeWebThreadId({ organizationId: ORG, threadId: CHAT });
    expect(id).toBe(`web:${ORG}:${CHAT}`);
    expect(decodeWebThreadId(id)).toEqual({ organizationId: ORG, threadId: CHAT });
  });

  it("decodes nothing else", () => {
    for (const id of [
      `slack:${ORG}:${CHAT}`,
      `web:${ORG}`,
      `web:${ORG}:${CHAT}:extra`,
      `web:acme:${CHAT}`,
      `web:${ORG}:not-a-chat`,
      "",
    ]) {
      expect(decodeWebThreadId(id), id).toBeNull();
    }
  });
});

describe("webCardRef", () => {
  it("is the Linear issue draft of a card whose buttons are LINEAR_ISSUE_ACTIONS", () => {
    expect(webCardRef(draftCard(linearDraft))).toEqual({
      kind: "linear_issue_draft",
      draftId: linearDraft.id,
    });
  });

  it("is null for any other card", () => {
    expect(webCardRef(Card({ title: "Hello", children: [CardText("Plain")] }))).toBeNull();
    expect(
      webCardRef(
        Card({ children: [Actions([Button({ id: "something_else", label: "Go", value: "x" })])] }),
      ),
    ).toBeNull();
    // A Linear draft's card once cancelled has no buttons left.
    expect(webCardRef(cancelledCard(linearDraft))).toBeNull();
    expect(LINEAR_ISSUE_ACTIONS).toHaveLength(3);
  });
});

describe("webMessageContent", () => {
  it("stores text as Markdown and a card with its fallback text", () => {
    expect(webMessageContent("Hi")).toEqual({ markdown: "Hi", card: null });
    expect(webMessageContent({ markdown: "**Hi**" })).toEqual({ markdown: "**Hi**", card: null });
    expect(webMessageContent({ raw: "raw" })).toEqual({ markdown: "raw", card: null });
    const card = Card({ title: "Title", children: [CardText("Body")] });
    expect(webMessageContent(card)).toEqual({ markdown: "**Title**\nBody", card });
    expect(webMessageContent({ card, fallbackText: "Fallback" })).toEqual({
      markdown: "Fallback",
      card,
    });
  });
});

describe.skipIf(!databaseAvailable)("the web chat adapter", () => {
  const key = randomBytes(32);
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let otherOrgId: string;
  let repositoryId: string;
  let adapter: ReturnType<typeof createWebAdapter>;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org, other] = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Other" }])
      .returning();
    orgId = org!.id;
    otherOrgId = other!.id;
    await db.insert(users).values([
      { id: "ada", email: "ada@acme.test", name: "Ada Lovelace" },
      { id: "bob", email: "bob@acme.test", name: "Bob" },
      { id: "eve", email: "eve@evil.test", name: "Eve" },
    ]);
    await db.insert(organizationMembers).values([
      { organizationId: orgId, userId: "ada", role: "admin" },
      { organizationId: orgId, userId: "bob" },
      { organizationId: otherOrgId, userId: "eve" },
    ]);
    const scm = (await upsertScmConnection(
      db,
      {
        organizationId: orgId,
        provider: "github",
        name: "acme",
        baseUrl: "https://api.github.com",
        externalId: "1",
        credentials: {},
      },
      key,
    ))!;
    repositoryId = (
      await connectRepository(db, {
        connectionId: scm.id,
        provider: "github",
        externalId: "1",
        fullPath: "acme/app",
      })
    ).id;
    adapter = createWebAdapter({ db });
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  const newChat = (userId = "ada", organizationId = orgId): Promise<ChatThread> =>
    createWebChatThread(db, {
      organizationId,
      userId,
      repositoryId: organizationId === orgId ? repositoryId : null,
      branch: organizationId === orgId ? "main" : null,
      title: "Why does last() fail?",
    });

  const rows = (threadId: string) =>
    db
      .select()
      .from(chatWebMessages)
      .where(eq(chatWebMessages.threadId, threadId))
      .orderBy(asc(chatWebMessages.createdAt));

  /** The `chat` event a write of `thread` publishes, on its owner's channel only. */
  const chatEvent = (thread: ChatThread) => ({
    channel: `user:${thread.startedByUserId}:changes`,
    event: {
      v: 1,
      resource: "chat",
      ids: [thread.id],
      organizationId: thread.organizationId,
      at: expect.any(String),
    },
  });

  describe("Adapter", () => {
    it("is named web, locks per thread and derives the organization's channel", () => {
      expect(adapter.name).toBe("web");
      expect(adapter.lockScope).toBe("thread");
      expect(adapter.channelIdFromThreadId(`web:${ORG}:${CHAT}`)).toBe(`web:${ORG}`);
      expect(adapter.decodeThreadId(`web:${ORG}:${CHAT}`)).toEqual({
        organizationId: ORG,
        threadId: CHAT,
      });
      expect(() => adapter.decodeThreadId("slack:C1:1")).toThrow();
    });

    it("postMessage stores an om row and publishes the chat event on its owner's channel", async () => {
      const thread = await newChat();
      const { result: posted, messages } = await published(() =>
        adapter.postMessage(thread.externalThreadId, { markdown: "The answer is **forty-two**." }),
      );
      const [row] = await rows(thread.id);
      expect(row).toMatchObject({
        id: posted.id,
        author: "om",
        markdown: "The answer is **forty-two**.",
        status: "complete",
        card: null,
        cardRef: null,
        organizationId: orgId,
      });
      expect(posted.threadId).toBe(thread.externalThreadId);
      expect(messages).toEqual([chatEvent(thread)]);
      // IDs only: never the message, and never the organization's channel.
      expect(JSON.stringify(messages)).not.toContain("forty-two");
      expect(messages.map((m) => m.channel)).not.toContain(`org:${orgId}:changes`);
    });

    it("postMessage stores a card serialized, with its card_ref", async () => {
      const thread = await newChat();
      const card = draftCard(linearDraft);
      await adapter.postMessage(thread.externalThreadId, card);
      const [row] = await rows(thread.id);
      expect(row!.card).toEqual(JSON.parse(JSON.stringify(card)));
      expect(row!.cardRef).toEqual({ kind: "linear_issue_draft", draftId: linearDraft.id });
      expect(row!.markdown).toContain("New Linear issue: Fix the login bug");
    });

    it("editMessage updates the row, keeping the draft its card was for", async () => {
      const thread = await newChat();
      const posted = await adapter.postMessage(thread.externalThreadId, draftCard(linearDraft));
      const { messages } = await published(() =>
        adapter.editMessage(thread.externalThreadId, posted.id, cancelledCard(linearDraft)),
      );
      const row = (await getWebMessage(db, posted.id))!;
      expect(row.card).toEqual(JSON.parse(JSON.stringify(cancelledCard(linearDraft))));
      expect(row.cardRef).toEqual({ kind: "linear_issue_draft", draftId: linearDraft.id });
      expect(messages).toEqual([chatEvent(thread)]);

      await adapter.editMessage(thread.externalThreadId, posted.id, { markdown: "Done." });
      expect(await getWebMessage(db, posted.id)).toMatchObject({
        markdown: "Done.",
        card: null,
        cardRef: null,
        status: "complete",
      });
    });

    it("deleteMessage removes the row and publishes", async () => {
      const thread = await newChat();
      const posted = await adapter.postMessage(thread.externalThreadId, "Oops");
      const { messages } = await published(() =>
        adapter.deleteMessage(thread.externalThreadId, posted.id),
      );
      expect(await rows(thread.id)).toEqual([]);
      expect(messages).toEqual([chatEvent(thread)]);
    });

    it("refuses a message of another chat, and a thread ID naming another organization", async () => {
      const thread = await newChat();
      const other = await newChat();
      const posted = await adapter.postMessage(other.externalThreadId, "Theirs");
      await expect(
        adapter.editMessage(thread.externalThreadId, posted.id, "Mine now"),
      ).rejects.toThrow();
      await expect(adapter.deleteMessage(thread.externalThreadId, posted.id)).rejects.toThrow();
      expect((await getWebMessage(db, posted.id))!.markdown).toBe("Theirs");
      await expect(
        adapter.postMessage(`web:${otherOrgId}:${thread.id}`, "Elsewhere"),
      ).rejects.toThrow();
      expect(await rows(thread.id)).toEqual([]);
    });

    it("postEphemeral stores an ordinary row", async () => {
      const thread = await newChat();
      const sent = await adapter.postEphemeral!(thread.externalThreadId, "ada", "Only you", {
        fallbackToDM: false,
      });
      expect(sent).toMatchObject({ threadId: thread.externalThreadId, usedFallback: false });
      const [row] = await rows(thread.id);
      expect(row).toMatchObject({ id: sent!.id, author: "om", markdown: "Only you" });
    });

    it("fetchMessages returns the thread's rows oldest first, paginating backward", async () => {
      const thread = await newChat();
      for (const text of ["one", "two", "three"]) {
        await adapter.postMessage(thread.externalThreadId, text);
      }
      const all = await adapter.fetchMessages(thread.externalThreadId);
      expect(all.messages.map((m) => m.text)).toEqual(["one", "two", "three"]);
      expect(all.messages[0]!.author).toMatchObject({ isMe: true, isBot: true });
      expect(all.nextCursor).toBeUndefined();

      const latest = await adapter.fetchMessages(thread.externalThreadId, { limit: 2 });
      expect(latest.messages.map((m) => m.text)).toEqual(["two", "three"]);
      const older = await adapter.fetchMessages(thread.externalThreadId, {
        limit: 2,
        cursor: latest.nextCursor,
      });
      expect(older.messages.map((m) => m.text)).toEqual(["one"]);

      const forward = await adapter.fetchMessages(thread.externalThreadId, {
        limit: 2,
        direction: "forward",
      });
      expect(forward.messages.map((m) => m.text)).toEqual(["one", "two"]);
      const next = await adapter.fetchMessages(thread.externalThreadId, {
        limit: 2,
        direction: "forward",
        cursor: forward.nextCursor,
      });
      expect(next.messages.map((m) => m.text)).toEqual(["three"]);
    });

    it("fetchThread describes the chat", async () => {
      const thread = await newChat();
      expect(await adapter.fetchThread(thread.externalThreadId)).toEqual({
        id: thread.externalThreadId,
        channelId: `web:${orgId}`,
        channelName: "Why does last() fail?",
        isDM: false,
        metadata: { title: "Why does last() fail?", repositoryId, branch: "main" },
      });
    });

    it("parseMessage reads a stored row as a mention by its member", async () => {
      const thread = await newChat();
      const [row] = await db
        .insert(chatWebMessages)
        .values({
          organizationId: orgId,
          threadId: thread.id,
          author: "user",
          userId: "ada",
          markdown: "What does `last()` do?",
        })
        .returning();
      const message = adapter.parseMessage(row as ChatWebMessage);
      expect(message).toMatchObject({
        id: row!.id,
        threadId: thread.externalThreadId,
        text: "What does last() do?",
        isMention: true,
        author: { userId: "ada", isMe: false, isBot: false },
      });
    });

    it("does nothing for reactions", async () => {
      const thread = await newChat();
      const posted = await adapter.postMessage(thread.externalThreadId, "Hi");
      const { messages } = await published(async () => {
        await adapter.addReaction(thread.externalThreadId, posted.id, "thumbs_up");
        await adapter.removeReaction(thread.externalThreadId, posted.id, "thumbs_up");
      });
      expect(messages).toEqual([]);
      expect((await rows(thread.id)).map((r) => r.markdown)).toEqual(["Hi"]);
    });

    it("answers 404 to a webhook", async () => {
      const res = await adapter.handleWebhook(
        new Request(`${APP_URL}/api/webhooks/web`, { method: "POST", body: "{}" }),
      );
      expect(res.status).toBe(404);
    });
  });

  describe("on the bot", () => {
    const handlerRecording = () => {
      const handled: ChatConversationContext[] = [];
      const handler: ChatConversationHandler = {
        async handle(_thread: Thread, _message: Message, context) {
          handled.push(context);
        },
      };
      return { handled, handler };
    };

    const bot = (handler: ChatConversationHandler) =>
      createChatBot({
        db,
        slack: null,
        discord: null,
        state: createMockState(),
        handler,
        logger: createMockLogger(),
        env: ENV,
      });

    it("registers the web adapter without any config", () => {
      const { adapters } = bot(handlerRecording().handler);
      expect(Object.keys(adapters)).toEqual(["web"]);
      expect(adapters.web!.name).toBe("web");
    });

    it("resolves a web thread to its organization's web connection", async () => {
      const thread = await newChat();
      const connection = await ensureWebChatConnection(db, orgId);
      expect(await webChatConnection(db, thread.externalThreadId)).toEqual(connection);
      // An ID naming another organization than the chat's, or no chat, resolves to nothing.
      await ensureWebChatConnection(db, otherOrgId);
      expect(await webChatConnection(db, `web:${otherOrgId}:${thread.id}`)).toBeNull();
      expect(await webChatConnection(db, `web:${orgId}:${randomUUID()}`)).toBeNull();
      expect(await webChatConnection(db, "web:nope")).toBeNull();
    });

    it("hands a member's message to the handler with the web connection and actor", async () => {
      const thread = await newChat();
      const { handled, handler } = handlerRecording();
      const built = bot(handler);
      const { result: row, messages } = await published(() =>
        handleWebMessage(
          { db, bot: built },
          { thread, user: { id: "ada", name: "Ada Lovelace" }, text: "Why does last() fail?" },
        ),
      );
      expect(row).toMatchObject({
        author: "user",
        userId: "ada",
        markdown: "Why does last() fail?",
      });
      expect(handled).toHaveLength(1);
      const [context] = handled;
      expect(context!.organizationId).toBe(orgId);
      expect(context!.connection).toEqual(await ensureWebChatConnection(db, orgId));
      expect(context!.chatThread.id).toBe(thread.id);
      expect(context!.actor).toMatchObject({ kind: "member", userId: "ada", role: "admin" });
      expect(context!.message.author.fullName).toBe("Ada Lovelace");
      expect(messages).toEqual([chatEvent(thread)]);
    });

    it("ignores a message whose thread ID names another organization", async () => {
      const thread = await newChat();
      const { handled, handler } = handlerRecording();
      const built = bot(handler);
      const forged = { ...thread, externalThreadId: `web:${otherOrgId}:${thread.id}` };
      await handleWebMessage(
        { db, bot: built },
        { thread: forged, user: { id: "ada", name: "Ada" }, text: "Hello?" },
      );
      expect(handled).toEqual([]);
      const recorded = await db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.threadId, thread.id));
      expect(recorded).toEqual([]);
    });

    it("refuses a message from anyone but the chat's starter", async () => {
      const thread = await newChat();
      const built = bot(handlerRecording().handler);
      await expect(
        handleWebMessage(
          { db, bot: built },
          { thread, user: { id: "bob", name: "Bob" }, text: "Let me in" },
        ),
      ).rejects.toThrow();
      expect(await rows(thread.id)).toEqual([]);
    });
  });

  describe("resolveChatActor for web", () => {
    it("is the member (with role) whose user ID is the external user ID, else unlinked", async () => {
      const connection = await ensureWebChatConnection(db, orgId);
      const actor = (externalUserId: string) =>
        resolveChatActor(
          { db },
          { organizationId: orgId, connection, platform: "web", externalUserId },
        );
      expect(await actor("ada")).toEqual({
        kind: "member",
        userId: "ada",
        role: "admin",
        name: "Ada Lovelace",
      });
      expect(await actor("bob")).toMatchObject({ kind: "member", userId: "bob", role: "member" });
      // A member of another organization, or nobody at all.
      expect(await actor("eve")).toEqual({ kind: "unlinked" });
      expect(await actor("nobody")).toEqual({ kind: "unlinked" });
      expect(await linkedMemberActor(db, orgId, "web", "ada")).toMatchObject({ userId: "ada" });
      expect(await linkedMemberActor(db, orgId, "web", "eve")).toBeNull();
    });

    it("is unlinked for a removed member", async () => {
      await db.insert(users).values({ id: "gone", email: "gone@acme.test", name: "Gone" });
      await db.insert(organizationMembers).values({ organizationId: orgId, userId: "gone" });
      const connection = await ensureWebChatConnection(db, orgId);
      const input = { organizationId: orgId, connection, platform: "web" as const };
      expect(await resolveChatActor({ db }, { ...input, externalUserId: "gone" })).toMatchObject({
        kind: "member",
      });
      await db
        .delete(organizationMembers)
        .where(
          and(
            eq(organizationMembers.organizationId, orgId),
            eq(organizationMembers.userId, "gone"),
          ),
        );
      expect(await resolveChatActor({ db }, { ...input, externalUserId: "gone" })).toEqual({
        kind: "unlinked",
      });
      expect(await linkedMemberActor(db, orgId, "web", "gone")).toBeNull();
    });
  });

  describe("the control-panel agent in a web chat", () => {
    it("records the message, stores Om's reply and rate-limits per web user", async () => {
      const thread = await newChat();
      const { model, calls } = mockModel("`last()` reads one past the end.");
      const perChatUser = vi.fn(
        (organizationId: string, platform: string, userId: string): RateLimit => ({
          key: `test:chat:${organizationId}:${platform}:${userId}:${randomUUID()}`,
          limit: 10,
          windowSeconds: 60,
        }),
      );
      const perOrganization = (organizationId: string): RateLimit => ({
        key: `test:org:${organizationId}:${randomUUID()}`,
        limit: 10,
        windowSeconds: 60,
      });
      const built = createChatBot({
        db,
        slack: null,
        discord: null,
        state: createMockState(),
        handler: createChatAgentHandler({
          db,
          model,
          logger: silent,
          env: ENV,
          rateLimits: { perChatUser, perOrganization },
        }),
        logger: createMockLogger(),
        env: ENV,
      });

      const { messages } = await published(() =>
        handleWebMessage(
          { db, bot: built },
          { thread, user: { id: "ada", name: "Ada Lovelace" }, text: "Why does last() fail?" },
        ),
      );

      expect(perChatUser).toHaveBeenCalledWith(orgId, "web", "ada");
      const recorded = await db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.threadId, thread.id))
        .orderBy(asc(chatMessages.createdAt));
      expect(recorded.map((m) => [m.role, m.externalUserId])).toEqual([
        ["user", "ada"],
        ["assistant", null],
      ]);
      expect(recorded[0]!.content).toBe("Why does last() fail?");
      expect(recorded[0]!.authorName).toBe("Ada Lovelace");
      expect((await rows(thread.id)).map((r) => [r.author, r.markdown])).toEqual([
        ["user", "Why does last() fail?"],
        ["om", "`last()` reads one past the end."],
      ]);
      expect(calls).toHaveLength(1);
      const system = systemOf(calls[0]!);
      expect(system).toContain("in Omniralph");
      expect(system).toContain("about the repository acme/app (branch main)");
      // The user's message and Om's reply each published the chat's change.
      expect(messages).toEqual([chatEvent(thread)]);
      expect(messages[0]!.event.ids).toEqual([thread.id]);
    });
  });

  describe("wake-ups", () => {
    it("relays a chat coding run's completion through the web adapter, holding the thread's lock", async () => {
      const thread = await newChat();
      const state = createMockState();
      const built = createChatBot({
        db,
        slack: null,
        discord: null,
        state,
        handler: { handle: async () => undefined },
        logger: createMockLogger(),
        env: ENV,
      });
      const channel = { db, adapters: built.adapters, state, appUrl: APP_URL, encryptionKey: key };
      const { run } = await createRun(db, {
        origin: "chat",
        organizationId: orgId,
        chatThreadId: thread.id,
        repositoryId,
        branch: "omniralph/chat-web",
        baseBranch: "main",
      });
      const target = (await loadChatTarget(channel, {
        chatThreadId: thread.id,
        organizationId: orgId,
        repositoryId,
      }))!;
      expect(target.adapter.name).toBe("web");
      expect(
        await recordChatRunEvent(target, {
          organizationId: orgId,
          run: { ralphRunId: run.id },
          kind: "completion",
          body: { text: "The run finished: it fixed last()." },
          key: "completion",
        }),
      ).toBe(true);
      const acquireLock = vi.spyOn(state, "acquireLock");
      const { model, calls } = mockModel("The coding run finished: `last()` is fixed.");

      const { result, messages } = await published(() =>
        processThreadRunEvents(
          {
            db,
            model,
            channel,
            logger: silent,
            rateLimits: {
              wakePerOrganization: (): RateLimit => ({
                key: `test:wake:${randomUUID()}`,
                limit: 100,
                windowSeconds: 60,
              }),
            },
          },
          thread.id,
        ),
      );

      expect(result).toEqual({ status: "processed", events: 1, posted: 1 });
      expect(acquireLock).toHaveBeenCalledWith(thread.externalThreadId, expect.any(Number));
      expect((await rows(thread.id)).map((r) => [r.author, r.markdown])).toEqual([
        ["om", "The coding run finished: `last()` is fixed."],
      ]);
      expect(messages).toEqual([chatEvent(thread)]);
      expect(await listRunEvents(db, orgId, thread.id, { pending: true })).toEqual([]);
      // The turn acts for the chat's starter, a member, in the chat's scope.
      const system = systemOf(calls[0]!);
      expect(system).toContain("a linked member of the organization (role: admin)");
      expect(system).toContain("about the repository acme/app (branch main)");
    });

    it("leaves the events pending while a turn holds the thread's lock", async () => {
      const thread = await newChat();
      const state = createMockState();
      const built = createChatBot({
        db,
        slack: null,
        discord: null,
        state,
        handler: { handle: async () => undefined },
        logger: createMockLogger(),
        env: ENV,
      });
      const channel = { db, adapters: built.adapters, state, appUrl: APP_URL, encryptionKey: key };
      const { run } = await createRun(db, {
        origin: "chat",
        organizationId: orgId,
        chatThreadId: thread.id,
        repositoryId,
        branch: "omniralph/chat-web-2",
        baseBranch: "main",
      });
      const target = (await loadChatTarget(channel, {
        chatThreadId: thread.id,
        organizationId: orgId,
        repositoryId,
      }))!;
      await recordChatRunEvent(target, {
        organizationId: orgId,
        run: { ralphRunId: run.id },
        kind: "completion",
        body: { text: "Done." },
        key: "completion",
      });
      const lock = await state.acquireLock(thread.externalThreadId, 30_000);
      expect(lock).not.toBeNull();
      const { model } = mockModel("Done.");
      expect(
        await processThreadRunEvents({ db, model, channel, logger: silent }, thread.id),
      ).toEqual({ status: "locked" });
      expect(await rows(thread.id)).toEqual([]);
    });
  });
});
