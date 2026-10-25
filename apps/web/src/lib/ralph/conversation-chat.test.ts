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
  insertJob,
  listRunEvents,
  organizations,
  saveChatConnection,
  updateRun,
  upsertScmConnection,
  type Database,
  type RalphRun,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import type { Adapter } from "chat";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeLinearGateway } from "@/lib/linear/fake-gateway";
import {
  ChatConversation,
  conversationFor,
  runCompletedEvent,
  runFailedEvent,
  type ChatChannel,
} from "./conversation";
import { relayActivity } from "./activities";
import { postActivity } from "./notify";
import { askPermission, expirePermission } from "./permissions";

vi.mock("server-only", () => ({}));

const databaseAvailable = testDatabaseAvailable();

const APP_URL = "https://omniralph.example.com";
const SLACK_THREAD = "slack:C1:1700000000.000100";

describe.skipIf(!databaseAvailable)("a chat run's conversation", () => {
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

  const events = (run: RalphRun) => listRunEvents(db, orgId, run.chatThreadId!);

  /** Nothing was posted or edited in the thread, nor added to its history. */
  async function expectNothingPosted(adapter: Adapter, run: RalphRun) {
    expect(adapter.postMessage).not.toHaveBeenCalled();
    expect(adapter.editMessage).not.toHaveBeenCalled();
    expect(await recorded(run.id)).toEqual([]);
  }

  it("records nothing for thoughts, actions and the plan, and edits no status message", async () => {
    const { run } = await chatRun();
    const { adapter } = slackAdapter();
    const conversation = new ChatConversation(run, channel(adapter));

    await conversation.post({ type: "thought", body: "Reading the README\nmore detail" });
    await conversation.post({ type: "action", action: "Ran", parameter: "pnpm test" });
    await conversation.updatePlan([
      { content: "Fix the typo", status: "completed" },
      { content: "Open a PR", status: "inProgress" },
    ]);

    await expectNothingPosted(adapter, run);
    expect(await events(run)).toEqual([]);
  });

  it("records responses, notices, errors and elicitations as sanitized run events, posting nothing", async () => {
    const { run } = await chatRun();
    const { adapter } = slackAdapter();
    const conversation = new ChatConversation(run, channel(adapter));

    await conversation.post({
      type: "response",
      body: "Done: https://github.com/acme/app/pull/7 (see https://evil.example/x) @here",
    });
    await conversation.post({ type: "thought", body: "CI failed on main." }, { notice: true });
    await conversation.post({ type: "error", body: "The job failed." });
    await conversation.post({ type: "elicitation", body: "Which branch should I use?" });

    await expectNothingPosted(adapter, run);
    const recordedEvents = await events(run);
    expect(recordedEvents.map((e) => [e.kind, e.body])).toEqual([
      [
        "response",
        { text: "Done: https://github.com/acme/app/pull/7 (see `https://evil.example/x`) `@here`" },
      ],
      ["response", { text: "CI failed on main." }],
      ["failure", { text: "⚠️ The job failed." }],
      ["question", { text: "Which branch should I use?" }],
    ]);
    expect(
      recordedEvents.every(
        (e) => e.chatThreadId === run.chatThreadId && e.organizationId === orgId,
      ),
    ).toBe(true);
    // Each without a key of its own is a separate event.
    expect(new Set(recordedEvents.map((e) => e.idempotencyKey)).size).toBe(4);
  });

  it("records a run's end once per round, with its kind and details", async () => {
    const { run } = await chatRun();
    const { adapter } = slackAdapter();
    const conversation = new ChatConversation(run, channel(adapter));
    const at = run.updatedAt.toISOString();
    for (let i = 0; i < 2; i += 1) {
      await conversation.post(
        { type: "response", body: "All done." },
        { event: runCompletedEvent(run) },
      );
      await conversation.post({ type: "error", body: "Gave up." }, { event: runFailedEvent(run) });
    }
    // A run resumed after it ended (e.g. by a CI fix) ends again.
    const resumed = { ...run, updatedAt: new Date(run.updatedAt.getTime() + 1000) };
    await conversation.post(
      { type: "response", body: "Fixed CI." },
      { event: runCompletedEvent(resumed) },
    );
    await expectNothingPosted(adapter, run);
    expect((await events(run)).map((e) => [e.kind, e.idempotencyKey, e.body])).toEqual([
      [
        "completion",
        `chat-run-event:ralph:${run.id}:completed:${at}`,
        { status: "completed", text: "All done." },
      ],
      [
        "failure",
        `chat-run-event:ralph:${run.id}:failed:${at}`,
        { status: "failed", text: "⚠️ Gave up." },
      ],
      [
        "completion",
        `chat-run-event:ralph:${run.id}:completed:${resumed.updatedAt.toISOString()}`,
        { status: "completed", text: "Fixed CI." },
      ],
    ]);
  });

  it("records each link once", async () => {
    const { run } = await chatRun();
    const { adapter } = slackAdapter();
    const chat = channel(adapter);
    const url = "https://github.com/acme/app/pull/7";
    await new ChatConversation(run, chat).addLink("Pull request", url);
    await new ChatConversation(run, chat).addLink("Pull request", url);
    await expectNothingPosted(adapter, run);
    expect((await events(run)).map((e) => [e.kind, e.body])).toEqual([
      ["response", { label: "Pull request", url, text: `Pull request: ${url}` }],
    ]);
  });

  it("records a permission request once per request, and its timeout", async () => {
    const { run } = await chatRun();
    await updateRun(db, run.id, { status: "running" });
    const { adapter } = slackAdapter();
    const linear = vi.fn(async () => new FakeLinearGateway());
    const deps = { db, linear, chat: channel(adapter) };
    const { job } = await insertJob(db, {
      organizationId: orgId,
      type: "ralph.request",
      taskType: "coding",
      ralphRunId: run.id,
    });
    const request = {
      requestId: "REQ-1",
      tool: "Bash",
      detail: "git push --force",
      reason: "The repository asks before pushing.",
      timeoutSeconds: 600,
    };
    const now = new Date("2026-10-12T10:00:00Z");

    expect(await askPermission(deps, job, request, now)).toEqual({ status: "asked" });
    // The agent asking again (a retry) records no second event.
    expect(await askPermission(deps, job, request, now)).toEqual({ status: "asked" });
    await expirePermission(deps, job, "req-1", new Date("2026-10-12T10:10:00Z"));
    await expirePermission(deps, job, "req-1", new Date("2026-10-12T10:10:00Z"));

    await expectNothingPosted(adapter, run);
    expect(linear).not.toHaveBeenCalled();
    const [asked, expired, ...more] = await events(run);
    expect(more).toEqual([]);
    expect(asked).toMatchObject({
      kind: "permission_request",
      idempotencyKey: `chat-run-event:ralph:${run.id}:permission:req-1`,
      body: {
        requestId: "req-1",
        tool: "Bash",
        detail: "git push --force",
        reason: "The repository asks before pushing.",
        timeoutSeconds: 600,
        timeoutMinutes: 10,
        options: ["Allow", "Deny"],
      },
    });
    expect((asked!.body as { text: string }).text).toContain("Bash");
    expect(expired).toMatchObject({
      kind: "response",
      idempotencyKey: `chat-run-event:ralph:${run.id}:permission:req-1:expired`,
      body: { text: "Nobody answered in time, so I didn't use **Bash**." },
    });
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
    expect(await events(run)).toEqual([]);
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
    expect(await events(run)).toEqual([]);
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
    expect(linear).not.toHaveBeenCalled();
    // An agent's thoughts and actions are progress: nothing is relayed.
    expect(await events(run)).toEqual([]);

    await updateRun(db, run.id, { status: "stopped" });
    expect(
      await relayActivity(
        deps,
        { ralphRunId: run.id },
        { type: "thought", body: "late", ephemeral: false },
      ),
    ).toEqual({ forwarded: false, reason: "run_finished" });
    expect(await events(run)).toEqual([]);
    await expectNothingPosted(adapter, run);
  });
});
