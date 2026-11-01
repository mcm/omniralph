import { randomBytes } from "node:crypto";
import { createMockAdapter, createMockState } from "@chat-adapter/tests";
import {
  closeDb,
  connectRepository,
  createDb,
  createRun,
  ensureChatThread,
  getRun,
  insertJob,
  listMessages,
  listStories,
  organizations,
  repositories,
  saveChatConnection,
  updateStory,
  upsertScmConnection,
  upsertStories,
  type ChatThread,
  type Database,
  type RalphRun,
  type RalphRunStatus,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import type { Thread } from "chat";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresDispatcher } from "@/lib/dispatch/dispatcher";
import { fakeRalphTracker } from "@/lib/testing/fake-tracker";
import type { ChatChannel } from "@/lib/ralph/conversation";
import type { RalphDeps } from "@/lib/ralph/run";
import { FakeScmAdapter } from "@/lib/scm/fake-adapter";
import type { ChatActor } from "../identity";
import type { ChatToolContext } from "./tools";

vi.mock("server-only", () => ({}));

const { chatTools } = await import("./registry");

const databaseAvailable = testDatabaseAvailable();

const APP_URL = "https://omniralph.example.com";
const member: ChatActor = { kind: "member", userId: "ada", role: "member", name: "Ada" };
const domain: ChatActor = { kind: "domain", email: "ada@acme.test" };

type Result = Record<string, unknown>;

describe.skipIf(!databaseAvailable)("send_ralph_guidance and get_ralph_run", () => {
  const key = randomBytes(32);
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let otherOrgId: string;
  let repositoryId: string;
  let otherRepositoryId: string;
  let chatThread: ChatThread;
  let linear: ReturnType<typeof fakeRalphTracker>;
  let seq = 0;

  const ralph = (organizationId: string): RalphDeps => ({
    db,
    organizationId,
    tracker: linear,
    dispatcher: new PostgresDispatcher({ db }),
    adapterFor: () => new FakeScmAdapter().asAdapter(),
    chat: {
      db,
      adapters: { discord: createMockAdapter("discord") },
      state: createMockState(),
      appUrl: APP_URL,
      encryptionKey: key,
    } satisfies ChatChannel,
  });

  const context = (organizationId: string, actor: ChatActor = member): ChatToolContext => ({
    db,
    organizationId,
    connection: { id: chatThread.connectionId, organizationId },
    actor,
    requesterExternalUserId: "U-ADA",
    thread: {} as Thread,
    appUrl: APP_URL,
    chatThread,
    turnMessages: [{ author: "Ada Lovelace", text: "tell ENG-1 to skip the docs" }],
    ralph: async () => ralph(organizationId),
    handedOff: () => undefined,
  });

  async function call(
    name: string,
    input: unknown,
    organizationId = orgId,
    actor: ChatActor = member,
  ): Promise<Result> {
    const tool = chatTools[name]!;
    return (await tool.execute(
      tool.inputSchema.parse(input),
      context(organizationId, actor),
    )) as Result;
  }

  /** A running Linear epic run of `organizationId` with a running story and a queued story job. */
  async function linearRun(
    organizationId: string,
    repository: string,
    status: RalphRunStatus = "running",
  ): Promise<RalphRun> {
    seq += 1;
    // The epic and its session (unique across tests), on the fake tracker.
    const epic = linear.add({ id: `issue-${seq}`, identifier: `ENG-${seq}`, title: `Epic ${seq}` });
    const sessionId = `session-${seq}`;
    linear.sessionsCreated.push({ issueId: epic.id, sessionId });
    const { run } = await createRun(db, {
      organizationId,
      linearIssueId: epic.id,
      linearIdentifier: epic.identifier,
      linearTitle: epic.title,
      linearAgentSessionId: sessionId,
      kind: "children",
      repositoryId: repository,
      branch: `omniralph/eng-${seq}`,
      baseBranch: "main",
      status,
    });
    await upsertStories(db, run.id, [
      { linearIssueId: `story-${seq}-1`, identifier: `ENG-${seq}1`, title: "Story one" },
      { linearIssueId: `story-${seq}-2`, identifier: `ENG-${seq}2`, title: "Story two" },
    ]);
    const { job } = await insertJob(db, {
      organizationId,
      type: "ralph.story",
      taskType: "coding",
      repositoryId: repository,
      ralphRunId: run.id,
    });
    const [first] = await listStories(db, run.id);
    await updateStory(db, first!.id, { status: "running", attempts: 2, lastJobId: job.id });
    return run;
  }

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
    const repository = await connectRepository(db, {
      connectionId: connection.id,
      provider: "github",
      externalId: `repo-${slug}`,
      fullPath: `${slug}/app`,
    });
    await db
      .update(repositories)
      .set({ codingEnabled: true })
      .where(eq(repositories.id, repository.id));
    return { id: org!.id, repositoryId: repository.id };
  }

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    ({ id: orgId, repositoryId } = await seedOrg("Acme", "acme"));
    ({ id: otherOrgId, repositoryId: otherRepositoryId } = await seedOrg("Other", "other"));
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
    chatThread = (await ensureChatThread(db, {
      connectionId: saved.id,
      externalThreadId: "discord:G1:CH1:TH1",
      channelId: "discord:G1:CH1",
      startedByExternalUserId: "D1",
    }))!;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(() => {
    linear = fakeRalphTracker();
  });

  it("is an action tool", () => {
    expect(chatTools.send_ralph_guidance?.tier).toBe("action");
  });

  it("steers a Linear run by its identifier and mirrors the guidance to its session", async () => {
    const run = await linearRun(orgId, repositoryId);

    const result = await call("send_ralph_guidance", {
      run: run.linearIdentifier!.toLowerCase(),
      text: "Skip the docs story for now.",
    });

    expect(result).toMatchObject({
      status: "applied",
      run: { id: run.id, url: `${APP_URL}/runs/${run.id}` },
    });
    expect(result.message).toContain("once the job it is running finishes");
    // Applied like a Linear reply: guidance for the next attempt, and a pending request.
    expect((await getRun(db, run.id))!.guidance.map((g) => g.text)).toEqual([
      "Skip the docs story for now.",
    ]);
    expect((await listMessages(db, run.id)).at(-1)).toMatchObject({
      kind: "request",
      jobId: null,
      text: "Skip the docs story for now.",
      author: "Ada (from chat)",
    });
    expect(linear.activities).toEqual([
      {
        sessionId: run.linearAgentSessionId,
        content: {
          type: "thought",
          body: "Guidance from Ada (from chat):\n\n> Skip the docs story for now.",
        },
      },
    ]);

    const detail = await call("get_ralph_run", { run: run.id });
    expect(detail).toMatchObject({
      currentStory: { identifier: `ENG-${seq}1`, title: "Story one", attempts: 0 },
      pendingGuidance: 1,
    });
    expect(Date.parse(detail.lastActivityAt as string)).toBeGreaterThanOrEqual(
      run.createdAt.getTime(),
    );
  });

  it("steers a chat run by its id without posting to Linear", async () => {
    const { run } = await createRun(db, {
      organizationId: orgId,
      origin: "chat",
      chatThreadId: chatThread.id,
      repositoryId,
      branch: "omniralph/chat-1",
      baseBranch: "main",
      status: "running",
    });
    await insertJob(db, {
      organizationId: orgId,
      type: "ralph.request",
      taskType: "coding",
      repositoryId,
      ralphRunId: run.id,
    });

    const result = await call("send_ralph_guidance", {
      run: run.id,
      text: "Use British spelling.",
    });

    expect(result).toMatchObject({ status: "applied", run: { id: run.id } });
    expect((await listMessages(db, run.id)).at(-1)).toMatchObject({
      kind: "request",
      text: "Use British spelling.",
      author: "Ada (from chat)",
    });
    expect(linear.activities).toEqual([]);
    const detail = await call("get_ralph_run", { run: run.id });
    expect(detail).toMatchObject({ currentStory: null, pendingGuidance: 1 });
  });

  it("refuses another organization's run", async () => {
    const run = await linearRun(otherOrgId, otherRepositoryId);

    for (const ref of [run.id, run.linearIdentifier!]) {
      expect(await call("send_ralph_guidance", { run: ref, text: "Stop." })).toMatchObject({
        error: "not_found",
      });
    }
    expect(await listMessages(db, run.id)).toEqual([]);
    expect((await getRun(db, run.id))!.guidance).toEqual([]);
    expect(linear.activities).toEqual([]);
  });

  it("refuses a finished run", async () => {
    const run = await linearRun(orgId, repositoryId, "completed");

    expect(await call("send_ralph_guidance", { run: run.id, text: "More." })).toMatchObject({
      error: "run_finished",
      run: { id: run.id, status: "completed" },
    });
    expect(await listMessages(db, run.id)).toEqual([]);
    expect(linear.activities).toEqual([]);
  });

  it("is refused to a user who isn't a linked member", async () => {
    const run = await linearRun(orgId, repositoryId);
    const tools = (await import("./tools")).toAiTools(
      chatTools,
      context(orgId, domain),
      () => undefined,
    );
    const result = await tools.send_ralph_guidance!.execute!(
      { run: run.id, text: "Stop." },
      { toolCallId: "c", messages: [] },
    );

    expect(result).toMatchObject({ error: "link_required" });
    expect(await listMessages(db, run.id)).toEqual([]);
  });
});
