import { randomBytes } from "node:crypto";
import { createMockAdapter, createMockState } from "@chat-adapter/tests";
import {
  chatMessages,
  closeDb,
  connectRepository,
  createDb,
  createRun,
  deleteChatConnection,
  ensureChatThread,
  organizations,
  runMigrations,
  saveChatConnection,
  seedReviewProfiles,
  updateRun,
  upsertScmConnection,
  type Database,
  type RalphRun,
} from "@omniralph/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Adapter } from "chat";
import { asc, eq } from "drizzle-orm";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeLinearGateway } from "@/lib/linear/fake-gateway";
import {
  ChatConversation,
  conversationFor,
  currentPlanStep,
  statusText,
  type ChatChannel,
} from "./conversation";
import { relayActivity } from "./activities";
import { postActivity } from "./notify";

vi.mock("server-only", () => ({}));

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

const APP_URL = "https://omniralph.example.com";
const SLACK_THREAD = "slack:C1:1700000000.000100";

describe.skipIf(!dockerAvailable)("a chat run's conversation", () => {
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

  /** A Slack workspace with a thread, and a chat run in it. */
  async function chatRun(): Promise<{ run: RalphRun; connectionId: string }> {
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
    const thread = await ensureChatThread(db, {
      connectionId: connection.id,
      externalThreadId: SLACK_THREAD,
      channelId: "slack:C1",
      startedByExternalUserId: "U1",
    });
    const { run } = await createRun(db, {
      origin: "chat",
      organizationId: orgId,
      chatThreadId: thread!.id,
      repositoryId,
      branch: `omniralph/chat-${threads}`,
      baseBranch: "main",
    });
    return { run, connectionId: connection.id };
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

  const recorded = (runId: string) =>
    db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.ralphRunId, runId))
      .orderBy(asc(chatMessages.createdAt));

  it("is what conversationFor gives a chat run", async () => {
    const { run } = await chatRun();
    const conversation = conversationFor(run, {
      linear: new FakeLinearGateway(),
      chat: channel(slackAdapter().adapter),
    });
    expect(conversation).toBeInstanceOf(ChatConversation);
    expect(conversation.name).toBe(`chat thread ${run.chatThreadId}`);
  });

  it("edits one status message per request job with thoughts, actions and the plan", async () => {
    const { run } = await chatRun();
    const { adapter, tokens } = slackAdapter();
    const chat = channel(adapter);
    const first = { ...run, requestJobId: "11111111-1111-4111-8111-111111111111" };
    const conversation = new ChatConversation(first, chat);

    await conversation.post({ type: "thought", body: "Reading the README\nmore detail" });
    await conversation.post({ type: "action", action: "Ran", parameter: "pnpm test" });
    await conversation.updatePlan([
      { content: "Fix the typo", status: "completed" },
      { content: "Open a PR", status: "inProgress" },
    ]);

    expect(adapter.postMessage).toHaveBeenCalledOnce();
    expect(adapter.postMessage).toHaveBeenCalledWith(SLACK_THREAD, {
      markdown: "⏳ Working on it\nReading the README",
    });
    expect(adapter.editMessage).toHaveBeenCalledTimes(2);
    expect(adapter.editMessage).toHaveBeenNthCalledWith(1, SLACK_THREAD, "ts-1", {
      markdown: "⏳ Working on it\nRan `pnpm test`",
    });
    expect(adapter.editMessage).toHaveBeenLastCalledWith(SLACK_THREAD, "ts-1", {
      markdown: "⏳ Working on it · Step 2/2: Open a PR\nRan `pnpm test`",
    });
    // Posted with the workspace's bot token, outside any webhook.
    expect(tokens).toEqual(Array(3).fill(`xoxb-${threads}@T${threads}`));
    // Status updates aren't part of the thread's history.
    expect(await recorded(run.id)).toEqual([]);

    // Between jobs (no request job), updates keep editing the same message.
    await new ChatConversation({ ...run, requestJobId: null }, chat).post({
      type: "thought",
      body: "Wrapping up",
    });
    expect(adapter.postMessage).toHaveBeenCalledOnce();
    expect(adapter.editMessage).toHaveBeenLastCalledWith(SLACK_THREAD, "ts-1", {
      markdown: "⏳ Working on it · Step 2/2: Open a PR\nWrapping up",
    });

    // The next request job gets its own status message.
    const second = { ...run, requestJobId: "22222222-2222-4222-8222-222222222222" };
    await new ChatConversation(second, chat).post({ type: "thought", body: "Looking again" });
    expect(adapter.postMessage).toHaveBeenCalledTimes(2);
    expect(adapter.postMessage).toHaveBeenLastCalledWith(SLACK_THREAD, {
      markdown: "⏳ Working on it\nLooking again",
    });
  });

  it("posts a new status message when editing the old one fails", async () => {
    const { run } = await chatRun();
    const { adapter } = slackAdapter();
    vi.mocked(adapter.editMessage).mockRejectedValueOnce(new Error("message_not_found"));
    const conversation = new ChatConversation(run, channel(adapter));
    await conversation.post({ type: "thought", body: "one" });
    await conversation.post({ type: "thought", body: "two" });
    await conversation.post({ type: "thought", body: "three" });
    expect(adapter.postMessage).toHaveBeenCalledTimes(2);
    expect(adapter.editMessage).toHaveBeenLastCalledWith(SLACK_THREAD, "ts-2", {
      markdown: "⏳ Working on it\nthree",
    });
  });

  it("posts responses, errors and elicitations as new, sanitized messages recorded as the run's", async () => {
    const { run } = await chatRun();
    const { adapter } = slackAdapter();
    const conversation = new ChatConversation(run, channel(adapter));

    await conversation.post({
      type: "response",
      body: "Done: https://github.com/acme/app/pull/7 (see https://evil.example/x) @here",
    });
    await conversation.post({ type: "error", body: "The job failed." });
    await conversation.post({ type: "elicitation", body: "Which branch should I use?" });

    const expected = [
      "Done: https://github.com/acme/app/pull/7 (see `https://evil.example/x`) `@here`",
      "⚠️ The job failed.",
      "Which branch should I use?",
    ];
    expect(vi.mocked(adapter.postMessage).mock.calls).toEqual(
      expected.map((markdown) => [SLACK_THREAD, { markdown }]),
    );
    expect(adapter.editMessage).not.toHaveBeenCalled();
    const rows = await recorded(run.id);
    expect(rows.map((r) => ({ role: r.role, content: r.content, threadId: r.threadId }))).toEqual(
      expected.map((content) => ({ role: "assistant", content, threadId: run.chatThreadId })),
    );
  });

  it("posts each link once", async () => {
    const { run } = await chatRun();
    const { adapter } = slackAdapter();
    const chat = channel(adapter);
    const url = "https://github.com/acme/app/pull/7";
    await new ChatConversation(run, chat).addLink("Pull request", url);
    await new ChatConversation(run, chat).addLink("Pull request", url);
    expect(adapter.postMessage).toHaveBeenCalledOnce();
    expect(adapter.postMessage).toHaveBeenCalledWith(SLACK_THREAD, {
      markdown: `Pull request: ${url}`,
    });
    expect((await recorded(run.id)).map((r) => r.content)).toEqual([`Pull request: ${url}`]);
  });

  it("skips posts quietly once the chat connection was removed", async () => {
    const { run, connectionId } = await chatRun();
    const { adapter } = slackAdapter();
    await deleteChatConnection(db, orgId, connectionId, key);
    // Before the run is re-read (its thread ID still set) and after (cleared).
    for (const stale of [run, { ...run, chatThreadId: null }]) {
      const conversation = new ChatConversation(stale, channel(adapter));
      await conversation.post({ type: "thought", body: "hi" });
      await conversation.post({ type: "response", body: "done" });
      await conversation.updatePlan([{ content: "Fix", status: "inProgress" }]);
      await conversation.addLink("Pull request", "https://github.com/acme/app/pull/7");
      expect(await postActivity(conversation, { type: "error", body: "The job failed." })).toBe(
        true,
      );
    }
    expect(adapter.postMessage).not.toHaveBeenCalled();
    expect(adapter.editMessage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("the thread or its chat connection is gone"),
    );
  });

  it("skips posts quietly when the platform isn't configured", async () => {
    const { run } = await chatRun();
    const conversation = new ChatConversation(run, {
      ...channel(slackAdapter().adapter),
      adapters: {},
    });
    await conversation.post({ type: "response", body: "done" });
    expect(await recorded(run.id)).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("gets an agent's relayed activities without touching Linear", async () => {
    const { run } = await chatRun();
    const { adapter } = slackAdapter();
    const linear = vi.fn(async () => new FakeLinearGateway());
    const deps = { db, linear, chat: channel(adapter) };

    const outcome = await relayActivity(
      deps,
      { ralphRunId: run.id },
      {
        type: "action",
        body: "Edited",
        parameter: "README.md",
        ephemeral: false,
      },
    );

    expect(outcome).toEqual({ forwarded: true });
    expect(adapter.postMessage).toHaveBeenCalledWith(SLACK_THREAD, {
      markdown: "⏳ Working on it\nEdited `README.md`",
    });
    expect(linear).not.toHaveBeenCalled();

    await updateRun(db, run.id, { status: "stopped" });
    expect(
      await relayActivity(
        deps,
        { ralphRunId: run.id },
        { type: "thought", body: "late", ephemeral: false },
      ),
    ).toEqual({ forwarded: false, reason: "run_finished" });
    expect(adapter.postMessage).toHaveBeenCalledOnce();
    expect(adapter.editMessage).not.toHaveBeenCalled();
  });
});

describe("status text", () => {
  it("shows the plan step in progress, else the next one", () => {
    expect(currentPlanStep([])).toBeUndefined();
    expect(
      currentPlanStep([
        { content: "A", status: "completed" },
        { content: "B", status: "pending" },
      ]),
    ).toBe("Step 2/2: B");
    expect(currentPlanStep([{ content: "A", status: "completed" }])).toBe("All steps done");
    expect(statusText({})).toBe("⏳ Working on it");
    expect(statusText({ step: "Step 1/1: A", last: "Ran x" })).toBe(
      "⏳ Working on it · Step 1/1: A\nRan x",
    );
  });
});
