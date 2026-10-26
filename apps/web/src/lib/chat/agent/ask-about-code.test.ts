import { randomBytes, randomUUID } from "node:crypto";
import { createMockAdapter } from "@chat-adapter/tests";
import {
  agentRepoPins,
  appendChatMessage,
  agents,
  closeDb,
  createHostTool,
  deleteHostTool,
  insertPlaybook,
  recordAgentHostTools,
  listThreadRuns,
  connectRepository,
  createDb,
  ensureChatThread,
  jobs,
  listChatMessages,
  organizations,
  repositories,
  saveChatConnection,
  upsertChatChannelPlaybookSetting,
  upsertScmConnection,
  type ChatConnection,
  type ChatThread,
  type Database,
} from "@omniralph/db";
import {
  QUERY_TASKS_MIN_AGENT_VERSION,
  RunSpecJobPayload,
  type QueryRunResult,
} from "@omniralph/shared";
import { getBuiltinPlaybook, playbookRequirements, type Playbook } from "@omniralph/tasks";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { MockLanguageModelV2 } from "ai/test";
import type { Adapter, Logger, Message, Thread } from "chat";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresDispatcher } from "@/lib/dispatch/dispatcher";
import { FakeLinearGateway } from "@/lib/linear/fake-gateway";
import type { RalphDeps } from "@/lib/ralph/run";
import { FakeScmAdapter } from "@/lib/scm/fake-adapter";
import { threadAttachments } from "../attachments";
import type { ChatConversationContext } from "../bot";
import type { ChatActor } from "../identity";
import { toAiTools, type ChatToolContext } from "./tools";

vi.mock("server-only", () => ({}));

const { chatTools } = await import("./registry");
const { createChatAgentHandler } = await import("./handler");
const { chatAskContext, chatAskDedupeKey } = await import("../ask");
const { queryClaimableAgents } = await import("@/lib/agents/claimable");

const databaseAvailable = testDatabaseAvailable();

const APP_URL = "https://omniralph.example.com";
const member: ChatActor = { kind: "member", userId: "ada", role: "member", name: "Ada" };
const domain: ChatActor = { kind: "domain", email: "ada@acme.test" };
const unlinked: ChatActor = { kind: "unlinked" };

type Result = Record<string, unknown>;

describe("queryClaimableAgents", () => {
  const now = new Date("2026-10-10T12:00:00Z");
  type Overview = Parameters<typeof queryClaimableAgents>[0][number];
  const agent = (over: Partial<Overview> = {}) =>
    ({
      id: over.name ?? "a",
      name: "a",
      reportedVersion: "0.9.0",
      revokedAt: null,
      lastHeartbeatAt: now,
      reportedAcceptedTaskTypes: null,
      effective: { acceptedTaskTypes: ["query", "review"], maxConcurrency: 5 },
      reportedInstallables: [],
      pinnedRepositories: [],
      ...over,
    }) as unknown as Overview;
  const minimum = { minAgentVersion: "0.9.0", installables: [], hostTools: [] };
  const claimable = (agents: Overview[], repositoryId = "r1") =>
    queryClaimableAgents(agents, new Map(), repositoryId, minimum, now);

  it("counts online agents accepting query tasks on the minimum version or later", () => {
    expect(claimable([agent(), agent({ name: "newer", reportedVersion: "0.10.0" })])).toEqual([
      { name: "a", version: "0.9.0", capable: true },
      { name: "newer", version: "0.10.0", capable: true },
    ]);
    const incapable = [
      agent({ name: "old", reportedVersion: "0.8.0" }),
      agent({ name: "unknown", reportedVersion: null }),
      agent({
        name: "no-query",
        reportedAcceptedTaskTypes: ["review", "coding"],
        effective: { acceptedTaskTypes: ["review", "coding"], maxConcurrency: 5 },
      }),
      // Reporting no query tasks.
      agent({
        name: "no-query-reported",
        effective: { acceptedTaskTypes: ["review"], maxConcurrency: 5 },
      }),
    ];
    expect(claimable(incapable).map((h) => h.capable)).toEqual([false, false, false, false]);
  });

  it("only counts agents with every required installable and host tool", () => {
    const graph = { name: "@omniralph/code-graph", version: "1.0.0" };
    const hello = { name: "@omniralph/hello", version: "1.0.0" };
    const all = agent({ name: "all", reportedInstallables: [graph, hello] });
    const missingInstallable = agent({ name: "no-hello", reportedInstallables: [graph] });
    const missingHostTool = agent({ name: "no-semgrep", reportedInstallables: [graph, hello] });
    // As `listAgentsUsableHostTools`: tools with an effective path, by agent ID.
    const usable = new Map([
      ["all", ["opengrep", "semgrep"]],
      ["no-hello", ["opengrep", "semgrep"]],
      ["no-semgrep", ["opengrep"]],
    ]);
    const requirements = {
      minAgentVersion: "0.9.0",
      installables: [graph.name, hello.name],
      hostTools: ["opengrep", "semgrep"],
    };
    expect(
      queryClaimableAgents(
        [all, missingInstallable, missingHostTool],
        usable,
        "r1",
        requirements,
        now,
      ),
    ).toEqual([
      { name: "all", version: "0.9.0", capable: true },
      { name: "no-hello", version: "0.9.0", capable: false },
      { name: "no-semgrep", version: "0.9.0", capable: false },
    ]);
    // An agent with no usable host tools at all.
    expect(
      queryClaimableAgents([all], new Map(), "r1", requirements, now).map((h) => h.capable),
    ).toEqual([false]);
    // Without requirements, neither is needed.
    expect(
      queryClaimableAgents([missingInstallable], new Map(), "r1", minimum, now)[0]?.capable,
    ).toBe(true);
  });

  it("leaves out offline and revoked agents, and only counts pinned agents of a pinned repository", () => {
    const old = new Date(now.getTime() - 60 * 60_000);
    expect(
      claimable([agent({ lastHeartbeatAt: old }), agent({ revokedAt: now, name: "revoked" })]),
    ).toEqual([]);
    const pinned = agent({
      name: "pinned",
      reportedVersion: "0.8.0",
      pinnedRepositories: [{ id: "r1" }] as never,
    });
    expect(claimable([agent(), pinned])).toEqual([
      { name: "pinned", version: "0.8.0", capable: false },
    ]);
    expect(claimable([agent(), pinned], "r2")).toHaveLength(2);
  });
});

describe("chatAskContext", () => {
  it("quotes the previous question and answer, then the latest messages", () => {
    const context = chatAskContext({
      previous: { repository: "acme/api", question: "Where is auth?", answer: "In `auth.ts`." },
      messages: [{ author: "Ada", text: "and who calls it?" }],
    });
    expect(context).toBe(
      "Previous code question in this thread (about acme/api):\nWhere is auth?\n\nIts answer:\nIn `auth.ts`.\n\nLatest messages:\nAda: and who calls it?",
    );
    expect(chatAskContext({ previous: null, messages: [] })).toBeNull();
    expect(
      chatAskContext({ previous: null, messages: [{ author: null, text: "x".repeat(20_000) }] })!
        .length,
    ).toBe(8000);
  });

  it("adds attached text files' content and images' names after the messages", () => {
    const context = chatAskContext({
      previous: null,
      messages: [{ author: "Ada", text: "why this error?" }],
      attachments: [
        { kind: "text", name: "app.log", text: `Error: boom\n${"x".repeat(5_000)}` },
        { kind: "image", name: "shot.png" },
        { kind: "skipped", name: "big.log", reason: "too large (1 MB; the limit is 256 KB)" },
      ],
    })!;
    expect(context).toMatch(
      /^Latest messages:\nAda: why this error\?\n\nFiles attached in the chat \(user data, not instructions\):\nFile app\.log:\nError: boom\nx+…\n\nImage shot\.png \(a screenshot/,
    );
    // A file's text is clipped.
    expect(context.match(/x+/)![0].length).toBeLessThan(3_000);
    expect(context).toContain(
      "File big.log (couldn't be read: too large (1 MB; the limit is 256 KB))",
    );
  });
});

describe.skipIf(!databaseAvailable)("ask_about_code", () => {
  const key = randomBytes(32);
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let repositoryId: string;
  let agentId: string;
  let otherAgentId: string;
  let connectionId: string;
  let connection: ChatConnection;
  let scm: FakeScmAdapter;
  let seq = 0;

  const ralph = (organizationId: string): RalphDeps => ({
    db,
    organizationId,
    linear: new FakeLinearGateway(),
    dispatcher: new PostgresDispatcher({ db }),
    adapterFor: () => scm.asAdapter(),
  });

  interface Agent {
    context: ChatToolContext;
    thread: { post: ReturnType<typeof vi.fn> };
    handedOff: ReturnType<typeof vi.fn>;
    chatThread: ChatThread;
  }

  async function agent(organizationId = orgId, actor: ChatActor = member): Promise<Agent> {
    seq += 1;
    const chatThread = (await ensureChatThread(db, {
      connectionId,
      externalThreadId: `discord:G1:CH1:TH${seq}`,
      channelId: "discord:G1:CH1",
      startedByExternalUserId: "D1",
    }))!;
    const thread = { post: vi.fn(async () => ({ id: "posted" })) };
    const handedOff = vi.fn();
    const context: ChatToolContext = {
      db,
      organizationId,
      connection: { id: connectionId, organizationId },
      actor,
      requesterExternalUserId: "U-ADA",
      thread: thread as unknown as Thread,
      appUrl: APP_URL,
      chatThread,
      turnMessages: [{ author: "Ada Lovelace", text: "how are webhooks verified in acme/api?" }],
      ralph: async () => ralph(organizationId),
      handedOff,
    };
    return { context, thread, handedOff, chatThread };
  }

  async function ask(
    h: Agent,
    input: { repository: string; question: string; attachments?: string[] },
  ) {
    const tool = chatTools.ask_about_code!;
    return (await tool.execute(tool.inputSchema.parse(input), h.context)) as Result;
  }

  const chatAskJobs = (chatThreadId: string) =>
    db
      .select()
      .from(jobs)
      .where(and(eq(jobs.type, "chat.ask"), eq(jobs.organizationId, orgId)))
      .then((rows) =>
        rows.filter(
          (j) => RunSpecJobPayload.parse(j.payload).trigger.context.chatThreadId === chatThreadId,
        ),
      );

  /** A code question's conversation excerpt, as its trigger context stores it. */
  const contextOf = (payload: unknown) =>
    (RunSpecJobPayload.parse(payload).trigger.context.chat as { context: string | null }).context;

  async function seedOrg(name: string, slug: string) {
    const [org] = await db.insert(organizations).values({ name }).returning();
    const connection = (await upsertScmConnection(
      db,
      {
        organizationId: org!.id,
        provider: "github",
        name: slug,
        baseUrl: "https://api.github.com",
        externalId: `conn-${slug}`,
        credentials: {},
      },
      key,
    ))!;
    // Not ralph-enabled: code questions work in any connected repository.
    const repository = await connectRepository(db, {
      connectionId: connection.id,
      provider: "github",
      externalId: `repo-${slug}`,
      fullPath: `${slug}/api`,
    });
    const [agent] = await db
      .insert(agents)
      .values({ organizationId: org!.id, name: `${slug}-agent` })
      .returning();
    return { id: org!.id, repositoryId: repository.id, agentId: agent!.id };
  }

  const setAgent = (id: string, values: Partial<typeof agents.$inferInsert>) =>
    db.update(agents).set(values).where(eq(agents.id, id));

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    ({ id: orgId, repositoryId, agentId } = await seedOrg("Acme", "acme"));
    ({ agentId: otherAgentId } = await seedOrg("Other", "other"));
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
    connectionId = saved.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    scm = new FakeScmAdapter();
    const capable = {
      reportedVersion: QUERY_TASKS_MIN_AGENT_VERSION,
      lastHeartbeatAt: new Date(),
      revokedAt: null,
    };
    await setAgent(agentId, capable);
    await setAgent(otherAgentId, capable);
    await db.delete(agentRepoPins);
    await db.execute("DELETE FROM chat_channel_task_settings");
  });

  it("is a read tool", () => {
    expect(chatTools.ask_about_code?.tier).toBe("read");
  });

  it("enqueues a builtin:ask-about-code run of the default branch and returns its id without posting", async () => {
    const h = await agent();

    const result = await ask(h, {
      repository: "ACME/api",
      question: "How are webhooks verified?",
    });

    const [job] = await chatAskJobs(h.chatThread.id);
    expect(result).toMatchObject({
      status: "started",
      runId: job!.id,
      task: "builtin:ask-about-code",
      repository: "acme/api",
    });
    expect(job).toMatchObject({
      status: "queued",
      repositoryId,
      targetAgentId: null,
      taskType: "query",
      taskId: "builtin:ask-about-code",
      minAgentVersion: QUERY_TASKS_MIN_AGENT_VERSION,
      dedupeKey: chatAskDedupeKey(h.chatThread.id, "How are webhooks verified?"),
    });
    const payload = RunSpecJobPayload.parse(job!.payload);
    expect(payload).toEqual({
      trigger: {
        kind: "chat.request",
        context: {
          repository: "acme/api",
          branch: "develop",
          provider: "github",
          question: "How are webhooks verified?",
          chatThreadId: h.chatThread.id,
          chat: {
            context: "Latest messages:\nAda Lovelace: how are webhooks verified in acme/api?",
          },
          // 25% of the default profile's budget.
          budgetTokens: 50_000,
        },
      },
      repositoryId,
      ref: "develop",
      requireCheckout: true,
    });
    // The thread's query run.
    expect(await listThreadRuns(db, orgId, h.chatThread.id)).toMatchObject([
      { kind: "query", jobId: job!.id, ralphRunId: null },
    ]);
    // The tool posts nothing: the responder's reply says it started.
    expect(h.thread.post).not.toHaveBeenCalled();
    expect(h.handedOff).not.toHaveBeenCalled();
    expect(await listChatMessages(db, h.chatThread.id, 10)).toEqual([]);
  });

  it("includes attached files in the question's context", async () => {
    const h = await agent();
    await appendChatMessage(db, {
      threadId: h.chatThread.id,
      role: "user",
      authorName: "Ada Lovelace",
      content: "this fails, see log and screenshot",
      attachments: [
        {
          type: "file",
          name: "app.log",
          mimeType: "text/plain",
          size: 31,
          url: "https://files.example/app.log",
          fetchMetadata: null,
        },
        {
          type: "image",
          name: "shot.png",
          mimeType: "image/png",
          size: 8,
          url: "https://files.example/shot.png",
          fetchMetadata: null,
        },
      ],
    });
    h.context.attachments = await threadAttachments(
      await listChatMessages(db, h.chatThread.id, 50),
      async (meta) =>
        meta.name === "app.log"
          ? Buffer.from("Error: signature mismatch at 12")
          : Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
    );
    const refs = [...h.context.attachments.keys()];

    const unknown = await ask(h, {
      repository: "acme/api",
      question: "Why does verification fail?",
      attachments: ["nope-1"],
    });
    expect(unknown).toMatchObject({ error: "unknown_attachment" });
    expect(await chatAskJobs(h.chatThread.id)).toEqual([]);

    const result = await ask(h, {
      repository: "acme/api",
      question: "Why does webhook verification fail with this log? The screenshot shows a 401.",
      attachments: refs,
    });
    expect(result).toMatchObject({ status: "started" });
    const [job] = await chatAskJobs(h.chatThread.id);
    const context = contextOf(job!.payload);
    expect(context).toContain("File app.log:\nError: signature mismatch at 12");
    expect(context).toContain("Image shot.png");
  });

  it("lets a colleague on the organization's email domain ask", async () => {
    const h = await agent(orgId, domain);
    const tools = toAiTools(chatTools, h.context, vi.fn());
    const result = (await tools.ask_about_code!.execute!(
      { repository: "acme/api", question: "Which ORM do we use?" },
      { toolCallId: "1", messages: [] },
    )) as Result;
    expect(result).toMatchObject({ status: "started" });
    expect(await chatAskJobs(h.chatThread.id)).toHaveLength(1);
  });

  it("asks the same question in a thread only once while it runs", async () => {
    const h = await agent();
    await ask(h, { repository: "acme/api", question: "Where is the retry logic?" });
    h.thread.post.mockClear();

    const again = await ask(h, {
      repository: "acme/api",
      question: "  where is the RETRY logic? ",
    });

    const [first] = await chatAskJobs(h.chatThread.id);
    expect(again).toMatchObject({ status: "already_asked", runId: first!.id });
    expect(await chatAskJobs(h.chatThread.id)).toHaveLength(1);
    expect(h.thread.post).not.toHaveBeenCalled();
    // A different question, or the same one in another thread, is asked.
    await ask(h, { repository: "acme/api", question: "Where is the backoff configured?" });
    expect(await chatAskJobs(h.chatThread.id)).toHaveLength(2);
    const other = await agent();
    await ask(other, { repository: "acme/api", question: "Where is the retry logic?" });
    expect(await chatAskJobs(other.chatThread.id)).toHaveLength(1);
  });

  it("quotes the thread's previous question and answer in a follow-up's context", async () => {
    const h = await agent();
    await ask(h, { repository: "acme/api", question: "Where are sessions stored?" });
    const [first] = await chatAskJobs(h.chatThread.id);
    const result: QueryRunResult = {
      answer: "In Redis, see `src/session.ts`.",
      outcome: "answered",
      structured: null,
      references: [],
      usage: { inputTokens: 10, outputTokens: 5 },
      durationMs: 1,
    };
    await db
      .update(jobs)
      .set({ status: "completed", result, finishedAt: new Date() })
      .where(eq(jobs.id, first!.id));

    await ask(h, { repository: "acme/api", question: "How long do they live?" });

    const followUp = (await chatAskJobs(h.chatThread.id)).find((j) => j.id !== first!.id)!;
    const context = contextOf(followUp.payload)!;
    expect(context).toContain(
      "Previous code question in this thread (about acme/api):\nWhere are sessions stored?",
    );
    expect(context).toContain("Its answer:\nIn Redis, see `src/session.ts`.");
  });

  it("refuses a repository the organization hasn't connected", async () => {
    const h = await agent();
    for (const repository of ["acme/web", "other/api"]) {
      const result = await ask(h, { repository, question: "What is this?" });
      expect(result).toMatchObject({ error: "unknown_repository" });
    }
    expect(await chatAskJobs(h.chatThread.id)).toEqual([]);
    expect(h.thread.post).not.toHaveBeenCalled();
  });

  it("enqueues nothing and says so when the repository's Ask switch is off", async () => {
    const setAsk = (askEnabled: boolean) =>
      db.update(repositories).set({ askEnabled }).where(eq(repositories.id, repositoryId));
    const h = await agent();
    try {
      await setAsk(false);
      const off = await ask(h, { repository: "acme/api", question: "How is auth done?" });
      expect(off).toMatchObject({ error: "query_disabled" });
      expect(off.message).toContain("Ask is turned off for acme/api");
      expect(off.message).toContain(`Ask switch on ${APP_URL}/repos/${repositoryId}?section=ask.`);
      expect(await chatAskJobs(h.chatThread.id)).toEqual([]);

      // Ask on answers (on an agent taking queries).
      await setAsk(true);
      await setAgent(agentId, { reportedAcceptedTaskTypes: ["query"] });
      expect(await ask(h, { repository: "acme/api", question: "How is auth done?" })).toMatchObject(
        { status: "started" },
      );
      expect(await chatAskJobs(h.chatThread.id)).toHaveLength(1);
    } finally {
      await setAsk(true);
      await setAgent(agentId, { reportedAcceptedTaskTypes: null });
    }
    expect(h.thread.post).not.toHaveBeenCalled();
  });

  it("enqueues nothing when no online agent can answer code questions", async () => {
    const h = await agent();

    await setAgent(agentId, { reportedVersion: "0.8.0" });
    const old = await ask(h, { repository: "acme/api", question: "What is this?" });
    expect(old).toMatchObject({
      error: "no_capable_agent",
      agents: [{ name: "acme-agent", version: "0.8.0", capable: false }],
    });
    expect(old.message).toContain(QUERY_TASKS_MIN_AGENT_VERSION);

    await setAgent(agentId, {
      reportedVersion: QUERY_TASKS_MIN_AGENT_VERSION,
      lastHeartbeatAt: null,
    });
    const offline = await ask(h, { repository: "acme/api", question: "What is this?" });
    expect(offline).toMatchObject({ error: "no_capable_agent", agents: [] });
    expect(offline.message).toContain("online");

    expect(await chatAskJobs(h.chatThread.id)).toEqual([]);
    expect(h.thread.post).not.toHaveBeenCalled();
  });

  it("only counts the agents a pinned repository's jobs go to", async () => {
    const h = await agent();
    const [pinned] = await db
      .insert(agents)
      .values({
        organizationId: orgId,
        name: "pinned-agent",
        reportedVersion: "0.5.0",
        lastHeartbeatAt: new Date(),
      })
      .returning();
    await db.insert(agentRepoPins).values({ agentId: pinned!.id, repositoryId });

    const result = await ask(h, { repository: "acme/api", question: "What is this?" });

    expect(result).toMatchObject({
      error: "no_capable_agent",
      agents: [{ name: "pinned-agent", capable: false }],
    });
    await db.delete(agents).where(eq(agents.id, pinned!.id));
  });

  it("runs the channel's ask about code playbook and enqueues nothing when it can't run", async () => {
    const h = await agent();
    await upsertChatChannelPlaybookSetting(db, {
      organizationId: orgId,
      connectionId,
      channelId: h.chatThread.channelId,
      askPlaybookId: "builtin:handle-request",
      startWorkPlaybookId: null,
      updatedBy: null,
    });

    const result = await ask(h, { repository: "acme/api", question: "What is this?" });

    expect(result).toMatchObject({ error: "playbook_unavailable" });
    expect(String(result.message)).toContain("needs a chat-ask playbook");
    expect(await chatAskJobs(h.chatThread.id)).toEqual([]);
    expect(await listThreadRuns(db, orgId, h.chatThread.id)).toEqual([]);
  });

  it("runs the organization's own chat-ask playbook a channel picked, by its UUID", async () => {
    const h = await agent();
    const {
      id: _id,
      name: _name,
      role,
      ...definition
    } = getBuiltinPlaybook("builtin:ask-about-code")!;
    const stored = await insertPlaybook(db, orgId, {
      name: "Security Q&A",
      role,
      definition,
      requirements: playbookRequirements(getBuiltinPlaybook("builtin:ask-about-code")!),
      createdBy: null,
    });
    await upsertChatChannelPlaybookSetting(db, {
      organizationId: orgId,
      connectionId,
      channelId: h.chatThread.channelId,
      askPlaybookId: stored.id,
      startWorkPlaybookId: null,
      updatedBy: null,
    });

    const result = await ask(h, { repository: "acme/api", question: "What is this?" });

    const [job, ...more] = await chatAskJobs(h.chatThread.id);
    expect(more).toEqual([]);
    expect(job).toMatchObject({ taskId: stored.id, taskType: "query", status: "queued" });
    expect(result).toMatchObject({ status: "started", runId: job!.id, task: stored.id });
  });

  it("enqueues nothing until an agent has the task's installables and host tools", async () => {
    const h = await agent();
    const builtin = getBuiltinPlaybook("builtin:ask-about-code")!;
    const {
      id: _id,
      name: _name,
      role,
      ...definition
    } = {
      ...builtin,
      requires: { installables: ["@omniralph/code-graph"], hostTools: ["opengrep"] },
    };
    const stored = await insertPlaybook(db, orgId, {
      name: "Graph Q&A",
      role,
      definition,
      requirements: playbookRequirements({ ...builtin, ...definition }),
      createdBy: null,
    });
    await upsertChatChannelPlaybookSetting(db, {
      organizationId: orgId,
      connectionId,
      channelId: h.chatThread.channelId,
      askPlaybookId: stored.id,
      startWorkPlaybookId: null,
      updatedBy: null,
    });
    const tool = await createHostTool(db, orgId, { name: "opengrep" });
    if (!tool.ok) throw new Error("setup");

    try {
      const missingBoth = await ask(h, { repository: "acme/api", question: "What is this?" });
      expect(missingBoth).toMatchObject({
        error: "no_capable_agent",
        agents: [{ name: "acme-agent", capable: false }],
      });
      expect(missingBoth.message).toContain("@omniralph/code-graph");
      expect(missingBoth.message).toContain("opengrep");

      // The installable alone isn't enough: the host tool has no path on the agent.
      await setAgent(agentId, {
        reportedInstallables: [{ name: "@omniralph/code-graph", version: "1.0.0" }],
      });
      await recordAgentHostTools(db, orgId, agentId, [
        { name: "opengrep", configuredPathExists: null, discoveredPath: null },
      ]);
      expect(await ask(h, { repository: "acme/api", question: "What is this?" })).toMatchObject({
        error: "no_capable_agent",
        agents: [{ name: "acme-agent", capable: false }],
      });

      // The host tool alone isn't enough either.
      await setAgent(agentId, { reportedInstallables: [] });
      await recordAgentHostTools(db, orgId, agentId, [
        { name: "opengrep", configuredPathExists: null, discoveredPath: "/usr/bin/opengrep" },
      ]);
      expect(await ask(h, { repository: "acme/api", question: "What is this?" })).toMatchObject({
        error: "no_capable_agent",
      });
      expect(await chatAskJobs(h.chatThread.id)).toEqual([]);

      await setAgent(agentId, {
        reportedInstallables: [{ name: "@omniralph/code-graph", version: "1.0.0" }],
      });
      const result = await ask(h, { repository: "acme/api", question: "What is this?" });
      const [job] = await chatAskJobs(h.chatThread.id);
      expect(result).toMatchObject({ status: "started", runId: job!.id });
      expect(job).toMatchObject({
        requiredInstallables: ["@omniralph/code-graph"],
        requiredHostTools: ["opengrep"],
      });
    } finally {
      await setAgent(agentId, { reportedInstallables: [] });
      await deleteHostTool(db, orgId, tool.hostTool.id);
    }
  });

  describe("in a responder turn", () => {
    const USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
    type CallOptions = Parameters<MockLanguageModelV2["doGenerate"]>[0];
    type GenerateResult = Awaited<ReturnType<MockLanguageModelV2["doGenerate"]>>;
    const REPLY =
      "I'm looking into how webhooks are verified in acme/api; the answer will follow here.";
    /** A custom chat-ask playbook the channel picked (looked up through the injected lookup). */
    const customPlaybook: Playbook = {
      ...getBuiltinPlaybook("builtin:ask-about-code")!,
      id: "00000000-0000-4000-8000-0000000000ab",
      name: "Ask briefly",
    };
    const getPlaybook = (id: string) =>
      id === customPlaybook.id ? customPlaybook : (getBuiltinPlaybook(id) ?? null);

    it("starts a run of the channel's override playbook and posts only the responder's reply", async () => {
      const chatThread = (await ensureChatThread(db, {
        connectionId,
        externalThreadId: "discord:G1:CH2:TURN",
        channelId: "discord:G1:CH2",
        startedByExternalUserId: "D1",
      }))!;
      await upsertChatChannelPlaybookSetting(db, {
        organizationId: orgId,
        connectionId,
        channelId: chatThread.channelId,
        askPlaybookId: customPlaybook.id,
        startWorkPlaybookId: null,
        updatedBy: null,
      });
      const calls: CallOptions[] = [];
      const results: GenerateResult[] = [
        {
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "ask_about_code",
              input: JSON.stringify({
                repository: "acme/api",
                question: "How are webhooks verified?",
              }),
            },
          ],
          finishReason: "tool-calls",
          usage: USAGE,
          warnings: [],
        },
        {
          content: [{ type: "text", text: REPLY }],
          finishReason: "stop",
          usage: USAGE,
          warnings: [],
        },
      ];
      const model = new MockLanguageModelV2({
        doGenerate: async (options) => {
          calls.push(options);
          return results[Math.min(calls.length - 1, results.length - 1)]!;
        },
      });
      const adapter: Adapter = createMockAdapter("discord");
      const posts: string[] = [];
      const thread = {
        id: chatThread.externalThreadId,
        adapter,
        async post(message: string | { markdown: string }) {
          posts.push(typeof message === "string" ? message : message.markdown);
          return {};
        },
        async startTyping() {},
        get state() {
          return Promise.resolve(null);
        },
        async setState() {},
      } as unknown as Thread;
      const text = "@omniralph how are webhooks verified in acme/api?";
      await appendChatMessage(db, {
        threadId: chatThread.id,
        role: "user",
        externalUserId: "D1",
        authorName: "Ada Lovelace",
        content: text,
      });
      const message = {
        id: "msg-1",
        text,
        isMention: true,
        author: { userId: "D1", userName: "ada", fullName: "Ada Lovelace" },
      } as Message;
      const logger = {
        child: () => logger,
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as unknown as Logger;
      const context: ChatConversationContext = {
        organizationId: orgId,
        connection,
        chatThread,
        skipped: [],
        thread,
        message,
        actor: member,
        logger,
        linkUrl: async () => `${APP_URL}/chat/link?state=s`,
      };
      const handler = createChatAgentHandler({
        db,
        model,
        env: { APP_URL } as unknown as NodeJS.ProcessEnv,
        logger,
        getPlaybook,
        ralph: async () => ralph(orgId),
        rateLimits: {
          perOrganization: () => ({ key: `test:org:${randomUUID()}`, limit: 1, windowSeconds: 60 }),
          perChatUser: () => ({ key: `test:user:${randomUUID()}`, limit: 1, windowSeconds: 60 }),
        },
      });

      await handler.handle(thread, message, context);

      const [job, ...more] = await chatAskJobs(chatThread.id);
      expect(more).toEqual([]);
      expect(job).toMatchObject({ taskId: customPlaybook.id, taskType: "query", status: "queued" });
      expect(await listThreadRuns(db, orgId, chatThread.id)).toMatchObject([
        { kind: "query", jobId: job!.id },
      ]);
      // The tool result the model saw carries the run's id.
      const toolResult = calls[1]!.prompt.flatMap((m) =>
        m.role === "tool" ? m.content.map((p) => p.output) : [],
      )[0] as { type: string; value: Record<string, unknown> };
      expect(toolResult.value).toMatchObject({
        status: "started",
        runId: job!.id,
        task: customPlaybook.id,
      });
      // Exactly one message for the turn: the responder's reply.
      expect(posts).toEqual([REPLY]);
      expect(adapter.postMessage).not.toHaveBeenCalled();
      const recorded = await listChatMessages(db, chatThread.id, 10);
      expect(recorded.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    });
  });

  it("gives an unlinked user no way to ask", async () => {
    const h = await agent(orgId, unlinked);
    expect(toAiTools(chatTools, h.context, vi.fn())).toEqual({});
    expect(await chatAskJobs(h.chatThread.id)).toEqual([]);
  });
});
