import { randomBytes, randomUUID } from "node:crypto";
import { createMockAdapter, createMockState } from "@chat-adapter/tests";
import {
  agents,
  appendChatMessage,
  chatMessages,
  closeDb,
  completeJob,
  connectRepository,
  createDb,
  ensureChatThread,
  getJob,
  getMainLane,
  getRun,
  getRunByChatThread,
  jobs,
  listMessages,
  listRunEvents,
  mapThreadRun,
  organizations,
  ralphRuns,
  saveChatConnection,
  claimJob,
  repositories,
  setChatPlaybookDefaults,
  upsertChatChannelPlaybookSetting,
  upsertScmConnection,
  type ChatConnection,
  type ChatThread,
  type Database,
  type Job,
  type RalphRun,
} from "@omniralph/db";
import {
  CODING_TASKS_MIN_AGENT_VERSION,
  MAX_JOB_DELIVERIES,
  RalphRequestPayload,
  type RalphRequestResult,
} from "@omniralph/shared";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
  setCodingEnabled,
} from "@omniralph/db/testing";
import { MockLanguageModelV2 } from "ai/test";
import type { Adapter, Logger, Message, Thread } from "chat";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresDispatcher } from "@/lib/dispatch/dispatcher";
import { fakeRalphLinear } from "@/lib/ralph/testing";
import type { ChatChannel } from "@/lib/ralph/conversation";
import type { RalphDeps } from "@/lib/ralph/run";
import { FakeScmAdapter } from "@/lib/scm/fake-adapter";
import type { ChatConversationContext } from "../bot";
import type { ChatActor } from "../identity";

vi.mock("server-only", () => ({}));

const { createChatAgentHandler } = await import("./handler");
const { processThreadRunEvents } = await import("./wake");
const { LINK_REQUIRED_RESULT } = await import("./tools");
const { askPermission } = await import("@/lib/ralph/permissions");
const { onRalphJobFinished, onRalphJobStarted } = await import("@/lib/ralph/jobs");
const { ralphJobPayload } = await import("@/lib/ralph/coding");

const databaseAvailable = testDatabaseAvailable();

const APP_URL = "https://omniralph.example.com";
const ENV = { APP_URL } as unknown as NodeJS.ProcessEnv;
const THREAD_ID = "discord:G1:CH1:TH1";
const USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
type LanguageModelV2CallOptions = Parameters<MockLanguageModelV2["doGenerate"]>[0];
type GenerateResult = Awaited<ReturnType<MockLanguageModelV2["doGenerate"]>>;

const textResult = (text: string): GenerateResult => ({
  content: text ? [{ type: "text", text }] : [],
  finishReason: "stop",
  usage: USAGE,
  warnings: [],
});
const toolCallResult = (toolName: string, input: unknown): GenerateResult => ({
  content: [{ type: "tool-call", toolCallId: "call-1", toolName, input: JSON.stringify(input) }],
  finishReason: "tool-calls",
  usage: USAGE,
  warnings: [],
});

/** A model answering with `results` in turn and recording every call's options. */
function scriptedModel(...results: GenerateResult[]) {
  const calls: LanguageModelV2CallOptions[] = [];
  const model = new MockLanguageModelV2({
    doGenerate: async (options) => {
      calls.push(options);
      return results[Math.min(calls.length - 1, results.length - 1)]!;
    },
  });
  return { model, calls };
}

const systemOf = (call: LanguageModelV2CallOptions) =>
  call.prompt.find((m) => m.role === "system")?.content as string;
const toolResultsOf = (call: LanguageModelV2CallOptions) =>
  call.prompt.flatMap((m) =>
    m.role === "tool" ? m.content.map((p) => ({ name: p.toolName, output: p.output })) : [],
  );
/** The JSON the turn's tool call returned to the model (the last tool result it saw). */
const toolOutput = (call: LanguageModelV2CallOptions) => {
  const result = toolResultsOf(call).at(-1);
  return (result!.output as { type: string; value: unknown }).value as Record<string, unknown>;
};

const REQUEST =
  "Fix the typo in the README of acme/app. The heading says 'Omniralhp'; it should say 'Omniralph'.";

describe.skipIf(!databaseAvailable)("start_work", () => {
  const key = randomBytes(32);
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let appRepoId: string;
  let connection: ChatConnection;
  let chatThread: ChatThread;
  let agentId: string;
  let posts: string[];
  let ephemerals: string[];
  let reactions: { threadId: string; messageId: string; emoji: string }[];
  let scm: FakeScmAdapter;
  let adapter: Adapter;
  let logger: Logger;

  const ralph = (): RalphDeps => ({
    db,
    organizationId: orgId,
    linear: fakeRalphLinear(),
    dispatcher: new PostgresDispatcher({ db }),
    adapterFor: () => scm.asAdapter(),
    chat: {
      db,
      adapters: { discord: adapter },
      state: createMockState(),
      appUrl: APP_URL,
      encryptionKey: key,
    } satisfies ChatChannel,
  });

  const thread = () =>
    ({
      id: THREAD_ID,
      async post(message: string | { markdown: string }) {
        posts.push(typeof message === "string" ? message : message.markdown);
        return {};
      },
      async postEphemeral(_user: { userId: string }, text: string) {
        ephemerals.push(text);
        return {};
      },
      mentionUser: (id: string) => `<@${id}>`,
      async startTyping() {},
      adapter: {
        async addReaction(threadId: string, messageId: string, emoji: string) {
          reactions.push({ threadId, messageId, emoji });
        },
      },
      get state() {
        return Promise.resolve(null);
      },
      async setState() {},
    }) as unknown as Thread;

  const member: ChatActor = { kind: "member", userId: "ada", role: "member", name: "Ada" };
  const domain: ChatActor = { kind: "domain", email: "ada@acme.test" };

  /**
   * Records `text` as Ada's message (as the bot does) and runs the agent's
   * turn. It mentions the bot when it starts with `@omniralph`.
   */
  async function turn(
    model: MockLanguageModelV2,
    text: string,
    actor: ChatActor = member,
    /** Another thread, or a message seen as another organization's. */
    where: { chatThread?: ChatThread; organizationId?: string } = {},
  ) {
    const target = where.chatThread ?? chatThread;
    const organizationId = where.organizationId ?? orgId;
    await appendChatMessage(db, {
      threadId: target.id,
      role: "user",
      externalUserId: "D1",
      authorName: "Ada Lovelace",
      content: text,
    });
    const t = thread();
    const m = {
      id: `msg-${randomBytes(4).toString("hex")}`,
      text,
      isMention: text.startsWith("@omniralph"),
      author: { userId: "D1", userName: "ada", fullName: "Ada Lovelace" },
    } as Message;
    const context: ChatConversationContext = {
      organizationId,
      connection,
      chatThread: target,
      skipped: [],
      thread: t,
      message: m,
      actor,
      logger,
      linkUrl: async () => `${APP_URL}/chat/link?state=s`,
    };
    const handler = createChatAgentHandler({
      db,
      model,
      env: ENV,
      logger,
      ralph: async (id) => ({ ...ralph(), organizationId: id }),
      // Every test's turns count against the same user and organization.
      rateLimits: {
        perOrganization: () => ({ key: `test:org:${randomUUID()}`, limit: 1, windowSeconds: 60 }),
        perChatUser: () => ({ key: `test:user:${randomUUID()}`, limit: 1, windowSeconds: 60 }),
      },
    });
    await handler.handle(t, m, context);
    return m;
  }

  const queuedJobs = () =>
    db
      .select()
      .from(jobs)
      .where(inArray(jobs.status, ["queued", "running"]))
      .orderBy(asc(jobs.createdAt));

  const threadRun = async (): Promise<RalphRun | null> => getRunByChatThread(db, chatThread.id);

  /** Starts the run's queued `ralph.request` job on the agent. */
  async function startRequestJob(job: Job): Promise<void> {
    const started = await claimJob(db, {
      organizationId: orgId,
      agentId,
      acceptedTaskTypes: ["query", "coding"],
      pools: ["short", "long"],
      agentVersion: CODING_TASKS_MIN_AGENT_VERSION,
      maxDeliveries: MAX_JOB_DELIVERIES,
    });
    expect(started.claim?.job.id).toBe(job.id);
    expect(await onRalphJobStarted(db, job, agentId)).toEqual({ skip: false });
  }

  /** Plays the run's queued (or started) `ralph.request` job to completion with `result`. */
  async function playRequestJob(job: Job, result: Partial<RalphRequestResult>): Promise<void> {
    if ((await getJob(db, job.id))!.status === "queued") await startRequestJob(job);
    const outcome: RalphRequestResult = {
      summary: "Fixed the typo.",
      error: null,
      sessionId: "claude-1",
      usage: { inputTokens: 1, outputTokens: 1 },
      durationMs: 10,
      ...result,
    };
    expect(await completeJob(db, { jobId: job.id, agentId, result: outcome })).toEqual({
      status: "completed",
    });
    await onRalphJobFinished(db, (await getJob(db, job.id))!, ralph());
  }

  const STARTED_REPLY = "Started a ralph run to fix the README typo.";

  /** The start turn: the model calls the tool with `input`, then replies `reply`. */
  async function handOff(
    input: { repository: string; request: string; ship?: boolean },
    reply = STARTED_REPLY,
  ) {
    const scripted = scriptedModel(toolCallResult("start_work", input), textResult(reply));
    await turn(scripted.model, "@omniralph fix the typo in the README of acme/app");
    return scripted.calls;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
    const scmConnection = (await upsertScmConnection(
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
    for (const [externalId, fullPath, codingEnabled] of [
      ["1", "acme/app", true],
      ["2", "acme/web", true],
      ["3", "acme/docs", false],
    ] as const) {
      const repository = await connectRepository(db, {
        connectionId: scmConnection.id,
        provider: "github",
        externalId,
        fullPath,
      });
      if (fullPath === "acme/app") appRepoId = repository.id;
      await setCodingEnabled(db, repository.id, codingEnabled);
    }
    const saved = await saveChatConnection(
      db,
      {
        organizationId: orgId,
        platform: "discord",
        externalId: "G1",
        name: "Acme server",
        credentials: null,
        installedByUserId: null,
      },
      key,
    );
    if (saved === "other_organization") throw new Error("taken");
    connection = saved;
    [{ id: agentId }] = (await db
      .insert(agents)
      .values({ organizationId: orgId, name: "agent-a", reportedAcceptedTaskTypes: ["coding"] })
      .returning({ id: agents.id })) as [{ id: string }];
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    await db.delete(jobs);
    await db.delete(ralphRuns);
    await setChatPlaybookDefaults(db, orgId, null, null);
    await db
      .update(repositories)
      .set({ requestPlaybookId: "builtin:handle-request" })
      .where(eq(repositories.id, appRepoId));
    await db.execute("DELETE FROM chat_threads");
    chatThread = (await ensureChatThread(db, {
      connectionId: connection.id,
      externalThreadId: THREAD_ID,
      channelId: "discord:G1:CH1",
      startedByExternalUserId: "D1",
    }))!;
    posts = [];
    ephemerals = [];
    reactions = [];
    scm = new FakeScmAdapter();
    let n = 0;
    adapter = createMockAdapter("discord", {
      postMessage: vi.fn(async (threadId: string) => {
        n += 1;
        return { id: `m-${n}`, threadId, raw: {} };
      }),
    });
    logger = {
      child: () => logger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger;
  });

  it("tells the agent to confirm an ambiguous repository and say in its reply that the run started", async () => {
    const { model, calls } = scriptedModel(
      textResult("Which repository do you mean: acme/app or acme/web?"),
    );
    await turn(model, "@omniralph fix the typo in the README");

    const system = systemOf(calls[0]!);
    expect(system).toContain("confirm which repository");
    expect(system).toContain("tell the user in your own reply that the run started");
    expect(calls[0]!.tools?.map((t) => t.name)).toContain("start_work");
    expect(calls[0]!.tools?.map((t) => t.name)).not.toContain("start_ralph_request");
    expect(posts).toEqual(["Which repository do you mean: acme/app or acme/web?"]);
    expect(await threadRun()).toBeNull();
    expect(await queuedJobs()).toEqual([]);
  });

  it("starts a chat run of the start work task, enqueues its request job and completes in the thread", async () => {
    const calls = await handOff({ repository: "Acme/App", request: REQUEST });

    const run = (await threadRun())!;
    expect(run).toMatchObject({
      origin: "chat",
      mode: "request",
      kind: "single",
      chatThreadId: chatThread.id,
      repositoryId: appRepoId,
      status: "running",
      linearIssueId: null,
      codingTaskId: "builtin:handle-request",
    });
    expect(toolOutput(calls[1]!)).toMatchObject({
      status: "started",
      runId: run.id,
      url: `${APP_URL}/runs/${run.id}`,
      task: "builtin:handle-request",
      repository: "acme/app",
      followUp: false,
    });
    // The agent's reply is the only post of the turn: the tool posts nothing.
    expect(posts).toEqual([STARTED_REPLY]);
    const recorded = await db
      .select({ role: chatMessages.role, ralphRunId: chatMessages.ralphRunId })
      .from(chatMessages)
      .where(eq(chatMessages.threadId, chatThread.id))
      .orderBy(asc(chatMessages.createdAt));
    expect(recorded.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);

    // The request: the agent's instruction, then the quoted user message.
    const [message] = await listMessages(db, run.id);
    expect(message).toMatchObject({ kind: "request", author: "Ada Lovelace" });
    expect(message!.text).toBe(
      `${REQUEST}\n\nFrom the chat thread:\n\n> **Ada Lovelace:** @omniralph fix the typo in the README of acme/app`,
    );

    // The job went out through the existing path, on the run's new branch.
    const [job, ...more] = await queuedJobs();
    expect(more).toEqual([]);
    expect(job).toMatchObject({
      type: "ralph.request",
      ralphRunId: run.id,
      status: "queued",
      targetAgentId: null,
    });
    const payload = RalphRequestPayload.parse(ralphJobPayload(job!));
    expect(payload).toMatchObject({
      source: "chat",
      branch: `omniralph/chat-${run.id.slice(0, 8)}`,
      baseBranch: "develop",
      epic: {
        identifier: `chat-${run.id.slice(0, 8)}`,
        title:
          "Fix the typo in the README of acme/app. The heading says 'Omniralhp'; it should say 'Omniralph'.",
        kind: "single",
      },
      requests: [{ id: message!.id, text: message!.text }],
      attachments: [],
    });
    // The run doesn't post in the thread itself: its progress isn't relayed.
    expect(adapter.postMessage).not.toHaveBeenCalled();
    expect(await listRunEvents(db, orgId, chatThread.id)).toEqual([]);

    // The job's outcome: the PR it asked for is opened and the run completes with its answer.
    await playRequestJob(job!, {
      summary: "Fixed the typo and opened a draft PR.",
      pullRequest: { action: "open", title: "Fix the README typo", body: "Fixes a typo." },
    });
    expect(await getRun(db, run.id)).toMatchObject({ status: "completed" });
    const [pr] = scm.changeRequests;
    expect(pr).toMatchObject({
      sourceBranch: payload.branch,
      targetBranch: "develop",
      draft: true,
    });
    expect(pr!.body).toContain("Requested in chat. Opened by Omniralph.");
    // Its PR/MR link and its answer are run events of the thread, for the responder to relay.
    expect(adapter.postMessage).not.toHaveBeenCalled();
    expect(adapter.editMessage).not.toHaveBeenCalled();
    const events = await listRunEvents(db, orgId, chatThread.id);
    expect(events.map((e) => e.kind)).toEqual(["response", "completion"]);
    expect(events[0]!.body).toMatchObject({ text: `Pull request #1: ${pr!.url}`, url: pr!.url });
    expect((events[1]!.body as { text: string }).text).toContain(
      "Fixed the typo and opened a draft PR.",
    );
    expect(await queuedJobs()).toEqual([]);
  });

  it("refuses a repository without ralph and lists the candidates", async () => {
    const calls = await handOff({ repository: "acme/docs", request: REQUEST });

    expect(toolOutput(calls[1]!)).toMatchObject({
      error: "unknown_repository",
      candidates: ["acme/app", "acme/web"],
    });
    expect(String(toolOutput(calls[1]!).message)).toContain("acme/app, acme/web");
    expect(await threadRun()).toBeNull();
    expect(await queuedJobs()).toEqual([]);
  });

  it("points to the Coding switch when no repository has coding on", async () => {
    await db
      .update(repositories)
      .set({ codingEnabled: false })
      .where(eq(repositories.organizationId, orgId));
    try {
      const calls = await handOff({ repository: "acme/app", request: REQUEST });

      expect(toolOutput(calls[1]!)).toMatchObject({ error: "unknown_repository", candidates: [] });
      const message = String(toolOutput(calls[1]!).message);
      expect(message).toContain("Coding switch under Repos");
      expect(message).toContain("work item match");
      expect(message).not.toContain("Task types");
      expect(await threadRun()).toBeNull();
    } finally {
      for (const fullPath of ["acme/app", "acme/web"]) {
        await db
          .update(repositories)
          .set({ codingEnabled: true })
          .where(and(eq(repositories.organizationId, orgId), eq(repositories.fullPath, fullPath)));
      }
    }
  });

  it("refuses a chat user who isn't a linked member", async () => {
    const { model, calls } = scriptedModel(
      toolCallResult("start_work", { repository: "acme/app", request: REQUEST }),
      textResult("You need to link your account first."),
    );
    await turn(model, "@omniralph fix the typo in the README of acme/app", domain);

    expect(toolOutput(calls[1]!)).toMatchObject({ error: "link_required" });
    expect(await threadRun()).toBeNull();
    expect(await queuedJobs()).toEqual([]);
    expect(posts).toEqual(["You need to link your account first."]);
  });

  it("refuses to start a second run while the thread's run is active", async () => {
    await handOff({ repository: "acme/app", request: REQUEST });
    const first = (await threadRun())!;
    posts = [];

    const calls = await handOff({ repository: "acme/web", request: "Also bump the version." }, "");

    expect(toolOutput(calls[1]!)).toMatchObject({
      error: "run_active",
      run: { id: first.id, status: "running" },
    });
    expect(String(toolOutput(calls[1]!).message)).toContain("reply_to_run");
    expect((await threadRun())!.id).toBe(first.id);
    expect(await queuedJobs()).toHaveLength(1);
    // The agent's empty answer after a refusal still says something.
    expect(posts).toEqual(["Sorry, I don't have an answer to that."]);
  });

  it("continues the thread's finished run in the same repository on its branch and PR", async () => {
    await handOff({ repository: "acme/app", request: REQUEST });
    const first = (await threadRun())!;
    const [job] = await queuedJobs();
    await playRequestJob(job!, {
      pullRequest: { action: "open", title: "Fix the README typo", body: "Fixes a typo." },
    });
    const firstLane = (await getMainLane(db, first))!;
    expect(firstLane.prUrl).toBe(scm.changeRequests[0]!.url);
    const branchReads = scm.calls.filter((c) => c === "getDefaultBranch").length;
    posts = [];

    const calls = await handOff({
      repository: "acme/app",
      request: "Also fix the typo in CONTRIBUTING.md.",
    });

    const second = (await threadRun())!;
    expect(second.id).not.toBe(first.id);
    expect(toolOutput(calls[1]!)).toMatchObject({
      status: "started",
      runId: second.id,
      followUp: true,
    });
    expect(String(toolOutput(calls[1]!).message)).toContain(
      "continuing the previous run's branch and pull request",
    );
    expect(posts).toEqual([STARTED_REPLY]);
    const lane = (await getMainLane(db, second))!;
    expect(lane).toMatchObject({
      branch: firstLane.branch,
      baseBranch: "develop",
      prNumber: firstLane.prNumber,
      prUrl: firstLane.prUrl,
    });
    const [next] = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.ralphRunId, second.id), eq(jobs.status, "queued")));
    const payload = RalphRequestPayload.parse(ralphJobPayload(next!));
    expect(payload).toMatchObject({ branch: firstLane.branch, prUrl: firstLane.prUrl });
    // The follow-up keeps the lane's base branch: it doesn't read the default branch again.
    expect(scm.calls.filter((c) => c === "getDefaultBranch")).toHaveLength(branchReads);
  });

  it("ships the thread's finished run with `ship`: a ship job on its branch", async () => {
    await handOff({ repository: "acme/app", request: REQUEST });
    const first = (await threadRun())!;
    const [job] = await queuedJobs();
    await playRequestJob(job!, { summary: "Fixed it, but couldn't commit." });
    const firstLane = (await getMainLane(db, first))!;

    const calls = await handOff({ repository: "acme/app", request: "Ship it.", ship: true });

    expect(toolOutput(calls[1]!)).toMatchObject({ status: "started", followUp: true });
    const second = (await threadRun())!;
    const [next] = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.ralphRunId, second.id), eq(jobs.status, "queued")));
    const payload = RalphRequestPayload.parse(ralphJobPayload(next!));
    expect(payload).toMatchObject({ ship: true, branch: firstLane.branch });
    expect(payload.requests[0]!.text).toMatch(/^Ship it\./);
    expect(systemOf(calls[0]!)).toContain("set `ship` on start_work");
  });

  it("refuses to ship when the thread has no earlier run in that repository", async () => {
    const calls = await handOff({ repository: "acme/app", request: "Ship it.", ship: true });

    expect(toolOutput(calls[1]!)).toMatchObject({ error: "nothing_to_ship" });
    expect(await threadRun()).toBeNull();
    expect(await queuedJobs()).toHaveLength(0);
  });

  it("starts fresh when the thread's last run worked in another repository", async () => {
    await handOff({ repository: "acme/web", request: "Bump the version." });
    const first = (await threadRun())!;
    const [job] = await queuedJobs();
    await playRequestJob(job!, {});
    posts = [];

    const calls = await handOff({ repository: "acme/app", request: REQUEST });

    const second = (await threadRun())!;
    expect(second.id).not.toBe(first.id);
    expect(toolOutput(calls[1]!)).toMatchObject({ status: "started", followUp: false });
    expect((await getMainLane(db, second))!).toMatchObject({
      branch: `omniralph/chat-${second.id.slice(0, 8)}`,
      prUrl: null,
    });
  });
  it("runs the channel's start work playbook over the repository's request playbook", async () => {
    // The repository's own request binding isn't a request playbook: the channel's is used instead.
    await db
      .update(repositories)
      .set({ requestPlaybookId: "builtin:implement-story" })
      .where(eq(repositories.id, appRepoId));
    // The organization's choice is gone (e.g. a deleted custom playbook); the channel's override wins.
    await setChatPlaybookDefaults(
      db,
      orgId,
      { ask: "builtin:ask-about-code", startWork: "00000000-0000-4000-8000-0000000000de" },
      null,
    );
    await upsertChatChannelPlaybookSetting(db, {
      organizationId: orgId,
      connectionId: connection.id,
      channelId: chatThread.channelId,
      askPlaybookId: null,
      startWorkPlaybookId: "builtin:handle-request",
      updatedBy: null,
    });

    const calls = await handOff({ repository: "acme/app", request: REQUEST });

    const run = (await threadRun())!;
    expect(run.codingTaskId).toBe("builtin:handle-request");
    expect(toolOutput(calls[1]!)).toMatchObject({
      status: "started",
      runId: run.id,
      task: "builtin:handle-request",
    });
    const [job, ...more] = await queuedJobs();
    expect(more).toEqual([]);
    expect(job).toMatchObject({
      type: "ralph.request",
      ralphRunId: run.id,
      taskType: "coding",
      taskId: "builtin:handle-request",
    });
    expect(posts).toEqual([STARTED_REPLY]);
    await db.execute("DELETE FROM chat_channel_task_settings");
  });

  it("starts nothing when the channel's start work playbook can't run", async () => {
    const deleted = "00000000-0000-4000-8000-0000000000de";
    await setChatPlaybookDefaults(
      db,
      orgId,
      { ask: "builtin:ask-about-code", startWork: deleted },
      null,
    );

    const calls = await handOff({ repository: "acme/app", request: REQUEST }, "");

    expect(toolOutput(calls[1]!)).toMatchObject({ error: "playbook_unavailable" });
    expect(String(toolOutput(calls[1]!).message)).toContain(`There's no playbook ${deleted}.`);
    expect(await threadRun()).toBeNull();
    expect(await queuedJobs()).toEqual([]);
  });

  describe("thread replies", () => {
    /** Hands off and returns the run with its queued request job. */
    async function handedOff() {
      await handOff({ repository: "acme/app", request: REQUEST });
      const run = (await threadRun())!;
      const [job] = await queuedJobs();
      posts = [];
      return { run, job: job! };
    }

    it("passes a member's plain reply to the running session through reply_to_run, as a live message", async () => {
      const { run, job } = await handedOff();
      await startRequestJob(job);
      const { model, calls } = scriptedModel(
        toolCallResult("reply_to_run", { text: "Also fix the one in CONTRIBUTING.md" }),
        textResult("Passed that on."),
      );

      await turn(model, "Also fix the one in CONTRIBUTING.md");

      const system = systemOf(calls[0]!);
      expect(system).toContain(`This thread's coding task: ${run.id}`);
      expect(system).toContain("its session is working right now");
      const tools = calls[0]!.tools?.map((t) => t.name);
      expect(tools).toEqual(
        expect.arrayContaining([
          "get_ralph_run",
          "reply_to_run",
          "answer_run_permission",
          "answer_run_cleanup",
        ]),
      );
      expect(tools).not.toContain("send_to_session");
      expect(toolOutput(calls[1]!)).toMatchObject({ status: "live", run: { id: run.id } });
      expect((await listMessages(db, run.id)).at(-1)).toMatchObject({
        kind: "request",
        jobId: job.id,
        text: "Also fix the one in CONTRIBUTING.md",
        author: "Ada",
      });
      // No new job: the live session gets it in its next heartbeat.
      expect((await queuedJobs()).map((j) => j.id)).toEqual([job.id]);
      expect(reactions).toEqual([]);
      expect(posts).toEqual(["Passed that on."]);
    });

    it("keeps a reply as the next request while the job is queued", async () => {
      const { run, job } = await handedOff();
      const { model, calls } = scriptedModel(
        toolCallResult("reply_to_run", { text: "Also fix the one in CONTRIBUTING.md" }),
        textResult("It'll do that next."),
      );

      await turn(model, "@omniralph also fix the one in CONTRIBUTING.md");

      expect(toolOutput(calls[1]!)).toMatchObject({ status: "queued", run: { id: run.id } });
      const pending = (await listMessages(db, run.id)).at(-1)!;
      expect(pending).toMatchObject({ kind: "request", jobId: null });
      expect(pending.text).toBe("Also fix the one in CONTRIBUTING.md");
      expect((await queuedJobs()).map((j) => j.id)).toEqual([job.id]);
      expect(posts).toEqual(["It'll do that next."]);
    });

    it("refuses reply_to_run to a user who isn't a linked member", async () => {
      const { run } = await handedOff();
      const before = await listMessages(db, run.id);
      const { model, calls } = scriptedModel(
        toolCallResult("reply_to_run", { text: "Use British spelling." }),
        textResult("You need to link your account first."),
      );

      await turn(model, "Tell it to use British spelling", domain);

      expect(toolOutput(calls[1]!)).toMatchObject({ error: "link_required" });
      expect(await listMessages(db, run.id)).toEqual(before);
      expect(ephemerals).toHaveLength(1);
      expect(ephemerals[0]).toContain(`${APP_URL}/chat/link?state=s`);
    });

    it("tells the agent to ask a follow-up with ask_about_code when the latest run is a code question", async () => {
      const { run } = await handedOff();
      const before = await listMessages(db, run.id);
      const [query] = await db
        .insert(jobs)
        .values({
          organizationId: orgId,
          repositoryId: appRepoId,
          type: "chat.ask",
          taskType: "query",
          status: "completed",
          payload: {},
        })
        .returning();
      expect(
        await mapThreadRun(db, {
          organizationId: orgId,
          chatThreadId: chatThread.id,
          jobId: query!.id,
        }),
      ).not.toBeNull();
      const { model, calls } = scriptedModel(
        toolCallResult("reply_to_run", { text: "And where is it rendered?" }),
        textResult("Let me ask that."),
      );

      await turn(model, "And where is it rendered?");

      expect(toolOutput(calls[1]!)).toMatchObject({ error: "query_run" });
      expect(String(toolOutput(calls[1]!).message)).toContain("ask_about_code");
      expect(await listMessages(db, run.id)).toEqual(before);
    });

    it("gives every reply to the agent once the run has no active job", async () => {
      const { run, job } = await handedOff();
      await playRequestJob(job, { summary: "Fixed the typo in the README." });
      expect(await getRun(db, run.id)).toMatchObject({ status: "completed" });
      const messages = await listMessages(db, run.id);
      posts = [];
      const { model, calls } = scriptedModel(
        toolCallResult("reply_to_run", { text: "One more thing." }),
        textResult("It fixed the typo in the README."),
      );

      await turn(model, "What did it change?");

      expect(calls).toHaveLength(2);
      expect(reactions).toEqual([]);
      expect(systemOf(calls[0]!)).toContain(
        `This thread's coding task: ${run.id} (status: completed)`,
      );
      // A finished run takes no messages: the agent is told to start new work.
      expect(toolOutput(calls[1]!)).toMatchObject({ error: "no_active_run" });
      expect(await listMessages(db, run.id)).toEqual(messages);
      expect(posts).toEqual(["It fixed the typo in the README."]);

      // The session posted nothing in the thread: its answer is a run event for the responder.
      const assistantTexts = calls[0]!.prompt.flatMap((m) =>
        m.role === "assistant" ? m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])) : [],
      );
      expect(assistantTexts.some((t) => t.startsWith(`[coding task ${run.id}]`))).toBe(false);
      const [completion] = (await listRunEvents(db, orgId, chatThread.id)).filter(
        (e) => e.kind === "completion",
      );
      expect((completion!.body as { text: string }).text).toContain(
        "Fixed the typo in the README.",
      );
    });

    it("gives every reply to the agent when the run never started a job", async () => {
      const { run, job } = await handedOff();
      // The run waits (e.g. its job failed to enqueue): no queued or running job.
      await db.delete(jobs).where(eq(jobs.id, job.id));
      const { model, calls } = scriptedModel(textResult("It hasn't started yet."));

      await turn(model, "Is it working?");

      expect(calls).toHaveLength(1);
      expect(systemOf(calls[0]!)).toContain(`This thread's coding task: ${run.id}`);
      expect(systemOf(calls[0]!)).not.toContain("its session is working right now");
      expect(reactions).toEqual([]);
      expect(posts).toEqual(["It hasn't started yet."]);
    });
  });
  describe("answers to the thread's run", () => {
    const REQUEST_ID = "4f7c4e6e-9d1a-4c43-9d5e-1a2b3c4d5e6f";

    /** Starts the thread's run, starts its job and has its session ask about a Bash call. */
    async function askedPermission() {
      await handOff({ repository: "acme/app", request: REQUEST });
      const run = (await threadRun())!;
      const [job] = await queuedJobs();
      await startRequestJob(job!);
      const deps = ralph();
      expect(
        await askPermission({ db, linear: async () => deps.linear, chat: deps.chat }, job!, {
          requestId: REQUEST_ID,
          tool: "Bash",
          detail: "git commit -m 'Fix the typo'",
          timeoutSeconds: 1800,
        }),
      ).toEqual({ status: "asked" });
      posts = [];
      return { run, job: job! };
    }

    /** A turn whose model calls `tool` with `input`, then answers "Done.". */
    async function toolTurn(
      tool: string,
      input: unknown,
      actor: ChatActor = member,
      where: Parameters<typeof turn>[3] = {},
    ) {
      const { model, calls } = scriptedModel(toolCallResult(tool, input), textResult("Done."));
      await turn(model, "yes", actor, where);
      return { calls, output: toolOutput(calls[1]!) };
    }

    const permissionOf = async (run: RalphRun) => (await getRun(db, run.id))!.permission;

    it("relays a permission request once, and a member's yes reaches the run through answer_run_permission", async () => {
      const { run } = await askedPermission();
      const relay = "Ralph wants to run `git commit` (Bash). Approve or deny?";
      const wake = scriptedModel(textResult(relay));
      expect(
        await processThreadRunEvents(
          {
            db,
            model: wake.model,
            channel: ralph().chat!,
            logger,
            rateLimits: {
              wakePerOrganization: () => ({
                key: `test:wake:${randomUUID()}`,
                limit: 10,
                windowSeconds: 60,
              }),
            },
          },
          chatThread.id,
        ),
      ).toMatchObject({ status: "processed", posted: 1 });
      expect(vi.mocked(adapter.postMessage)).toHaveBeenCalledTimes(1);

      const { model, calls } = scriptedModel(
        toolCallResult("answer_run_permission", { allow: true }),
        textResult("Approved: it carries on."),
      );
      await turn(model, "yes");

      expect(systemOf(calls[0]!)).toContain("answer_run_permission");
      expect(toolOutput(calls[1]!)).toMatchObject({
        status: "answered",
        answer: "allowed",
        tool: "Bash",
        run: { id: run.id },
      });
      expect(await permissionOf(run)).toMatchObject({
        requestId: REQUEST_ID,
        answer: "allowed",
        answeredBy: "Ada",
      });
      expect(posts).toEqual(["Approved: it carries on."]);
      // The run's note is a run event for the responder, not a post.
      const note = (await listRunEvents(db, orgId, chatThread.id)).at(-1)!;
      expect(note).toMatchObject({
        kind: "response",
        idempotencyKey: expect.stringContaining(`:permission:${REQUEST_ID}:answer`),
      });
      expect((note.body as { text: string }).text).toBe("Allowed **Bash**. Carrying on.");
      expect(vi.mocked(adapter.postMessage)).toHaveBeenCalledTimes(1);

      // A second answer finds the question answered already.
      const again = await toolTurn("answer_run_permission", { allow: false });
      expect(again.output).toMatchObject({ error: "not_open" });
      expect(await permissionOf(run)).toMatchObject({ answer: "allowed", answeredBy: "Ada" });
    });

    it("denies the call when the member says no", async () => {
      const { run } = await askedPermission();
      const { output } = await toolTurn("answer_run_permission", { allow: false });
      expect(output).toMatchObject({ status: "answered", answer: "denied" });
      expect(await permissionOf(run)).toMatchObject({ answer: "denied", answeredBy: "Ada" });
    });

    it("says not_open when the session that asked has ended, and no_question without a request", async () => {
      const { model: noRequest, calls } = scriptedModel(
        toolCallResult("answer_run_permission", { allow: true }),
        textResult("Nothing was waiting."),
      );
      await handOff({ repository: "acme/app", request: REQUEST });
      const [job] = await queuedJobs();
      await turn(noRequest, "yes");
      expect(toolOutput(calls[1]!)).toMatchObject({ error: "no_question" });

      await startRequestJob(job!);
      const deps = ralph();
      await askPermission({ db, linear: async () => deps.linear, chat: deps.chat }, job!, {
        requestId: REQUEST_ID,
        tool: "Bash",
        detail: "git push",
        timeoutSeconds: 1800,
      });
      await db.update(jobs).set({ status: "canceled" }).where(eq(jobs.id, job!.id));
      const { output } = await toolTurn("answer_run_permission", { allow: true });
      expect(output).toMatchObject({ error: "not_open" });
      expect((await permissionOf((await threadRun())!))?.answer).toBe("expired");
    });

    it("never answers a run of another thread or another organization", async () => {
      const { run, job } = await askedPermission();
      const before = await listMessages(db, run.id);
      const otherThread = (await ensureChatThread(db, {
        connectionId: connection.id,
        externalThreadId: "discord:G1:CH1:TH2",
        channelId: "discord:G1:CH1",
        startedByExternalUserId: "D1",
      }))!;
      const [otherOrg] = await db.insert(organizations).values({ name: "Other" }).returning();

      for (const where of [{ chatThread: otherThread }, { organizationId: otherOrg!.id }]) {
        expect(
          (await toolTurn("answer_run_permission", { allow: true }, member, where)).output,
        ).toMatchObject({ error: "no_question" });
        expect(
          (await toolTurn("reply_to_run", { text: "Use British spelling." }, member, where)).output,
        ).toMatchObject({ error: "no_active_run" });
        expect(
          (await toolTurn("answer_run_cleanup", { answer: "Delete" }, member, where)).output,
        ).toMatchObject({ error: "no_match" });
      }

      expect((await permissionOf(run))?.answer).toBeUndefined();
      expect(await listMessages(db, run.id)).toEqual(before);
      expect((await queuedJobs()).map((j) => j.id)).toEqual([job.id]);
      await db.delete(organizations).where(eq(organizations.id, otherOrg!.id));
    });

    it("gives a user who isn't a linked member link_required from every answer tool", async () => {
      const { run, job } = await askedPermission();
      const before = await listMessages(db, run.id);

      for (const [tool, input] of [
        ["reply_to_run", { text: "Use British spelling." }],
        ["answer_run_permission", { allow: true }],
        ["answer_run_cleanup", { answer: "Delete" }],
      ] as const) {
        expect((await toolTurn(tool, input, domain)).output).toEqual(LINK_REQUIRED_RESULT);
      }

      expect((await permissionOf(run))?.answer).toBeUndefined();
      expect(await listMessages(db, run.id)).toEqual(before);
      expect((await queuedJobs()).map((j) => j.id)).toEqual([job.id]);
    });
  });
});
