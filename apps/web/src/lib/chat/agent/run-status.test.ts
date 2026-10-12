import { randomBytes, randomUUID } from "node:crypto";
import {
  closeDb,
  connectRepository,
  createDb,
  createRun,
  createRunPermissionRequest,
  ensureChatThread,
  insertMessage,
  insertRunActivity,
  jobs,
  mapThreadRun,
  organizations,
  ralphRuns,
  runActivities,
  runMigrations,
  saveChatConnection,
  seedReviewProfiles,
  upsertScmConnection,
  type ChatThread,
  type Database,
} from "@omniralph/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Thread } from "chat";
import { eq } from "drizzle-orm";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatActor } from "../identity";
import type { ChatToolContext } from "./tools";

vi.mock("server-only", () => ({}));

const { RUN_STATUS_ACTIVITY_LIMIT, readTools } = await import("./read-tools");

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

const APP_URL = "https://omniralph.example.com";
const domain: ChatActor = { kind: "domain", email: "ada@acme.test" };

type Result = Record<string, unknown>;

describe.skipIf(!dockerAvailable)("get_run_status", () => {
  const key = randomBytes(32);
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let orgId: string;
  let otherOrgId: string;
  let connectionId: string;
  let repositoryId: string;
  let quietThread: ChatThread;
  let threadNumber = 0;
  let ralphCalls = 0;

  const context = (chatThread: ChatThread, organizationId = orgId): ChatToolContext => ({
    db,
    organizationId,
    connection: { id: connectionId, organizationId },
    actor: domain,
    requesterExternalUserId: "U-ADA",
    thread: {} as Thread,
    appUrl: APP_URL,
    chatThread,
    turnMessages: [],
    // Status comes from the database: nothing reaches the orchestrator or a harness.
    ralph: () => {
      ralphCalls += 1;
      return Promise.reject(new Error("get_run_status must not use ralph"));
    },
    handedOff: () => undefined,
  });

  async function status(input: unknown, chatThread = quietThread, organizationId = orgId) {
    const tool = readTools.get_run_status!;
    return (await tool.execute(
      tool.inputSchema.parse(input),
      context(chatThread, organizationId),
    )) as Result;
  }

  async function newThread(): Promise<ChatThread> {
    threadNumber += 1;
    return (await ensureChatThread(db, {
      connectionId,
      externalThreadId: `discord:G1:CH1:TH${threadNumber}`,
      channelId: "discord:G1:CH1",
      startedByExternalUserId: "D1",
    }))!;
  }

  async function activity(jobId: string, body: string, seconds: number, parameter?: string) {
    const row = await insertRunActivity(db, {
      jobId,
      organizationId: orgId,
      type: parameter === undefined ? "thought" : "action",
      body,
      parameter,
    });
    await db
      .update(runActivities)
      .set({ createdAt: new Date(Date.UTC(2026, 9, 12, 9, 0, seconds)) })
      .where(eq(runActivities.id, row.id));
  }

  /** A coding run started in `chatThread`, with a running request job. */
  async function codingRun(chatThread: ChatThread) {
    const { run } = await createRun(db, {
      organizationId: orgId,
      origin: "chat",
      chatThreadId: chatThread.id,
      codingTaskId: "builtin:handle-request",
      repositoryId,
      branch: `omniralph/chat-${chatThread.id.slice(0, 8)}`,
      baseBranch: "main",
      status: "running",
    });
    const [job] = await db
      .insert(jobs)
      .values({
        organizationId: orgId,
        type: "ralph.request",
        taskType: "coding",
        pool: "long",
        taskId: "builtin:handle-request",
        ralphRunId: run.id,
        status: "running",
        startedAt: new Date(),
      })
      .returning();
    return { run, job: job! };
  }

  /** A query run (a code question) asked in `chatThread`. */
  async function queryRun(chatThread: ChatThread, organizationId = orgId) {
    const [job] = await db
      .insert(jobs)
      .values({
        organizationId,
        type: "chat.ask",
        taskType: "query",
        pool: "short",
        taskId: "builtin:ask-about-code",
        status: "running",
        startedAt: new Date(),
        payload: {
          trigger: {
            kind: "chat.request",
            context: { repository: "acme/api", question: "Where is auth handled?" },
          },
        },
      })
      .returning();
    if (organizationId === orgId) {
      await mapThreadRun(db, { organizationId, chatThreadId: chatThread.id, jobId: job!.id });
    }
    return job!;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
    await seedReviewProfiles(db, orgId);
    const [other] = await db.insert(organizations).values({ name: "Other" }).returning();
    otherOrgId = other!.id;
    const scm = (await upsertScmConnection(
      db,
      {
        organizationId: orgId,
        provider: "github",
        name: "acme",
        baseUrl: "https://api.github.com",
        externalId: "conn-acme",
        credentials: {},
      },
      key,
    ))!;
    repositoryId = (
      await connectRepository(db, {
        connectionId: scm.id,
        provider: "github",
        externalId: "repo-acme",
        fullPath: "acme/api",
      })
    ).id;
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
    quietThread = await newThread();
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await container?.stop();
  });

  it("reports a coding run from its state, open approvals, requests and latest activity", async () => {
    const chatThread = await newThread();
    const { run, job } = await codingRun(chatThread);
    // An earlier job's activity counts too; the oldest falls off the limit.
    const [earlier] = await db
      .insert(jobs)
      .values({
        organizationId: orgId,
        type: "ralph.request",
        taskType: "coding",
        pool: "long",
        ralphRunId: run.id,
        status: "completed",
        createdAt: new Date(Date.UTC(2026, 9, 12, 8)),
      })
      .returning();
    await activity(earlier!.id, "Started on the README.", 0);
    for (let n = 1; n <= RUN_STATUS_ACTIVITY_LIMIT; n += 1) {
      await activity(job.id, `Step ${n}`, n);
    }
    await activity(job.id, "Bash", 30, "pnpm test");
    await createRunPermissionRequest(db, {
      jobId: job.id,
      requestId: randomUUID(),
      tool: "Bash",
      detail: "git push --force",
      expiresAt: new Date(Date.now() + 600_000),
    });
    await insertMessage(db, {
      runId: run.id,
      kind: "request",
      text: "Also fix CONTRIBUTING.md",
      author: "Ada",
    });

    const jobsBefore = (await db.select({ id: jobs.id }).from(jobs)).length;
    const byThread = await status({}, chatThread);
    const byId = await status({ run: run.id });
    const byJob = await status({ run: job.id });
    for (const shown of [byThread, byId, byJob]) {
      expect(shown).toMatchObject({
        runType: "coding",
        id: run.id,
        url: `${APP_URL}/ralph/${run.id}`,
        task: "builtin:handle-request",
        status: "running",
        repository: "acme/api",
        currentJob: { id: job.id, type: "ralph.request", status: "running" },
        waitingOnApproval: [{ tool: "Bash", detail: "git push --force" }],
        pendingRequests: [{ kind: "request", text: "Also fix CONTRIBUTING.md", author: "Ada" }],
      });
    }
    const recent = byThread.recentActivity as { type: string; text: string; parameter?: string }[];
    expect(recent).toHaveLength(RUN_STATUS_ACTIVITY_LIMIT);
    // Newest first.
    expect(recent.map((a) => a.text)).toEqual([
      "Bash",
      ...Array.from(
        { length: RUN_STATUS_ACTIVITY_LIMIT - 1 },
        (_, i) => `Step ${RUN_STATUS_ACTIVITY_LIMIT - i}`,
      ),
    ]);
    expect(recent[0]).toMatchObject({ type: "action", parameter: "pnpm test" });
    expect(byThread).toMatchObject({
      queuedAt: run.createdAt.toISOString(),
      startedAt: job.startedAt!.toISOString(),
      finishedAt: null,
    });
    expect(ralphCalls).toBe(0);
    // Only read: no job was enqueued.
    expect((await db.select({ id: jobs.id }).from(jobs)).length).toBe(jobsBefore);

    const [done] = await db
      .update(ralphRuns)
      .set({ status: "completed" })
      .where(eq(ralphRuns.id, run.id))
      .returning();
    expect(await status({ run: run.id })).toMatchObject({
      status: "completed",
      finishedAt: done!.updatedAt.toISOString(),
    });
  });

  it("reports the thread's latest run: a query run asked after the coding run", async () => {
    const chatThread = await newThread();
    await codingRun(chatThread);
    const job = await queryRun(chatThread);
    await activity(job.id, "Reading src/auth.ts", 1);
    await activity(job.id, "Grep", 2, "authenticate");

    const result = await status({}, chatThread);

    expect(result).toEqual({
      runType: "query",
      id: job.id,
      url: `${APP_URL}/jobs#job-${job.id}`,
      task: "builtin:ask-about-code",
      status: "running",
      cancelRequested: false,
      repository: "acme/api",
      question: "Where is auth handled?",
      harness: null,
      outcome: null,
      error: null,
      waitingOnApproval: [],
      recentActivity: [
        {
          type: "action",
          text: "Grep",
          parameter: "authenticate",
          at: "2026-10-12T09:00:02.000Z",
        },
        { type: "thought", text: "Reading src/auth.ts", at: "2026-10-12T09:00:01.000Z" },
      ],
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt!.toISOString(),
      finishedAt: null,
    });
    expect(ralphCalls).toBe(0);
  });

  it("says when the thread has no run, and never shows another organization's", async () => {
    expect(await status({}, quietThread)).toMatchObject({ error: "no_run" });

    const foreign = await queryRun(quietThread, otherOrgId);
    expect(await status({ run: foreign.id }, quietThread)).toMatchObject({
      error: "not_found",
    });
    expect(await status({ run: "ENG-404" }, quietThread)).toMatchObject({ error: "not_found" });

    // Another organization asking about this one's runs finds nothing either.
    const chatThread = await newThread();
    const { run } = await codingRun(chatThread);
    const job = await queryRun(chatThread);
    for (const ref of [run.id, job.id]) {
      expect(await status({ run: ref }, chatThread, otherOrgId)).toMatchObject({
        error: "not_found",
      });
    }
    expect(await status({}, chatThread, otherOrgId)).toMatchObject({ error: "no_run" });
  });
});
