import { randomBytes } from "node:crypto";
import { createMockLogger, createMockState } from "@chat-adapter/tests";
import {
  agents,
  appendWebMessage,
  chatThreadRuns,
  chatThreads,
  chatWebMessages,
  closeDb,
  connectRepository,
  createChatLinearIssueDraft,
  createChatRequestDraft,
  getChatLinearIssueDraft,
  getChatRequestDraft,
  getJob,
  insertRunActivity,
  jobs,
  createDb,
  createWebChatThread,
  disconnectRepository,
  ensureChatThread,
  organizationMembers,
  organizations,
  repositories,
  saveChatConnection,
  setRepositorySwitches,
  touchChatThread,
  upsertScmConnection,
  users,
  type ChatThread,
  type Database,
} from "@omniralph/db";
import type * as Changes from "@omniralph/db/changes";
import { QUERY_TASKS_MIN_AGENT_VERSION, type QueryRunResult } from "@omniralph/shared";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { MockLanguageModelV2, simulateReadableStream } from "ai/test";
import { Actions, Button, Card, CardText, type Logger } from "chat";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  askCardActionResponseSchema,
  askChatDetailSchema,
  askChatListSchema,
  askChatSchema,
  askMessageSchema,
  askRepositoryListSchema,
  type AskChatDetail,
  type AskChatList,
} from "@/lib/api/ask";
import type { RunList } from "@/lib/api/runs";
import { parseSseChunks, type AskStreamEvent } from "@/lib/ask/sse";
import { assertRole, type Role } from "@/lib/auth/roles";
import type * as Bot from "@/lib/chat/bot";
import type { RalphDeps } from "@/lib/ralph/run";
import type * as Adapters from "@/lib/scm/adapters";
import { FakeScmAdapter } from "@/lib/scm/fake-adapter";
import { fakeWorkItemTracker } from "@/lib/testing/work-item-tracker";

vi.mock("server-only", () => ({}));
// Called through, so a test can see the change events a route records.
vi.mock("@omniralph/db/changes", async (importOriginal) => {
  const actual = await importOriginal<typeof Changes>();
  return { ...actual, recordChange: vi.fn(actual.recordChange) };
});

type TestUser = { id: string; name: string | null; email: string | null };
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  user: null as TestUser | null,
  /** The user's active organization and role there. */
  orgId: "",
  role: "member" as Role,
  bot: undefined as unknown,
  scm: undefined as unknown as FakeScmAdapter,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") =>
    assertRole(
      state.user && {
        ...state.user,
        image: null,
        organization: { id: state.orgId, name: "Acme" },
        role: state.role,
      },
      role,
    ),
}));
vi.mock("@/lib/chat/bot", async (importOriginal) => ({
  ...(await importOriginal<typeof Bot>()),
  getChatBot: () => state.bot,
}));
vi.mock("@/lib/scm/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof Adapters>();
  return { ...actual, scmAdapterFor: () => state.scm.asAdapter() };
});

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const { recordChange } = await import("@omniralph/db/changes");
const { createChatBot } = await import("@/lib/chat/bot");
const { createChatAgentHandler } = await import("@/lib/chat/agent/handler");
const { draftCard } = await import("@/lib/chat/linear-issue");
const { webCardRef } = await import("@/lib/chat/web-adapter");
const chatsRoute = await import("./chats/route");
const chatRoute = await import("./chats/[id]/route");
const messagesRoute = await import("./chats/[id]/messages/route");
const actionsRoute = await import("./chats/[id]/actions/route");
const { requestDraftCard, requestDraftContext, requestDraftView } =
  await import("@/lib/chat/request-draft");
const repositoriesRoute = await import("./repositories/route");
const runsRoute = await import("../runs/route");
const { processThreadRunEvents } = await import("@/lib/chat/agent/wake");
const { applyChatAnswer, chatThreadSink } = await import("@/lib/sinks/chat-thread");
const { parseSinkResult } = await import("@/lib/sinks");

const databaseAvailable = testDatabaseAvailable();

const APP_URL = "https://omniralph.example.com";
const ENV = { APP_URL, AUTH_SECRET: "test-auth-secret" } as unknown as NodeJS.ProcessEnv;
const USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
type CallOptions = Parameters<MockLanguageModelV2["doGenerate"]>[0];
type StreamPart =
  Awaited<ReturnType<MockLanguageModelV2["doStream"]>>["stream"] extends ReadableStream<infer P>
    ? P
    : never;

const silent = {
  child: () => silent,
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

const ada: TestUser = { id: "ada", name: "Ada Lovelace", email: "ada@acme.test" };

/** A model streaming `pieces` as its answer (each after `delayMs`), keeping its calls. */
function streamingModel(pieces: string[], delayMs: number | null = null) {
  const calls: CallOptions[] = [];
  const parts: StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    ...pieces.map((delta): StreamPart => ({ type: "text-delta", id: "t1", delta })),
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: "stop", usage: USAGE },
  ];
  const model = new MockLanguageModelV2({
    doStream: async (call) => {
      calls.push(call);
      return { stream: simulateReadableStream({ chunks: parts, chunkDelayInMs: delayMs }) };
    },
  });
  return { model, calls };
}

/** The bot the routes use, answering with `model`. */
function useModel(model: MockLanguageModelV2) {
  state.bot = createChatBot({
    db: state.db,
    slack: null,
    discord: null,
    state: createMockState(),
    handler: createChatAgentHandler({ db: state.db, model, logger: silent, env: ENV }),
    logger: createMockLogger(),
    env: ENV,
  });
}

type Handler<P> = (request: Request, route: { params: Promise<P> }) => Promise<Response>;

async function request<P>(
  handler: Handler<P>,
  { body, params, search = {} }: { body?: unknown; params?: P; search?: Record<string, string> },
): Promise<Response> {
  return handler(
    new Request(`http://localhost/api/ui/ask?${new URLSearchParams(search)}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body !== undefined && {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    }),
    { params: Promise.resolve(params ?? ({} as P)) },
  );
}

async function json<T>(
  response: Response,
): Promise<{ status: number; body: T & { error?: string } }> {
  return { status: response.status, body: (await response.json()) as T & { error?: string } };
}

/** Every event of an event stream's body, read to its end (`onEvent` sees each as it comes). */
async function readEvents(
  response: Response,
  onEvent: (event: AskStreamEvent) => void = () => undefined,
): Promise<AskStreamEvent[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: AskStreamEvent[] = [];
  let buffer = "";
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    const parsed = parseSseChunks(buffer + decoder.decode(r.value, { stream: true }));
    for (const event of parsed.events) {
      events.push(event);
      onEvent(event);
    }
    buffer = parsed.rest;
  }
  return events;
}

const messageEvents = (events: AskStreamEvent[]) =>
  events.flatMap((e) => (e.event === "message" ? [askMessageSchema.parse(e.data.message)] : []));

describe.skipIf(!databaseAvailable)("/api/ui/ask", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  /** Ada is a member of it too (not active). */
  let secondOrgId: string;
  /** Neither Ada nor Bob is a member. */
  let strangerOrgId: string;
  let portalId: string;
  let askOffId: string;
  let goneId: string;
  let secondRepoId: string;
  let strangerRepoId: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    const [org, second, stranger] = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Beta" }, { name: "Stranger" }])
      .returning();
    orgId = org!.id;
    secondOrgId = second!.id;
    strangerOrgId = stranger!.id;
    await db.insert(users).values([
      { id: "ada", email: "ada@acme.test", name: "Ada Lovelace" },
      { id: "bob", email: "bob@acme.test", name: "Bob" },
      { id: "eve", email: "eve@stranger.test", name: "Eve" },
    ]);
    await db.insert(organizationMembers).values([
      { organizationId: orgId, userId: "ada" },
      { organizationId: orgId, userId: "bob" },
      { organizationId: secondOrgId, userId: "ada" },
      { organizationId: strangerOrgId, userId: "eve" },
    ]);
    const connect = async (organizationId: string, name: string, fullPaths: string[]) => {
      const connection = (await upsertScmConnection(db, {
        organizationId,
        provider: "github",
        name,
        baseUrl: "https://api.github.com",
        externalId: name,
        credentials: {},
      }))!;
      const ids: string[] = [];
      for (const [i, fullPath] of fullPaths.entries()) {
        const repo = await connectRepository(db, {
          connectionId: connection.id,
          provider: "github",
          externalId: `${name}-${i}`,
          fullPath,
        });
        ids.push(repo.id);
      }
      return ids;
    };
    [portalId, askOffId, goneId] = (await connect(orgId, "acme", [
      "acme/customer-portal",
      "acme/ask-off",
      "acme/gone",
    ])) as [string, string, string];
    await setRepositorySwitches(db, orgId, askOffId, { ask: false });
    await disconnectRepository(db, orgId, goneId);
    [secondRepoId] = (await connect(secondOrgId, "beta", ["beta/api"])) as [string];
    [strangerRepoId] = (await connect(strangerOrgId, "stranger", ["stranger/app"])) as [string];
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(() => {
    state.user = ada;
    state.orgId = orgId;
    state.role = "member";
    state.scm = new FakeScmAdapter();
    state.scm.defaultBranch = "release/2.0";
    useModel(streamingModel(["Hi!"]).model);
    vi.mocked(recordChange).mockClear();
  });

  /** A chat of `userId` in `organizationId`, straight in the database. */
  const chatOf = (
    userId: string,
    organizationId = orgId,
    repositoryId: string | null = null,
    title = "A chat",
  ) =>
    createWebChatThread(db, {
      organizationId,
      userId,
      repositoryId,
      branch: repositoryId ? "main" : null,
      title,
    });

  const threadRow = async (id: string) =>
    (await db.select().from(chatThreads).where(eq(chatThreads.id, id)))[0]!;

  const webRows = (threadId: string) =>
    db
      .select()
      .from(chatWebMessages)
      .where(eq(chatWebMessages.threadId, threadId))
      .orderBy(asc(chatWebMessages.createdAt));

  describe("POST /chats", () => {
    it("starts a chat about a repo and streams Om's reply, delta before done", async () => {
      const { model, calls } = streamingModel(["`last()` reads ", "one past the end."], 20);
      useModel(model);
      const text = "  Why does last() return undefined on the last page of customer results?  ";
      const response = await request(chatsRoute.POST, {
        body: { organizationId: orgId, repositoryId: portalId, text },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/);

      let doneSeen = false;
      let deltaBeforeDone = false;
      const events = await readEvents(response, (event) => {
        if (event.event === "delta" && !doneSeen) deltaBeforeDone = true;
        if (event.event === "done") doneSeen = true;
      });
      expect(deltaBeforeDone).toBe(true);
      expect(events[0]!.event).toBe("chat");
      expect(events.at(-1)).toEqual({ event: "done", data: {} });

      const chat = askChatSchema.parse((events[0]!.data as { chat: unknown }).chat);
      const thread = await threadRow(chat.id);
      expect(chat).toEqual({
        id: thread.id,
        title: "Why does last() return undefined on the last page of…",
        organization: { id: orgId, name: "Acme", role: "member" },
        repository: { id: portalId, provider: "github", fullPath: "acme/customer-portal" },
        branch: "release/2.0",
        updatedAt: expect.any(String),
      });
      expect(thread).toMatchObject({
        platform: "web",
        organizationId: orgId,
        startedByUserId: "ada",
        repositoryId: portalId,
        branch: "release/2.0",
      });
      expect(state.scm.calls).toEqual(["getDefaultBranch"]);

      const [user, om] = await webRows(thread.id);
      expect(user).toMatchObject({ author: "user", userId: "ada", markdown: text.trim() });
      expect(om).toMatchObject({
        author: "om",
        markdown: "`last()` reads one past the end.",
        status: "complete",
      });
      // Every message event carries the full message.
      const messages = messageEvents(events);
      expect(messages[0]).toEqual({
        id: user!.id,
        author: "user",
        markdown: text.trim(),
        status: "complete",
        createdAt: user!.createdAt.toISOString(),
        run: null,
        files: [],
        workItems: [],
        card: null,
      });
      expect(messages.at(-1)).toMatchObject({
        id: om!.id,
        markdown: "`last()` reads one past the end.",
        status: "complete",
      });
      expect(
        events.filter((e) => e.event === "delta").map((e) => (e.data as { text: string }).text),
      ).toEqual(["`last()` reads ", "one past the end."]);
      // The model knows the chat's repo and branch.
      const system = calls[0]!.prompt.find((m) => m.role === "system")!.content as string;
      expect(system).toContain("acme/customer-portal");
      expect(system).toContain("release/2.0");
      // The chat's change is recorded for Ada's own channel.
      expect(recordChange).toHaveBeenCalledWith(expect.anything(), {
        resource: "chat",
        ids: [thread.id],
        organizationId: orgId,
        userId: "ada",
      });
    });

    it("starts a chat about all of the organization's repos", async () => {
      const response = await request(chatsRoute.POST, {
        body: { organizationId: orgId, repositoryId: null, text: "What do our repos do?" },
      });
      const events = await readEvents(response);
      const chat = askChatSchema.parse((events[0]!.data as { chat: unknown }).chat);
      expect(chat).toMatchObject({
        title: "What do our repos do?",
        repository: null,
        branch: null,
      });
      expect(state.scm.calls).toEqual([]);
      expect(messageEvents(events).at(-1)).toMatchObject({ author: "om", markdown: "Hi!" });
    });

    it("starts a chat in another of the user's organizations", async () => {
      const response = await request(chatsRoute.POST, {
        body: { organizationId: secondOrgId, repositoryId: secondRepoId, text: "Hello" },
      });
      const events = await readEvents(response);
      const chat = askChatSchema.parse((events[0]!.data as { chat: unknown }).chat);
      expect(chat.organization).toEqual({ id: secondOrgId, name: "Beta", role: "member" });
      expect((await threadRow(chat.id)).organizationId).toBe(secondOrgId);
    });

    it("reads the stored default branch when the code host fails, and refuses without one", async () => {
      state.scm.failures.set("getDefaultBranch", "GitHub is down");
      await db
        .update(repositories)
        .set({ defaultBranch: null })
        .where(eq(repositories.id, portalId));
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const refused = await json(
        await request(chatsRoute.POST, {
          body: { organizationId: orgId, repositoryId: portalId, text: "Hi" },
        }),
      );
      expect(refused).toEqual({
        status: 502,
        body: {
          error: "Couldn't read the default branch of acme/customer-portal. Try again.",
          code: "default_branch_unavailable",
        },
      });
      errors.mockRestore();

      await db
        .update(repositories)
        .set({ defaultBranch: "trunk" })
        .where(eq(repositories.id, portalId));
      const events = await readEvents(
        await request(chatsRoute.POST, {
          body: { organizationId: orgId, repositoryId: portalId, text: "Hi" },
        }),
      );
      expect((events[0]!.data as { chat: { branch: string } }).chat.branch).toBe("trunk");
    });

    it("refuses a repo with Ask off or disconnected, and an empty or too long message", async () => {
      for (const repositoryId of [askOffId, goneId]) {
        const { status, body } = await json(
          await request(chatsRoute.POST, {
            body: { organizationId: orgId, repositoryId, text: "Hi" },
          }),
        );
        expect(status).toBe(400);
        expect(body).toMatchObject({ code: "repository_unavailable" });
      }
      for (const text of ["   ", "x".repeat(8_001)]) {
        const { status, body } = await json(
          await request(chatsRoute.POST, {
            body: { organizationId: orgId, repositoryId: null, text },
          }),
        );
        expect(status).toBe(400);
        expect(body).toMatchObject({ fieldErrors: { text: expect.any(String) } });
      }
      // 8,000 characters after trimming are fine.
      const ok = await request(chatsRoute.POST, {
        body: { organizationId: orgId, repositoryId: null, text: ` ${"x".repeat(8_000)} ` },
      });
      expect(ok.status).toBe(200);
      await readEvents(ok);
    });

    it("404s on an organization the user isn't a member of, and another organization's repo", async () => {
      const before = await db.select().from(chatThreads);
      for (const body of [
        { organizationId: strangerOrgId, repositoryId: null, text: "Hi" },
        { organizationId: strangerOrgId, repositoryId: strangerRepoId, text: "Hi" },
        { organizationId: orgId, repositoryId: strangerRepoId, text: "Hi" },
        { organizationId: orgId, repositoryId: secondRepoId, text: "Hi" },
      ]) {
        expect((await request(chatsRoute.POST, { body })).status, JSON.stringify(body)).toBe(404);
      }
      expect(await db.select().from(chatThreads)).toHaveLength(before.length);
    });
  });

  describe("GET /chats", () => {
    it("lists the caller's own web chats, newest activity first, page by page", async () => {
      state.user = { id: "carol", name: null, email: null };
      await db.insert(users).values({ id: "carol", email: "carol@acme.test" });
      await db.insert(organizationMembers).values({ organizationId: orgId, userId: "carol" });
      const older = await chatOf("carol", orgId, portalId, "Older");
      const newer = await chatOf("carol", orgId, null, "Newer");
      await chatOf("carol", orgId, null, "Third");
      // Another member's chat and a Slack thread of the organization never show.
      await chatOf("bob");
      const connection = await saveChatConnection(db, {
        organizationId: orgId,
        platform: "slack",
        externalId: "T1",
        name: "Acme Slack",
        credentials: { botToken: "xoxb" },
        installedByUserId: null,
      });
      if (connection === "other_organization") throw new Error("setup");
      await ensureChatThread(db, {
        connectionId: connection.id,
        externalThreadId: "slack:C1:1",
        channelId: "slack:C1",
        startedByExternalUserId: "carol",
      });
      // A new message brings a chat to the top.
      await touchChatThread(db, older.id, new Date(Date.now() + 60_000));

      const first = await json<AskChatList>(
        await request(chatsRoute.GET, { search: { limit: "2" } }),
      );
      expect(first.status).toBe(200);
      const page = askChatListSchema.parse(first.body);
      expect(page.chats.map((c) => c.title)).toEqual(["Older", "Third"]);
      expect(page.chats[0]).toMatchObject({
        id: older.id,
        repository: { id: portalId, provider: "github", fullPath: "acme/customer-portal" },
        branch: "main",
        organization: { id: orgId, name: "Acme", role: "member" },
      });
      expect(page.nextCursor).toEqual(expect.any(String));
      const second = askChatListSchema.parse(
        (
          await json<AskChatList>(
            await request(chatsRoute.GET, { search: { limit: "2", cursor: page.nextCursor! } }),
          )
        ).body,
      );
      expect(second.chats.map((c) => c.id)).toEqual([newer.id]);
      expect(second.nextCursor).toBeNull();
    });

    it("covers one of the user's organizations or all of them, and 404s on another", async () => {
      const own = await chatOf("ada", orgId);
      const elsewhere = await chatOf("ada", secondOrgId);
      const list = async (search: Record<string, string>) =>
        askChatListSchema
          .parse((await json<AskChatList>(await request(chatsRoute.GET, { search }))).body)
          .chats.map((c) => c.id);

      expect(await list({})).toContain(own.id);
      expect(await list({})).not.toContain(elsewhere.id);
      expect(await list({ organization: secondOrgId })).toContain(elsewhere.id);
      expect(await list({ organization: secondOrgId })).not.toContain(own.id);
      const all = await list({ organization: "all" });
      expect(all).toEqual(expect.arrayContaining([own.id, elsewhere.id]));
      expect(
        (await request(chatsRoute.GET, { search: { organization: strangerOrgId } })).status,
      ).toBe(404);
    });

    it("refuses an invalid cursor or limit", async () => {
      const invalid: Record<string, string>[] = [
        { cursor: "nope" },
        { limit: "0" },
        { limit: "101" },
      ];
      for (const search of invalid) {
        expect((await request(chatsRoute.GET, { search })).status, JSON.stringify(search)).toBe(
          400,
        );
      }
    });
  });

  describe("GET /chats/{id}", () => {
    const detail = async (id: string, search: Record<string, string> = {}) =>
      json<AskChatDetail>(await request(chatRoute.GET, { params: { id }, search }));

    it("shows the chat with its messages, oldest first, and no activity", async () => {
      const thread = await chatOf("ada", orgId, portalId, "Why?");
      const question = (await appendWebMessage(db, {
        threadId: thread.id,
        author: "user",
        userId: "ada",
        markdown: "Why?",
      }))!;
      const answer = (await appendWebMessage(db, {
        threadId: thread.id,
        author: "om",
        markdown: "Because.",
      }))!;

      const { status, body } = await detail(thread.id);
      expect(status).toBe(200);
      const parsed = askChatDetailSchema.parse(body);
      expect(parsed.chat).toMatchObject({ id: thread.id, title: "Why?", branch: "main" });
      expect(parsed.messages.map((m) => [m.id, m.author, m.markdown])).toEqual([
        [question.id, "user", "Why?"],
        [answer.id, "om", "Because."],
      ]);
      expect(parsed.activity).toBeNull();
      expect(parsed.nextBefore).toBeNull();
    });

    it("pages back with before", async () => {
      const thread = await chatOf("ada");
      for (let i = 0; i < 102; i += 1) {
        await appendWebMessage(db, { threadId: thread.id, author: "om", markdown: `#${i}` });
      }
      const latest = askChatDetailSchema.parse((await detail(thread.id)).body);
      expect(latest.messages).toHaveLength(100);
      expect(latest.messages[0]!.markdown).toBe("#2");
      expect(latest.messages.at(-1)!.markdown).toBe("#101");
      expect(latest.nextBefore).toBe(latest.messages[0]!.id);
      const older = askChatDetailSchema.parse(
        (await detail(thread.id, { before: latest.nextBefore! })).body,
      );
      expect(older.messages.map((m) => m.markdown)).toEqual(["#0", "#1"]);
      expect(older.nextBefore).toBeNull();
      expect((await detail(thread.id, { before: "nope" })).status).toBe(400);
    });

    it("shows a Linear issue draft's card in its current state, and any other card as is", async () => {
      const thread = await chatOf("ada");
      const draft = await createChatLinearIssueDraft(db, {
        threadId: thread.id,
        requestedByUserId: "ada",
        requestedByExternalUserId: "ada",
        teamId: "team-1",
        teamKey: "ENG",
        title: "Fix the login bug",
        description: "Users can't log in.",
        labels: ["bug"],
        priority: 2,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const card = draftCard(draft);
      const drafted = (await appendWebMessage(db, {
        threadId: thread.id,
        author: "om",
        markdown: "New Linear issue",
        card,
        cardRef: webCardRef(card),
      }))!;
      const expired = await createChatLinearIssueDraft(db, {
        threadId: thread.id,
        requestedByUserId: "ada",
        requestedByExternalUserId: "ada",
        teamId: "team-1",
        teamKey: "ENG",
        title: "Old",
        description: "",
        expiresAt: new Date(Date.now() - 1),
      });
      const expiredCard = draftCard(expired);
      await appendWebMessage(db, {
        threadId: thread.id,
        author: "om",
        markdown: "New Linear issue: Old",
        card: expiredCard,
        cardRef: webCardRef(expiredCard),
      });
      await appendWebMessage(db, {
        threadId: thread.id,
        author: "om",
        markdown: "**Pick one**",
        card: Card({
          title: "Pick one",
          children: [
            CardText("Which?"),
            Actions([Button({ id: "pick", label: "This", value: "1" })]),
          ],
        }),
      });

      const { messages } = askChatDetailSchema.parse((await detail(thread.id)).body);
      expect(messages[0]!.id).toBe(drafted.id);
      expect(messages.map((m) => m.card)).toEqual([
        {
          kind: "linear_issue_draft",
          draft: {
            id: draft.id,
            status: "pending",
            title: "Fix the login bug",
            team: "ENG",
            project: null,
            labels: ["bug"],
            priority: "High",
            description: "Users can't log in.",
            screenshots: [],
            issue: null,
            actions: [
              { id: "linear_issue_create", label: "Create", value: draft.id },
              { id: "linear_issue_create_delegate", label: "Create and delegate", value: draft.id },
              { id: "linear_issue_cancel", label: "Cancel", value: draft.id },
            ],
          },
        },
        {
          kind: "linear_issue_draft",
          draft: expect.objectContaining({ id: expired.id, status: "expired", actions: [] }),
        },
        {
          kind: "generic",
          title: "Pick one",
          text: "Which?",
          actions: [{ id: "pick", label: "This", value: "1" }],
        },
      ]);
    });

    it("404s on another member's chat, a Slack thread, an unknown ID, and after leaving", async () => {
      const bobs = await chatOf("bob");
      const elsewhere = await chatOf("ada", secondOrgId);
      const [slack] = await db
        .select()
        .from(chatThreads)
        .where(and(eq(chatThreads.platform, "slack")))
        .limit(1);
      expect((await detail(bobs.id)).status).toBe(404);
      if (slack) expect((await detail(slack.id)).status).toBe(404);
      expect((await detail("00000000-0000-4000-8000-000000000000")).status).toBe(404);
      expect((await detail("nope")).status).toBe(404);

      expect((await detail(elsewhere.id)).status).toBe(200);
      await db
        .delete(organizationMembers)
        .where(
          and(
            eq(organizationMembers.organizationId, secondOrgId),
            eq(organizationMembers.userId, "ada"),
          ),
        );
      try {
        expect((await detail(elsewhere.id)).status).toBe(404);
        expect(
          (
            await request(messagesRoute.POST, {
              params: { id: elsewhere.id },
              body: { text: "Still there?" },
            })
          ).status,
        ).toBe(404);
      } finally {
        await db.insert(organizationMembers).values({ organizationId: secondOrgId, userId: "ada" });
      }
    });
    it("follows a code question to Runs as kind ask and back as Om's answer, with what it read", async () => {
      const thread = await chatOf("ada", orgId, portalId, "Why does last() fail?");
      // An agent online that can take code questions.
      await db.insert(agents).values({
        organizationId: orgId,
        name: "acme-agent",
        reportedVersion: QUERY_TASKS_MIN_AGENT_VERSION,
        lastHeartbeatAt: new Date(),
        liveOnline: true,
      });
      // Om asks an agent about the chat's repo, then says so.
      const steps: StreamPart[][] = [
        [
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "ask_about_code",
            input: JSON.stringify({
              repository: "acme/customer-portal",
              question: "Why does last() return undefined on the last page?",
            }),
          },
          { type: "finish", finishReason: "tool-calls", usage: USAGE },
        ],
        [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "I asked an agent to read the code." },
          { type: "text-end", id: "t1" },
          { type: "finish", finishReason: "stop", usage: USAGE },
        ],
      ];
      let step = 0;
      useModel(
        new MockLanguageModelV2({
          doStream: async () => ({
            stream: simulateReadableStream({ chunks: steps[Math.min(step++, 1)]! }),
          }),
        }),
      );
      const events = await readEvents(
        await request(messagesRoute.POST, {
          params: { id: thread.id },
          body: { text: "Why does last() return undefined on the last page?" },
        }),
      );
      expect(events).toContainEqual({
        event: "status",
        data: { text: "Asking an agent to read customer-portal" },
      });
      expect(events.at(-1)!.event).toBe("done");

      const [threadRun] = await db
        .select()
        .from(chatThreadRuns)
        .where(eq(chatThreadRuns.chatThreadId, thread.id));
      const job = (await getJob(db, threadRun!.jobId!))!;
      expect(job).toMatchObject({ type: "chat.ask", repositoryId: portalId });
      const repository = { id: portalId, provider: "github", fullPath: "acme/customer-portal" };

      // Queued: the chat shows Om waiting for an agent.
      const queued = askChatDetailSchema.parse((await detail(thread.id)).body);
      expect(queued.activity).toEqual({
        state: "queued",
        repository,
        filesRead: 0,
        runIds: [threadRun!.id],
      });

      // Every member sees it in Runs as an ask, not only the one who asked.
      state.user = { id: "bob", name: "Bob", email: "bob@acme.test" };
      const runs = await json<RunList>(await request(runsRoute.GET, { search: { kind: "ask" } }));
      state.user = ada;
      expect(runs.status).toBe(200);
      expect(runs.body.runs.find((r) => r.id === threadRun!.id)).toMatchObject({ kind: "ask" });

      // Running: the files count follows the agent's reads.
      await db
        .update(jobs)
        .set({ status: "running", startedAt: new Date("2026-10-27T12:00:00Z") })
        .where(eq(jobs.id, job.id));
      for (const parameter of ["src/list.ts", "src/util.ts", "src/list.ts"]) {
        await insertRunActivity(db, {
          jobId: job.id,
          organizationId: orgId,
          type: "action",
          body: "Read",
          parameter,
        });
      }
      const running = askChatDetailSchema.parse((await detail(thread.id)).body);
      expect(running.activity).toEqual({
        state: "running",
        repository,
        filesRead: 2,
        runIds: [threadRun!.id],
      });

      // Answered: the answer is relayed as Om's message, with its run, reads and cited files.
      const result: QueryRunResult = {
        outcome: "answered",
        answer: "`last()` reads one past the end.",
        structured: null,
        references: [{ path: "src/list.ts", startLine: 2, endLine: 9 }],
        usage: { inputTokens: 10, outputTokens: 5 },
        durationMs: 41_000,
      };
      await db
        .update(jobs)
        .set({ status: "completed", finishedAt: new Date("2026-10-27T12:05:00Z"), result })
        .where(eq(jobs.id, job.id));
      const finished = (await getJob(db, job.id))!;
      const bot = state.bot as ReturnType<typeof createChatBot>;
      const channel = {
        db,
        adapters: bot.adapters,
        state: bot.state,
        appUrl: APP_URL,
        encryptionKey: Buffer.from(process.env.ENCRYPTION_KEY!, "base64"),
      };
      expect(
        await applyChatAnswer(
          db,
          finished,
          parseSinkResult(chatThreadSink, finished.result)!,
          channel,
        ),
      ).toBe(true);
      expect(
        await processThreadRunEvents(
          {
            db,
            model: null,
            channel,
            logger: silent,
            rateLimits: {
              wakePerOrganization: () => ({
                key: `test:wake:${randomBytes(8).toString("hex")}`,
                limit: 100,
                windowSeconds: 60,
              }),
            },
          },
          thread.id,
        ),
      ).toMatchObject({ status: "processed", posted: 1 });

      const answered = askChatDetailSchema.parse((await detail(thread.id)).body);
      expect(answered.activity).toBeNull();
      expect(answered.messages.at(-1)).toMatchObject({
        author: "om",
        markdown: "`last()` reads one past the end.",
        status: "complete",
        run: { id: threadRun!.id, status: "completed", durationMs: 41_000, filesRead: 2 },
        files: [
          {
            path: "src/list.ts",
            startLine: 2,
            endLine: 9,
            url: "https://github.com/acme/customer-portal/blob/main/src/list.ts#L2-L9",
          },
        ],
      });
    });
  });

  describe("POST /chats/{id}/messages", () => {
    it("sends a follow-up and streams Om's reply, with the chat's history", async () => {
      const thread: Pick<ChatThread, "id"> = (
        await readEvents(
          await request(chatsRoute.POST, {
            body: { organizationId: orgId, repositoryId: portalId, text: "First question" },
          }),
        )
      ).flatMap((e) => (e.event === "chat" ? [e.data.chat as { id: string }] : []))[0]!;
      const { model, calls } = streamingModel(["Second ", "answer"], 10);
      useModel(model);

      const response = await request(messagesRoute.POST, {
        params: { id: thread.id },
        body: { text: "  Follow-up  " },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/^text\/event-stream/);
      const events = await readEvents(response);
      expect(events.some((e) => e.event === "chat")).toBe(false);
      expect(events.at(-1)!.event).toBe("done");
      expect(messageEvents(events)[0]).toMatchObject({ author: "user", markdown: "Follow-up" });
      expect(messageEvents(events).at(-1)).toMatchObject({
        author: "om",
        markdown: "Second answer",
        status: "complete",
      });
      expect((await webRows(thread.id)).map((r) => [r.author, r.markdown])).toEqual([
        ["user", "First question"],
        ["om", "Hi!"],
        ["user", "Follow-up"],
        ["om", "Second answer"],
      ]);
      const prompt = JSON.stringify(calls[0]!.prompt);
      expect(prompt).toContain("First question");
      expect(prompt).toContain("Follow-up");
      // The title stays the first message's.
      expect((await threadRow(thread.id)).title).toBe("First question");
    });

    it("refuses an empty message, and 404s on another member's chat", async () => {
      const own = await chatOf("ada");
      const empty = await json(
        await request(messagesRoute.POST, { params: { id: own.id }, body: { text: " " } }),
      );
      expect(empty.status).toBe(400);
      const bobs = await chatOf("bob");
      expect(
        (await request(messagesRoute.POST, { params: { id: bobs.id }, body: { text: "Hi" } }))
          .status,
      ).toBe(404);
      expect(await webRows(bobs.id)).toEqual([]);
    });
  });

  describe("GET /repositories", () => {
    const list = async (search: Record<string, string> = {}) =>
      json(await request(repositoriesRoute.GET, { search }));

    it("offers the scope's connected repos with Ask on, each with its organization", async () => {
      const active = askRepositoryListSchema.parse((await list()).body);
      expect(active.repositories).toEqual([
        {
          id: portalId,
          provider: "github",
          fullPath: "acme/customer-portal",
          organization: { id: orgId, name: "Acme", role: "member" },
        },
      ]);
      const all = askRepositoryListSchema.parse((await list({ organization: "all" })).body);
      expect(all.repositories.map((r) => [r.organization.name, r.fullPath])).toEqual([
        ["Acme", "acme/customer-portal"],
        ["Beta", "beta/api"],
      ]);
      expect((await list({ organization: strangerOrgId })).status).toBe(404);
    });
  });

  describe("POST /chats/{id}/actions", () => {
    let linear: ReturnType<typeof fakeWorkItemTracker>;

    beforeAll(() => {
      // The web's request cards link runs on the deployment's URL.
      vi.stubEnv("APP_URL", APP_URL);
    });

    beforeEach(() => {
      linear = fakeWorkItemTracker({ teams: [{ id: "team-1", key: "ENG", name: "Engineering" }] });
      state.bot = createChatBot({
        db,
        slack: null,
        discord: null,
        state: createMockState(),
        handler: { handle: async () => undefined },
        logger: createMockLogger(),
        env: ENV,
        tracker: async () => linear.tracker,
        ralph: async (organizationId) => ({ db, organizationId }) as unknown as RalphDeps,
      });
    });

    const act = (chatId: string, body: unknown) =>
      request(actionsRoute.POST, { body, params: { id: chatId } });

    /** A request draft of Ada's in `thread`, its card posted as the web adapter stores it. */
    async function requestCard(thread: ChatThread) {
      const draft = await createChatRequestDraft(db, {
        organizationId: orgId,
        threadId: thread.id,
        requestedByUserId: "ada",
        requestedByExternalUserId: "ada",
        repositoryId: portalId,
        title: "Retry webhooks on 5xx",
        request: "Retry failed webhook deliveries.",
        expiresAt: new Date(Date.now() + 60_000),
      });
      const view = requestDraftView(
        draft,
        await requestDraftContext(db, draft, { platform: "web", appUrl: APP_URL }),
      );
      const card = requestDraftCard(view);
      const message = (await appendWebMessage(db, {
        threadId: thread.id,
        author: "om",
        markdown: view.title,
        card,
        cardRef: webCardRef(card),
      }))!;
      return { draft, message };
    }

    /** A Linear issue draft of Ada's in `thread`, its card posted as the web adapter stores it. */
    async function linearCard(thread: ChatThread) {
      const draft = await createChatLinearIssueDraft(db, {
        threadId: thread.id,
        requestedByUserId: "ada",
        requestedByExternalUserId: "ada",
        teamId: "team-1",
        teamKey: "ENG",
        title: "Fix the login bug",
        description: "Users can't log in.",
        expiresAt: new Date(Date.now() + 60_000),
      });
      const card = draftCard(draft);
      const message = (await appendWebMessage(db, {
        threadId: thread.id,
        author: "om",
        markdown: "New Linear issue",
        card,
        cardRef: webCardRef(card),
      }))!;
      return { draft, message };
    }

    const chatChanges = (thread: ChatThread) =>
      vi
        .mocked(recordChange)
        .mock.calls.filter(
          ([, change]) =>
            (change as { resource: string }).resource === "chat" &&
            (change as { ids: readonly string[] }).ids[0] === thread.id,
        );

    it("dismisses a drafted request with Not now and returns the updated message", async () => {
      const thread = await chatOf("ada", orgId, portalId);
      const { draft, message } = await requestCard(thread);

      const response = await json(
        await act(thread.id, {
          messageId: message.id,
          actionId: "request_draft_dismiss",
          value: draft.id,
        }),
      );

      expect(response.status).toBe(200);
      const { message: updated } = askCardActionResponseSchema.parse(response.body);
      expect(updated).toMatchObject({
        id: message.id,
        card: {
          kind: "request_draft",
          draft: {
            id: draft.id,
            status: "dismissed",
            triageChoice: "inline",
            actions: [],
            outcome: { kind: "dismissed", text: "Not now" },
          },
        },
      });
      expect((await getChatRequestDraft(db, draft.id))!.status).toBe("dismissed");
      expect(chatChanges(thread).length).toBeGreaterThan(0);
    });

    it("shows why Start request was refused, keeping the buttons", async () => {
      const thread = await chatOf("ada", orgId, portalId);
      const { draft, message } = await requestCard(thread);

      const response = await json(
        await act(thread.id, { messageId: message.id, actionId: "request_draft_start" }),
      );

      const { message: updated } = askCardActionResponseSchema.parse(response.body);
      expect(updated.card).toMatchObject({
        kind: "request_draft",
        draft: {
          status: "pending",
          error: "Coding is off for customer-portal.",
          actions: [
            expect.objectContaining({ label: "Start request" }),
            expect.objectContaining({ label: "Not now" }),
          ],
        },
      });
      expect((await getChatRequestDraft(db, draft.id))!.status).toBe("pending");
    });

    it("creates and cancels Linear issue drafts", async () => {
      const thread = await chatOf("ada");
      const created = await linearCard(thread);
      const response = await json(
        await act(thread.id, {
          messageId: created.message.id,
          actionId: "linear_issue_create",
          value: created.draft.id,
        }),
      );
      expect(response.status).toBe(200);
      const [issue] = [...linear.workspace.issues.values()];
      expect(issue).toMatchObject({ teamId: "team-1", title: "Fix the login bug" });
      expect(askCardActionResponseSchema.parse(response.body).message.card).toMatchObject({
        kind: "linear_issue_draft",
        draft: { status: "created", issue: { identifier: issue!.identifier }, actions: [] },
      });

      const cancelled = await linearCard(thread);
      const cancel = await json(
        await act(thread.id, {
          messageId: cancelled.message.id,
          actionId: "linear_issue_cancel",
          value: cancelled.draft.id,
        }),
      );
      expect(askCardActionResponseSchema.parse(cancel.body).message.card).toMatchObject({
        kind: "linear_issue_draft",
        draft: { status: "cancelled", actions: [] },
      });
      expect((await getChatLinearIssueDraft(db, cancelled.draft.id))!.status).toBe("cancelled");
      expect(linear.workspace.issues.size).toBe(1);
    });

    it("404s on another member's chat and a message of another chat; 400s on a button the card hasn't", async () => {
      const thread = await chatOf("ada", orgId, portalId);
      const { draft, message } = await requestCard(thread);
      const other = await chatOf("ada", orgId, portalId);
      const dismiss = { messageId: message.id, actionId: "request_draft_dismiss", value: draft.id };

      state.user = { id: "bob", name: "Bob", email: "bob@acme.test" };
      expect((await act(thread.id, dismiss)).status).toBe(404);
      state.user = ada;
      expect((await act(other.id, dismiss)).status).toBe(404);
      const unknown = await json(
        await act(thread.id, { messageId: message.id, actionId: "pick", value: draft.id }),
      );
      expect(unknown).toMatchObject({
        status: 400,
        body: { error: "That card has no such button anymore." },
      });
      expect((await act(thread.id, { messageId: "nope", actionId: "x" })).status).toBe(400);
      expect((await getChatRequestDraft(db, draft.id))!.status).toBe("pending");
    });
  });
});
