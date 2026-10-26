import { randomBytes } from "node:crypto";
import { createMockAdapter, createMockState } from "@chat-adapter/tests";
import {
  chatMessages,
  closeDb,
  connectRepository,
  createDb,
  ensureChatThread,
  insertJob,
  listRunEvents,
  mapThreadRun,
  organizations,
  saveChatConnection,
  upsertScmConnection,
  type ChatThread,
  type Database,
  type Job,
} from "@omniralph/db";
import type { QueryRunResult, RunSpecJobPayload } from "@omniralph/shared";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import type { Adapter } from "chat";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatChannel } from "@/lib/ralph/conversation";
import { applyChatAnswer, chatThreadSink, onChatAnswerFailed } from "./chat-thread";
import { parseSinkResult, type SinkResult } from "./index";

vi.mock("server-only", () => ({}));

const databaseAvailable = testDatabaseAvailable();

const APP_URL = "https://omniralph.example.com";
const SLACK_THREAD = "slack:C1:1700000000.000100";

const answered: QueryRunResult = {
  outcome: "answered",
  structured: null,
  answer:
    "`last()` reads one past the end in `src/list.ts:2`. See [the docs](https://evil.example.com/x) and <img src=x>.",
  references: [
    { path: "src/list.ts", startLine: 2 },
    { path: "src/util.ts", startLine: 4, endLine: 9 },
  ],
  usage: { inputTokens: 100, outputTokens: 20 },
  durationMs: 5,
};

const sinkResult = (result: QueryRunResult): SinkResult<null> =>
  parseSinkResult(chatThreadSink, result)!;

describe("chatThreadSink", () => {
  it("takes a Markdown answer, not structured output", () => {
    expect(chatThreadSink.kind).toBe("chat-thread");
    expect(parseSinkResult(chatThreadSink, answered)).toEqual(answered);
    expect(parseSinkResult(chatThreadSink, { ...answered, answer: null })).toBeNull();
    expect(
      parseSinkResult(chatThreadSink, { ...answered, answer: null, structured: { rule: "x" } }),
    ).toBeNull();
  });
});

describe.skipIf(!databaseAvailable)("chat-thread sink", () => {
  const key = randomBytes(32);
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let repositoryId: string;
  let threads = 0;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
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
  }, 180_000);

  afterAll(async () => {
    await closeDb(db);
    await testDb?.stop();
  });

  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    return () => warn.mockRestore();
  });

  /** A Slack workspace with a thread. */
  async function slackThread(): Promise<ChatThread> {
    threads += 1;
    const connection = await saveChatConnection(
      db,
      {
        organizationId: orgId,
        platform: "slack",
        externalId: `T${threads}`,
        name: `Acme ${threads}`,
        credentials: { botToken: `xoxb-${threads}` },
        installedByUserId: null,
      },
      key,
    );
    if (connection === "other_organization") throw new Error("connected elsewhere");
    return (await ensureChatThread(db, {
      connectionId: connection.id,
      externalThreadId: SLACK_THREAD,
      channelId: "slack:C1",
      startedByExternalUserId: "U1",
    }))!;
  }

  /** A finished `builtin:ask-about-code` run for the thread, as `enqueueChatAsk` stores (and maps) it. */
  async function askJob(
    threadId: string,
    result: QueryRunResult | null,
    { mapped = true } = {},
  ): Promise<Job> {
    const payload: RunSpecJobPayload = {
      trigger: {
        kind: "chat.request",
        context: {
          repository: "acme/app",
          branch: "main",
          provider: "github",
          question: "Why does last() return undefined?",
          chatThreadId: threadId,
          chat: { context: null },
          budgetTokens: 12_000,
        },
      },
      repositoryId,
      ref: "main",
      requireCheckout: true,
    };
    const { job } = await insertJob(db, {
      organizationId: orgId,
      type: "chat.ask",
      taskType: "query",
      taskId: "builtin:ask-about-code",
      payload,
      repositoryId,
    });
    if (mapped) {
      await mapThreadRun(db, { organizationId: orgId, chatThreadId: threadId, jobId: job.id });
    }
    return { ...job, result, status: result ? "completed" : "failed" };
  }

  /** A mock Slack adapter that runs calls with the token it's handed (and records it). */
  function slackAdapter() {
    const tokens: string[] = [];
    let n = 0;
    const adapter = createMockAdapter("slack", {
      postMessage: vi.fn(async (threadId: string) => {
        n += 1;
        return { id: `ts-${n}`, threadId, raw: {} };
      }),
    });
    const withBotToken = vi.fn(
      <T>(token: string, fn: () => T, options?: { installationId?: string }): T => {
        tokens.push(`${token}@${options?.installationId}`);
        return fn();
      },
    );
    return { adapter: Object.assign(adapter, { withBotToken }) as Adapter, tokens };
  }

  function channel(adapter: Adapter): ChatChannel {
    return {
      db,
      adapters: { slack: adapter },
      state: createMockState(),
      appUrl: APP_URL,
      encryptionKey: key,
    };
  }

  const recorded = (threadId: string) =>
    db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.threadId, threadId))
      .orderBy(asc(chatMessages.createdAt));

  const events = (threadId: string) => listRunEvents(db, orgId, threadId);

  /** Nothing was posted in the thread, nor added to its history. */
  async function expectNothingPosted(adapter: Adapter, threadId: string) {
    expect(adapter.postMessage).not.toHaveBeenCalled();
    expect(adapter.editMessage).not.toHaveBeenCalled();
    expect(await recorded(threadId)).toEqual([]);
  }

  it("records the sanitized answer with links to the cited files as one response event, posting nothing", async () => {
    const thread = await slackThread();
    const job = await askJob(thread.id, answered);
    const { adapter } = slackAdapter();

    expect(await applyChatAnswer(db, job, sinkResult(answered), channel(adapter))).toBe(true);
    // A replayed result records no second event.
    expect(await applyChatAnswer(db, job, sinkResult(answered), channel(adapter))).toBe(false);

    await expectNothingPosted(adapter, thread.id);
    const recordedEvents = await events(thread.id);
    expect(recordedEvents).toHaveLength(1);
    const [event] = recordedEvents;
    expect(event).toMatchObject({
      kind: "response",
      idempotencyKey: `chat-run-event:job:${job.id}:response`,
      processedAt: null,
      attempts: 0,
      body: { outcome: "answered", repository: "acme/app" },
    });
    const text = (event!.body as { text: string }).text;
    expect(text).toContain("`last()` reads one past the end in `src/list.ts:2`.");
    // Links outside the control panel and the repository's code host aren't clickable; HTML is dropped.
    expect(text).toContain("See the docs (`https://evil.example.com/x`)");
    expect(text).not.toContain("<img");
    expect(text).toContain(
      "Files: [`src/list.ts:2`](<https://github.com/acme/app/blob/main/src/list.ts#L2>), " +
        "[`src/util.ts:4-9`](<https://github.com/acme/app/blob/main/src/util.ts#L4-L9>)",
    );
  });

  it("explains an answer without a result", async () => {
    const thread = await slackThread();
    const { adapter } = slackAdapter();
    const base = {
      usage: { inputTokens: 0, outputTokens: 0 },
      durationMs: 1,
      answer: null,
      structured: null,
      references: [],
    };
    for (const outcome of ["budget_exhausted", "no_checkout"] as const) {
      const result = { ...base, outcome };
      await applyChatAnswer(
        db,
        await askJob(thread.id, result),
        sinkResult(result),
        channel(adapter),
      );
    }
    await expectNothingPosted(adapter, thread.id);
    expect((await events(thread.id)).map((e) => [e.kind, e.body.outcome, e.body.text])).toEqual([
      [
        "response",
        "budget_exhausted",
        "Sorry, I couldn't finish an answer about `acme/app` within the token budget for code questions (12,000 tokens). Try a narrower question.",
      ],
      [
        "response",
        "no_checkout",
        "Sorry, I couldn't answer: `acme/app` has no `main` branch to read.",
      ],
    ]);
  });

  it("caps a long answer as today's code questions did", async () => {
    const thread = await slackThread();
    const { adapter } = slackAdapter();
    const long = { ...answered, answer: "x".repeat(10_000), references: [] };
    await applyChatAnswer(db, await askJob(thread.id, long), sinkResult(long), channel(adapter));
    const [event] = await events(thread.id);
    const text = (event!.body as { text: string }).text;
    expect(text.length).toBe(4000);
    expect(text).toMatch(/_…truncated_$/);
  });

  it("records one failure event when the job failed", async () => {
    const thread = await slackThread();
    const job = await askJob(thread.id, null);
    const { adapter } = slackAdapter();
    expect(await onChatAnswerFailed(db, job, channel(adapter), "agent lost")).toBe(true);
    expect(await onChatAnswerFailed(db, job, channel(adapter), "agent lost")).toBe(false);
    await expectNothingPosted(adapter, thread.id);
    expect((await events(thread.id)).map((e) => [e.kind, e.idempotencyKey, e.body])).toEqual([
      [
        "failure",
        `chat-run-event:job:${job.id}:failure`,
        {
          repository: "acme/app",
          error: "agent lost",
          text: "Sorry, I couldn't answer that question about `acme/app`; the job failed. Try asking again later.",
        },
      ],
    ]);
  });

  it("records nothing (logged) for a job that isn't mapped to the thread", async () => {
    const thread = await slackThread();
    const job = await askJob(thread.id, answered, { mapped: false });
    const { adapter } = slackAdapter();
    expect(await applyChatAnswer(db, job, sinkResult(answered), channel(adapter))).toBe(false);
    await expectNothingPosted(adapter, thread.id);
    expect(await events(thread.id)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("isn't mapped to thread"));
  });

  it("skips (logged) when the thread's platform has no adapter", async () => {
    const thread = await slackThread();
    const job = await askJob(thread.id, answered);
    expect(
      await applyChatAnswer(db, job, sinkResult(answered), {
        ...channel(slackAdapter().adapter),
        adapters: {},
      }),
    ).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("the thread or its chat connection is gone"),
    );
    expect(await recorded(thread.id)).toHaveLength(0);
    expect(await events(thread.id)).toEqual([]);
  });
});
