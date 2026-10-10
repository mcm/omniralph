import { randomBytes } from "node:crypto";
import {
  agentRepoPins,
  appendChatMessage,
  agents,
  closeDb,
  connectRepository,
  createDb,
  ensureChatThread,
  jobs,
  listChatMessages,
  organizations,
  runMigrations,
  saveChatConnection,
  seedReviewProfiles,
  upsertScmConnection,
  type ChatThread,
  type Database,
} from "@omniralph/db";
import { ChatAskJobPayload, type ChatAskJobResult } from "@omniralph/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Thread } from "chat";
import { and, eq } from "drizzle-orm";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VercelQueuesDispatcher } from "@/lib/dispatch/dispatcher";
import { RecordingPublisher } from "@/lib/dispatch/recording-publisher";
import { FakeLinearGateway } from "@/lib/linear/fake-gateway";
import type { RalphDeps } from "@/lib/ralph/run";
import { FakeScmAdapter } from "@/lib/scm/fake-adapter";
import { threadAttachments } from "../attachments";
import type { ChatActor } from "../identity";
import { toAiTools, type ChatToolContext } from "./tools";

vi.mock("server-only", () => ({}));

const { chatTools } = await import("./registry");
const { chatAskAgents, chatAskContext } = await import("../ask");

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

const APP_URL = "https://omniralph.example.com";
const member: ChatActor = { kind: "member", userId: "ada", role: "member", name: "Ada" };
const domain: ChatActor = { kind: "domain", email: "ada@acme.test" };
const unlinked: ChatActor = { kind: "unlinked" };

type Result = Record<string, unknown>;

describe("chatAskAgents", () => {
  const now = new Date("2026-10-10T12:00:00Z");
  const agent = (over: Partial<Parameters<typeof chatAskAgents>[0][number]> = {}) =>
    ({
      name: "a",
      reportedVersion: "0.8.0",
      revokedAt: null,
      lastHeartbeatAt: now,
      enabledCapabilities: ["review"],
      reportedCapabilities: ["review"],
      pinnedRepositories: [],
      ...over,
    }) as unknown as Parameters<typeof chatAskAgents>[0][number];

  it("counts online agents running the review capability at a recent enough version", () => {
    expect(chatAskAgents([agent()], "r1", now)).toEqual([
      { name: "a", version: "0.8.0", capable: true },
    ]);
    const incapable = [
      agent({ name: "old", reportedVersion: "0.7.0" }),
      agent({ name: "unknown", reportedVersion: null }),
      agent({ name: "disabled", enabledCapabilities: ["ralph"] }),
      agent({ name: "unreported", reportedCapabilities: ["ralph"] }),
    ];
    expect(chatAskAgents(incapable, "r1", now).map((a) => a.capable)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it("leaves out offline and revoked agents, and only counts pinned agents of a pinned repository", () => {
    const old = new Date(now.getTime() - 60 * 60_000);
    expect(
      chatAskAgents(
        [agent({ lastHeartbeatAt: old }), agent({ revokedAt: now, name: "revoked" })],
        "r1",
        now,
      ),
    ).toEqual([]);
    const pinned = agent({
      name: "pinned",
      reportedVersion: "0.7.0",
      pinnedRepositories: [{ id: "r1" }] as never,
    });
    expect(chatAskAgents([agent(), pinned], "r1", now)).toEqual([
      { name: "pinned", version: "0.7.0", capable: false },
    ]);
    expect(chatAskAgents([agent(), pinned], "r2", now)).toHaveLength(2);
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

describe.skipIf(!dockerAvailable)("ask_about_code", () => {
  const key = randomBytes(32);
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let orgId: string;
  let repositoryId: string;
  let agentId: string;
  let otherAgentId: string;
  let connectionId: string;
  let publisher: RecordingPublisher;
  let scm: FakeScmAdapter;
  let seq = 0;

  const ralph = (organizationId: string): RalphDeps => ({
    db,
    organizationId,
    linear: new FakeLinearGateway(),
    dispatcher: new VercelQueuesDispatcher({ db, publisher }),
    adapterFor: () => scm.asAdapter(),
  });

  interface Harness {
    context: ChatToolContext;
    thread: { post: ReturnType<typeof vi.fn> };
    handedOff: ReturnType<typeof vi.fn>;
    chatThread: ChatThread;
  }

  async function harness(organizationId = orgId, actor: ChatActor = member): Promise<Harness> {
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
    h: Harness,
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
        rows.filter((j) => (j.payload as { chatThreadId?: string }).chatThreadId === chatThreadId),
      );

  async function seedOrg(name: string, slug: string) {
    const [org] = await db.insert(organizations).values({ name }).returning();
    await seedReviewProfiles(db, org!.id);
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
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
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
    connectionId = saved.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await container?.stop();
  });

  beforeEach(async () => {
    publisher = new RecordingPublisher();
    scm = new FakeScmAdapter();
    const capable = {
      reportedVersion: "0.8.0",
      reportedCapabilities: ["review", "ralph"],
      lastHeartbeatAt: new Date(),
      revokedAt: null,
    };
    await setAgent(agentId, capable);
    await setAgent(otherAgentId, capable);
    await db.delete(agentRepoPins);
  });

  it("is a read tool", () => {
    expect(chatTools.ask_about_code?.tier).toBe("read");
  });

  it("enqueues a chat.ask job of the default branch and says it's looking into it", async () => {
    const h = await harness();

    const result = await ask(h, {
      repository: "ACME/api",
      question: "How are webhooks verified?",
    });

    expect(result).toMatchObject({ status: "asked" });
    const [job] = await chatAskJobs(h.chatThread.id);
    expect(job).toMatchObject({ capability: "review", status: "queued", repositoryId });
    const payload = ChatAskJobPayload.parse(job!.payload);
    expect(payload).toMatchObject({
      repositoryId,
      repository: { provider: "github", fullPath: "acme/api" },
      defaultBranch: "develop",
      question: "How are webhooks verified?",
      chatThreadId: h.chatThread.id,
      maxTokens: expect.any(Number),
    });
    expect(payload.context).toBe(
      "Latest messages:\nAda Lovelace: how are webhooks verified in acme/api?",
    );
    expect(publisher.sent).toEqual([{ topic: `review-jobs-org-${orgId}`, jobId: job!.id }]);
    expect(h.thread.post).toHaveBeenCalledWith({ markdown: "Looking into `acme/api`…" });
    expect(h.handedOff).toHaveBeenCalled();
    expect((await listChatMessages(db, h.chatThread.id, 10)).at(-1)).toMatchObject({
      role: "assistant",
      content: "Looking into `acme/api`…",
    });
  });

  it("includes attached files in the question's context", async () => {
    const h = await harness();
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
    expect(result).toMatchObject({ status: "asked" });
    const [job] = await chatAskJobs(h.chatThread.id);
    const { context } = ChatAskJobPayload.parse(job!.payload);
    expect(context).toContain("File app.log:\nError: signature mismatch at 12");
    expect(context).toContain("Image shot.png");
  });

  it("lets a colleague on the organization's email domain ask", async () => {
    const h = await harness(orgId, domain);
    const tools = toAiTools(chatTools, h.context, vi.fn());
    const result = (await tools.ask_about_code!.execute!(
      { repository: "acme/api", question: "Which ORM do we use?" },
      { toolCallId: "1", messages: [] },
    )) as Result;
    expect(result).toMatchObject({ status: "asked" });
    expect(await chatAskJobs(h.chatThread.id)).toHaveLength(1);
  });

  it("asks the same question in a thread only once while it runs", async () => {
    const h = await harness();
    await ask(h, { repository: "acme/api", question: "Where is the retry logic?" });
    h.thread.post.mockClear();

    const again = await ask(h, {
      repository: "acme/api",
      question: "  where is the RETRY logic? ",
    });

    expect(again).toMatchObject({ status: "already_asked" });
    expect(await chatAskJobs(h.chatThread.id)).toHaveLength(1);
    expect(h.thread.post).not.toHaveBeenCalled();
    // A different question, or the same one in another thread, is asked.
    await ask(h, { repository: "acme/api", question: "Where is the backoff configured?" });
    expect(await chatAskJobs(h.chatThread.id)).toHaveLength(2);
    const other = await harness();
    await ask(other, { repository: "acme/api", question: "Where is the retry logic?" });
    expect(await chatAskJobs(other.chatThread.id)).toHaveLength(1);
  });

  it("quotes the thread's previous question and answer in a follow-up's context", async () => {
    const h = await harness();
    await ask(h, { repository: "acme/api", question: "Where are sessions stored?" });
    const [first] = await chatAskJobs(h.chatThread.id);
    const result: ChatAskJobResult = {
      answer: "In Redis, see `src/session.ts`.",
      outcome: "answered",
      usage: { inputTokens: 10, outputTokens: 5 },
      durationMs: 1,
    };
    await db
      .update(jobs)
      .set({ status: "completed", result, finishedAt: new Date() })
      .where(eq(jobs.id, first!.id));

    await ask(h, { repository: "acme/api", question: "How long do they live?" });

    const followUp = (await chatAskJobs(h.chatThread.id)).find((j) => j.id !== first!.id)!;
    const context = ChatAskJobPayload.parse(followUp.payload).context!;
    expect(context).toContain(
      "Previous code question in this thread (about acme/api):\nWhere are sessions stored?",
    );
    expect(context).toContain("Its answer:\nIn Redis, see `src/session.ts`.");
  });

  it("refuses a repository the organization hasn't connected", async () => {
    const h = await harness();
    for (const repository of ["acme/web", "other/api"]) {
      const result = await ask(h, { repository, question: "What is this?" });
      expect(result).toMatchObject({ error: "unknown_repository" });
    }
    expect(await chatAskJobs(h.chatThread.id)).toEqual([]);
    expect(h.thread.post).not.toHaveBeenCalled();
  });

  it("enqueues nothing when no online agent can answer code questions", async () => {
    const h = await harness();

    await setAgent(agentId, { reportedVersion: "0.7.0" });
    const old = await ask(h, { repository: "acme/api", question: "What is this?" });
    expect(old).toMatchObject({
      error: "no_capable_agent",
      agents: [{ name: "acme-agent", version: "0.7.0", capable: false }],
    });
    expect(old.message).toContain("0.8.0");

    await setAgent(agentId, { reportedVersion: "0.8.0", lastHeartbeatAt: null });
    const offline = await ask(h, { repository: "acme/api", question: "What is this?" });
    expect(offline).toMatchObject({ error: "no_capable_agent", agents: [] });
    expect(offline.message).toContain("online");

    expect(await chatAskJobs(h.chatThread.id)).toEqual([]);
    expect(publisher.sent).toEqual([]);
    expect(h.thread.post).not.toHaveBeenCalled();
  });

  it("only counts the agents a pinned repository's jobs go to", async () => {
    const h = await harness();
    const [pinned] = await db
      .insert(agents)
      .values({
        organizationId: orgId,
        name: "pinned-agent",
        reportedVersion: "0.5.0",
        reportedCapabilities: ["review"],
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

  it("gives an unlinked user no way to ask", async () => {
    const h = await harness(orgId, unlinked);
    expect(toAiTools(chatTools, h.context, vi.fn())).toEqual({});
    expect(await chatAskJobs(h.chatThread.id)).toEqual([]);
  });
});
