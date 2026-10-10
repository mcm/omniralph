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
  organizations,
  ralphRuns,
  runMigrations,
  saveChatConnection,
  seedReviewProfiles,
  startJob,
  updateRepositoryRalphSettings,
  upsertScmConnection,
  DEFAULT_RALPH_SETTINGS,
  type ChatConnection,
  type ChatThread,
  type Database,
  type Job,
  type RalphRun,
} from "@omniralph/db";
import {
  MAX_JOB_DELIVERIES,
  RalphRequestPayload,
  type RalphRequestResult,
} from "@omniralph/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { MockLanguageModelV2 } from "ai/test";
import type { Adapter, Logger, Message, Thread } from "chat";
import { and, asc, eq, inArray } from "drizzle-orm";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VercelQueuesDispatcher } from "@/lib/dispatch/dispatcher";
import { RecordingPublisher } from "@/lib/dispatch/recording-publisher";
import { FakeLinearGateway } from "@/lib/linear/fake-gateway";
import type { ChatChannel } from "@/lib/ralph/conversation";
import type { RalphDeps } from "@/lib/ralph/run";
import { FakeScmAdapter } from "@/lib/scm/fake-adapter";
import type { ChatConversationContext } from "../bot";
import type { ChatActor } from "../identity";

vi.mock("server-only", () => ({}));

const { createChatAgentHandler } = await import("./handler");
const { onRalphJobFinished, onRalphJobStarted } = await import("@/lib/ralph/jobs");

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

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
  return (result?.output as { type: string; value: unknown }).value as Record<string, unknown>;
};

const REQUEST =
  "Fix the typo in the README of acme/app. The heading says 'Omniralhp'; it should say 'Omniralph'.";

describe.skipIf(!dockerAvailable)("start_ralph_request", () => {
  const key = randomBytes(32);
  let container: StartedPostgreSqlContainer;
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
  let publisher: RecordingPublisher;
  let adapter: Adapter;
  let logger: Logger;

  const ralph = (): RalphDeps => ({
    db,
    organizationId: orgId,
    linear: new FakeLinearGateway(),
    dispatcher: new VercelQueuesDispatcher({ db, publisher }),
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
  async function turn(model: MockLanguageModelV2, text: string, actor: ChatActor = member) {
    await appendChatMessage(db, {
      threadId: chatThread.id,
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
      organizationId: orgId,
      connection,
      chatThread,
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
      ralph: async () => ralph(),
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
    const started = await startJob(db, {
      organizationId: orgId,
      jobId: job.id,
      agentId,
      enabledCapabilities: ["ralph"],
      maxDeliveries: MAX_JOB_DELIVERIES,
    });
    expect(started.action).toBe("run");
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

  /** The handoff turn: the model calls the tool with `input`, then ends with no text. */
  async function handOff(input: { repository: string; request: string }) {
    const scripted = scriptedModel(toolCallResult("start_ralph_request", input), textResult(""));
    await turn(scripted.model, "@omniralph fix the typo in the README of acme/app");
    return scripted.calls;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
    await seedReviewProfiles(db, orgId);
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
    for (const [externalId, fullPath, ralphEnabled] of [
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
      await updateRepositoryRalphSettings(db, repository.id, {
        ralphEnabled,
        linearTeamKeys: [],
        linearProjectNames: [],
        linearLabels: [],
        ralphSettings: DEFAULT_RALPH_SETTINGS,
      });
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
      .values({ organizationId: orgId, name: "agent-a", enabledCapabilities: ["ralph"] })
      .returning({ id: agents.id })) as [{ id: string }];
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await container?.stop();
  });

  beforeEach(async () => {
    await db.delete(jobs);
    await db.delete(ralphRuns);
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
    publisher = new RecordingPublisher();
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

  it("tells the agent to confirm an ambiguous repository and restate the handoff", async () => {
    const { model, calls } = scriptedModel(
      textResult("Which repository do you mean: acme/app or acme/web?"),
    );
    await turn(model, "@omniralph fix the typo in the README");

    const system = systemOf(calls[0]!);
    expect(system).toContain("confirm which repository");
    expect(system).toContain("restate what you are handing off");
    expect(calls[0]!.tools?.map((t) => t.name)).toContain("start_ralph_request");
    expect(posts).toEqual(["Which repository do you mean: acme/app or acme/web?"]);
    expect(await threadRun()).toBeNull();
    expect(await queuedJobs()).toEqual([]);
  });

  it("starts a chat run, announces it, enqueues its request job and completes in the thread", async () => {
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
    });
    expect(toolOutput(calls[1]!)).toMatchObject({
      status: "started",
      repository: "acme/app",
      followUp: false,
      run: { id: run.id, url: `${APP_URL}/ralph/${run.id}` },
    });
    // The handoff message is the only post of the turn (the agent's empty answer posts nothing).
    expect(posts).toEqual([
      [
        "Handing this to ralph in `acme/app`…",
        "> Fix the typo in the README of acme/app.",
        `Its progress and answer will follow here ([run](<${APP_URL}/ralph/${run.id}>)).`,
      ].join("\n\n"),
    ]);
    const recorded = await db
      .select({ role: chatMessages.role, ralphRunId: chatMessages.ralphRunId })
      .from(chatMessages)
      .where(eq(chatMessages.threadId, chatThread.id))
      .orderBy(asc(chatMessages.createdAt));
    expect(recorded.filter((m) => m.ralphRunId === run.id)).toHaveLength(1);
    expect(recorded.map((m) => m.role)).toEqual(["user", "assistant", "assistant", "tool"]);

    // The request: the agent's instruction, then the quoted user message.
    const [message] = await listMessages(db, run.id);
    expect(message).toMatchObject({ kind: "request", author: "Ada Lovelace" });
    expect(message!.text).toBe(
      `${REQUEST}\n\nFrom the chat thread:\n\n> **Ada Lovelace:** @omniralph fix the typo in the README of acme/app`,
    );

    // The job went out through the existing path, on the run's new branch.
    const [job, ...more] = await queuedJobs();
    expect(more).toEqual([]);
    expect(job).toMatchObject({ type: "ralph.request", ralphRunId: run.id, status: "queued" });
    expect(publisher.sent.map((s) => s.jobId)).toEqual([job!.id]);
    const payload = RalphRequestPayload.parse(job!.payload);
    expect(payload).toMatchObject({
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
    // Its later posts go to the thread through the bot's adapter: the status message.
    expect(adapter.postMessage).toHaveBeenCalledWith(THREAD_ID, {
      markdown: "⏳ Working on it\nWorking on your request.",
    });

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
    const markdown = vi
      .mocked(adapter.postMessage)
      .mock.calls.map(([, m]) => (m as { markdown: string }).markdown);
    expect(markdown).toContain(`Pull request #1: ${pr!.url}`);
    expect(markdown.at(-1)).toContain("Fixed the typo and opened a draft PR.");
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

  it("refuses a chat user who isn't a linked member", async () => {
    const { model, calls } = scriptedModel(
      toolCallResult("start_ralph_request", { repository: "acme/app", request: REQUEST }),
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

    const calls = await handOff({ repository: "acme/web", request: "Also bump the version." });

    expect(toolOutput(calls[1]!)).toMatchObject({
      error: "run_active",
      run: { id: first.id, status: "running" },
    });
    expect(String(toolOutput(calls[1]!).message)).toContain("send_to_session");
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
    expect(toolOutput(calls[1]!)).toMatchObject({ status: "started", followUp: true });
    expect(posts[0]).toContain("continuing the previous run's branch and pull request");
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
    const payload = RalphRequestPayload.parse(next!.payload);
    expect(payload).toMatchObject({ branch: firstLane.branch, prUrl: firstLane.prUrl });
    // The follow-up keeps the lane's base branch: it doesn't read the default branch again.
    expect(scm.calls.filter((c) => c === "getDefaultBranch")).toHaveLength(branchReads);
  });

  it("starts fresh when the thread's last run worked in another repository", async () => {
    await handOff({ repository: "acme/web", request: "Bump the version." });
    const first = (await threadRun())!;
    const [job] = await queuedJobs();
    await playRequestJob(job!, {});
    posts = [];

    await handOff({ repository: "acme/app", request: REQUEST });

    const second = (await threadRun())!;
    expect(second.id).not.toBe(first.id);
    expect(posts[0]).toMatch(/^Handing this to ralph in `acme\/app`…/);
    expect((await getMainLane(db, second))!).toMatchObject({
      branch: `omniralph/chat-${second.id.slice(0, 8)}`,
      prUrl: null,
    });
  });
  describe("thread replies", () => {
    const noModel = () => scriptedModel(textResult("I shouldn't be asked."));

    /** Hands off and returns the run with its queued request job. */
    async function handedOff() {
      await handOff({ repository: "acme/app", request: REQUEST });
      const run = (await threadRun())!;
      const [job] = await queuedJobs();
      posts = [];
      return { run, job: job! };
    }

    it("passes a member's plain reply to the running session and reacts to it", async () => {
      const { run, job } = await handedOff();
      await startRequestJob(job);
      const { model, calls } = noModel();

      const m = await turn(model, "Also fix the one in CONTRIBUTING.md");

      expect(calls).toEqual([]);
      expect(posts).toEqual([]);
      expect(reactions).toEqual([{ threadId: THREAD_ID, messageId: m.id, emoji: "eyes" }]);
      const messages = await listMessages(db, run.id);
      expect(messages.at(-1)).toMatchObject({
        kind: "request",
        jobId: job.id,
        text: "Also fix the one in CONTRIBUTING.md",
        author: "Ada Lovelace",
      });
      // No new job: the live session gets it in its next heartbeat.
      expect((await queuedJobs()).map((j) => j.id)).toEqual([job.id]);
    });

    it("keeps a plain reply as the next request while the job is queued", async () => {
      const { run, job } = await handedOff();
      const { model, calls } = noModel();

      const m = await turn(model, "Also fix the one in CONTRIBUTING.md");

      expect(calls).toEqual([]);
      expect(posts).toEqual([]);
      expect(reactions).toEqual([{ threadId: THREAD_ID, messageId: m.id, emoji: "eyes" }]);
      const pending = (await listMessages(db, run.id)).at(-1)!;
      expect(pending).toMatchObject({ kind: "request", jobId: null });
      expect(pending.text).toBe("Also fix the one in CONTRIBUTING.md");
      expect((await queuedJobs()).map((j) => j.id)).toEqual([job.id]);
    });

    it("sends a plain reply from a user who isn't a linked member the link prompt", async () => {
      const { run } = await handedOff();
      const before = await listMessages(db, run.id);
      const { model, calls } = noModel();

      await turn(model, "Also fix the one in CONTRIBUTING.md", domain);

      expect(calls).toEqual([]);
      expect(reactions).toEqual([]);
      expect(ephemerals).toHaveLength(1);
      expect(ephemerals[0]).toContain(`${APP_URL}/chat/link?state=s`);
      expect(await listMessages(db, run.id)).toEqual(before);
    });

    it("gives a mention to the agent, which can check on the run and pass a message on", async () => {
      const { run, job } = await handedOff();
      await startRequestJob(job);
      const { model, calls } = scriptedModel(
        toolCallResult("send_to_session", { text: "Use British spelling." }),
        textResult("Passed that on."),
      );

      await turn(model, "@omniralph tell it to use British spelling");

      const system = systemOf(calls[0]!);
      expect(system).toContain(`This thread's ralph run: ${run.id}`);
      expect(system).toContain("its session is working right now");
      const tools = calls[0]!.tools?.map((t) => t.name);
      expect(tools).toEqual(expect.arrayContaining(["get_ralph_run", "send_to_session"]));
      expect(toolOutput(calls[1]!)).toMatchObject({ status: "delivered", run: { id: run.id } });
      expect((await listMessages(db, run.id)).at(-1)).toMatchObject({
        kind: "request",
        jobId: job.id,
        text: "Use British spelling.",
      });
      expect(reactions).toEqual([]);
      expect(posts).toEqual(["Passed that on."]);
    });

    it("refuses send_to_session to a user who isn't a linked member", async () => {
      const { run } = await handedOff();
      const before = await listMessages(db, run.id);
      const { model, calls } = scriptedModel(
        toolCallResult("send_to_session", { text: "Use British spelling." }),
        textResult("You need to link your account first."),
      );

      await turn(model, "@omniralph tell it to use British spelling", domain);

      expect(toolOutput(calls[1]!)).toMatchObject({ error: "link_required" });
      expect(await listMessages(db, run.id)).toEqual(before);
    });

    it("gives every reply to the agent once the run has no active job", async () => {
      const { run, job } = await handedOff();
      await playRequestJob(job, { summary: "Fixed the typo in the README." });
      expect(await getRun(db, run.id)).toMatchObject({ status: "completed" });
      const messages = await listMessages(db, run.id);
      posts = [];
      const { model, calls } = scriptedModel(
        toolCallResult("send_to_session", { text: "One more thing." }),
        textResult("It fixed the typo in the README."),
      );

      await turn(model, "What did it change?");

      expect(calls).toHaveLength(2);
      expect(reactions).toEqual([]);
      expect(systemOf(calls[0]!)).toContain(
        `This thread's ralph run: ${run.id} (status: completed)`,
      );
      // A finished run takes no messages: the agent is told to start a new request.
      expect(toolOutput(calls[1]!)).toMatchObject({ error: "no_active_run" });
      expect(await listMessages(db, run.id)).toEqual(messages);
      expect(posts).toEqual(["It fixed the typo in the README."]);

      // The agent's history has the session's posts, marked as the run's.
      const assistantTexts = calls[0]!.prompt.flatMap((m) =>
        m.role === "assistant" ? m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])) : [],
      );
      expect(assistantTexts).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            new RegExp(`^\\[ralph run ${run.id}\\] .*Fixed the typo in the README\\.`, "s"),
          ),
        ]),
      );
    });

    it("gives every reply to the agent when the run never started a job", async () => {
      const { run, job } = await handedOff();
      // The run waits (e.g. its job failed to enqueue): no queued or running job.
      await db.delete(jobs).where(eq(jobs.id, job.id));
      const { model, calls } = scriptedModel(textResult("It hasn't started yet."));

      await turn(model, "Is it working?");

      expect(calls).toHaveLength(1);
      expect(systemOf(calls[0]!)).toContain(`This thread's ralph run: ${run.id}`);
      expect(systemOf(calls[0]!)).not.toContain("its session is working right now");
      expect(reactions).toEqual([]);
      expect(posts).toEqual(["It hasn't started yet."]);
    });
  });
});
