import { randomBytes } from "node:crypto";
import { createMockAdapter, createMockState } from "@chat-adapter/tests";
import {
  chatMessages,
  closeDb,
  connectRepository,
  createDb,
  ensureChatThread,
  insertJob,
  organizations,
  runMigrations,
  saveChatConnection,
  seedReviewProfiles,
  upsertScmConnection,
  type ChatThread,
  type Database,
  type Job,
} from "@omniralph/db";
import type { ChatAskJobPayload, ChatAskJobResult } from "@omniralph/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Adapter } from "chat";
import { asc, eq } from "drizzle-orm";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatChannel } from "@/lib/ralph/conversation";
import { onChatAskJobCompleted, onChatAskJobFailed, parseChatAskResult } from "./ask";

vi.mock("server-only", () => ({}));

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

const APP_URL = "https://omniralph.example.com";
const SLACK_THREAD = "slack:C1:1700000000.000100";

const answered: ChatAskJobResult = {
  outcome: "answered",
  answer:
    "`last()` reads one past the end in `src/list.ts:2`. See [the docs](https://evil.example.com/x) and <img src=x>.",
  references: [
    { path: "src/list.ts", startLine: 2 },
    { path: "src/util.ts", startLine: 4, endLine: 9 },
  ],
  usage: { inputTokens: 100, outputTokens: 20 },
  durationMs: 5,
};

describe("parseChatAskResult", () => {
  it("accepts results of the shared schema only", () => {
    expect(parseChatAskResult(answered)).toEqual(answered);
    expect(parseChatAskResult({ ...answered, answer: null })).toBeNull();
  });
});

describe.skipIf(!dockerAvailable)("chat.ask outcomes", () => {
  const key = randomBytes(32);
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let orgId: string;
  let repositoryId: string;
  let threads = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
    await seedReviewProfiles(db, orgId);
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
    await container?.stop();
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

  /** A finished `chat.ask` job for the thread. */
  async function askJob(threadId: string, result: ChatAskJobResult | null): Promise<Job> {
    const payload: ChatAskJobPayload = {
      repositoryId,
      repository: {
        provider: "github",
        fullPath: "acme/app",
        cloneUrl: "https://github.com/acme/app.git",
      },
      defaultBranch: "main",
      question: "Why does last() return undefined?",
      context: null,
      chatThreadId: threadId,
      model: null,
      maxTokens: 12_000,
    };
    const { job } = await insertJob(db, {
      organizationId: orgId,
      capability: "review",
      type: "chat.ask",
      payload,
      repositoryId,
    });
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

  it("posts the sanitized answer with links to the cited files, once, and records it", async () => {
    const thread = await slackThread();
    const job = await askJob(thread.id, answered);
    const { adapter, tokens } = slackAdapter();

    expect(await onChatAskJobCompleted(db, job, channel(adapter))).toBe(true);
    // A replayed result doesn't post again.
    expect(await onChatAskJobCompleted(db, job, channel(adapter))).toBe(false);

    expect(adapter.postMessage).toHaveBeenCalledOnce();
    const [threadId, message] = vi.mocked(adapter.postMessage).mock.calls[0]!;
    expect(threadId).toBe(SLACK_THREAD);
    const markdown = (message as { markdown: string }).markdown;
    expect(markdown).toContain("`last()` reads one past the end in `src/list.ts:2`.");
    // Links outside the control panel and the repository's code host aren't clickable; HTML is dropped.
    expect(markdown).toContain("See the docs (`https://evil.example.com/x`)");
    expect(markdown).not.toContain("<img");
    expect(markdown).toContain(
      "Files: [`src/list.ts:2`](<https://github.com/acme/app/blob/main/src/list.ts#L2>), " +
        "[`src/util.ts:4-9`](<https://github.com/acme/app/blob/main/src/util.ts#L4-L9>)",
    );
    expect(tokens).toEqual([`xoxb-${threads}@T${threads}`]);

    const messages = await recorded(thread.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "assistant", content: markdown, ralphRunId: null });
  });

  it("explains an answer without a result", async () => {
    const thread = await slackThread();
    const { adapter } = slackAdapter();
    const base = { usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 1, answer: null };
    await onChatAskJobCompleted(
      db,
      await askJob(thread.id, { ...base, outcome: "budget_exhausted" }),
      channel(adapter),
    );
    await onChatAskJobCompleted(
      db,
      await askJob(thread.id, { ...base, outcome: "no_checkout" }),
      channel(adapter),
    );
    const posted = vi
      .mocked(adapter.postMessage)
      .mock.calls.map(([, message]) => (message as { markdown: string }).markdown);
    expect(posted).toEqual([
      "Sorry, I couldn't finish an answer about `acme/app` within the token budget for code questions (12,000 tokens). Try a narrower question.",
      "Sorry, I couldn't answer: `acme/app` has no `main` branch to read.",
    ]);
    expect(await recorded(thread.id)).toHaveLength(2);
  });

  it("apologizes once when the job failed", async () => {
    const thread = await slackThread();
    const job = await askJob(thread.id, null);
    const { adapter } = slackAdapter();
    expect(await onChatAskJobFailed(db, job, channel(adapter))).toBe(true);
    expect(await onChatAskJobFailed(db, job, channel(adapter))).toBe(false);
    expect(adapter.postMessage).toHaveBeenCalledExactlyOnceWith(SLACK_THREAD, {
      markdown:
        "Sorry, I couldn't answer that question about `acme/app`; the job failed. Try asking again later.",
    });
    expect(await recorded(thread.id)).toHaveLength(1);
  });

  it("skips (logged) when the thread's platform has no adapter", async () => {
    const thread = await slackThread();
    const job = await askJob(thread.id, answered);
    expect(
      await onChatAskJobCompleted(db, job, { ...channel(slackAdapter().adapter), adapters: {} }),
    ).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("the thread or its chat connection is gone"),
    );
    expect(await recorded(thread.id)).toHaveLength(0);
  });
});
