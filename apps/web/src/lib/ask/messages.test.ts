import { randomBytes } from "node:crypto";
import {
  appendWebMessage,
  closeDb,
  connectRepository,
  createDb,
  createWebChatThread,
  getJob,
  insertJob,
  insertRunActivity,
  jobs,
  mapThreadRun,
  markRunEventsProcessed,
  organizations,
  recordRunEvent,
  upsertScmConnection,
  users,
  type ChatThread,
  type ChatThreadRun,
  type Database,
  type Job,
} from "@omniralph/db";
import type { QueryRunResult, RunSpecJobPayload } from "@omniralph/shared";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AskWorkItem, WorkItemResolver } from "./work-items";

vi.mock("server-only", () => ({}));

const { askActivity, askMessages, jobDurationMs } = await import("./messages");

const databaseAvailable = testDatabaseAvailable();

describe("jobDurationMs", () => {
  const result: QueryRunResult = {
    outcome: "answered",
    answer: "x",
    structured: null,
    references: [],
    usage: { inputTokens: 1, outputTokens: 1 },
    durationMs: 41_000,
  };
  const startedAt = new Date("2026-10-27T12:00:00Z");
  const finishedAt = new Date("2026-10-27T12:03:12Z");

  it("is the result's durationMs, else the job's run time, else null", () => {
    expect(jobDurationMs({ result, startedAt, finishedAt })).toBe(41_000);
    expect(jobDurationMs({ result: null, startedAt, finishedAt })).toBe(192_000);
    expect(jobDurationMs({ result: { nope: true }, startedAt, finishedAt })).toBe(192_000);
    expect(jobDurationMs({ result: null, startedAt, finishedAt: null })).toBeNull();
  });
});

describe.skipIf(!databaseAvailable)("the Ask message view model", () => {
  const key = randomBytes(32);
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let githubRepo: string;
  let gitlabRepo: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
    await db.insert(users).values({ id: "ada", email: "ada@acme.test", name: "Ada" });
    const github = (await upsertScmConnection(
      db,
      {
        organizationId: orgId,
        provider: "github",
        name: "acme",
        baseUrl: "https://api.github.com",
        externalId: "gh",
        credentials: {},
      },
      key,
    ))!;
    githubRepo = (
      await connectRepository(db, {
        connectionId: github.id,
        provider: "github",
        externalId: "1",
        fullPath: "acme/portal",
      })
    ).id;
    const gitlab = (await upsertScmConnection(
      db,
      {
        organizationId: orgId,
        provider: "gitlab",
        name: "gitlab",
        baseUrl: "https://gitlab.example.com",
        externalId: "gl",
        credentials: {},
      },
      key,
    ))!;
    gitlabRepo = (
      await connectRepository(db, {
        connectionId: gitlab.id,
        provider: "gitlab",
        externalId: "2",
        fullPath: "acme/infra/api",
      })
    ).id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  const chat = (repositoryId: string | null, branch: string | null) =>
    createWebChatThread(db, {
      organizationId: orgId,
      userId: "ada",
      repositoryId,
      branch,
      title: "Why does last() fail?",
    });

  const answered = (references: QueryRunResult["references"]): QueryRunResult => ({
    outcome: "answered",
    answer: "`last()` reads one past the end.",
    structured: null,
    references,
    usage: { inputTokens: 10, outputTokens: 5 },
    durationMs: 41_000,
  });

  /** A code question of the chat on `repositoryId` at `branch`, as `enqueueChatAsk` maps it. */
  async function ask(
    thread: ChatThread,
    repositoryId: string,
    branch: string,
    provider: "github" | "gitlab" = "github",
  ): Promise<{ job: Job; run: ChatThreadRun }> {
    const payload: RunSpecJobPayload = {
      trigger: {
        kind: "chat.request",
        context: {
          repository: provider === "github" ? "acme/portal" : "acme/infra/api",
          branch,
          provider,
          question: "Why?",
          chatThreadId: thread.id,
          chat: { context: null },
          budgetTokens: null,
        },
      },
      repositoryId,
      ref: branch,
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
    const run = (await mapThreadRun(db, {
      organizationId: orgId,
      chatThreadId: thread.id,
      jobId: job.id,
    }))!;
    return { job, run };
  }

  const setJob = async (id: string, values: Partial<typeof jobs.$inferInsert>) => {
    await db.update(jobs).set(values).where(eq(jobs.id, id));
    return (await getJob(db, id))!;
  };

  const read = (job: Job, ...paths: string[]) =>
    Promise.all(
      paths.map((parameter) =>
        insertRunActivity(db, {
          jobId: job.id,
          organizationId: orgId,
          type: "action",
          body: "Read",
          parameter,
        }),
      ),
    );

  /** A resolver knowing ENG-12, counting its calls. */
  function fakeWorkItems() {
    const eng12: AskWorkItem = {
      tracker: "linear",
      identifier: "ENG-12",
      url: "https://linear.app/acme/issue/ENG-12",
      runId: null,
    };
    const resolve = vi.fn(async (_organizationId: string, identifiers: readonly string[]) =>
      identifiers.includes("ENG-12") ? [eng12] : [],
    );
    return { resolver: { resolve } satisfies WorkItemResolver, resolve, eng12 };
  }

  it("gives an answer its run, files read, duration and cited files on GitHub", async () => {
    const thread = await chat(githubRepo, "release/2.0");
    const { job, run } = await ask(thread, githubRepo, "release/2.0");
    // One file read three times, another once; other actions don't count.
    await read(job, "src/list.ts", "src/list.ts", "src/util.ts", "src/list.ts");
    await insertRunActivity(db, {
      jobId: job.id,
      organizationId: orgId,
      type: "action",
      body: "Grep",
      parameter: "last",
    });
    await insertRunActivity(db, {
      jobId: job.id,
      organizationId: orgId,
      type: "thought",
      body: "Reading the list.",
    });
    await setJob(job.id, {
      status: "completed",
      startedAt: new Date("2026-10-27T12:00:00Z"),
      finishedAt: new Date("2026-10-27T12:05:00Z"),
      result: answered([
        { path: "src/list.ts", startLine: 2 },
        { path: "src/util.ts", startLine: 4, endLine: 9 },
        { path: "README.md" },
      ]),
    });
    const question = (await appendWebMessage(db, {
      threadId: thread.id,
      author: "user",
      userId: "ada",
      markdown: "Why does last() fail? Is it ENG-12?",
    }))!;
    const answer = (await appendWebMessage(db, {
      threadId: thread.id,
      author: "om",
      markdown: "`last()` reads one past the end (ENG-12, NOPE-3).",
      threadRunId: run.id,
    }))!;
    const { resolver, resolve, eng12 } = fakeWorkItems();

    const [user, om] = await askMessages({ db, workItems: resolver }, thread, [question, answer]);

    expect(user).toEqual({
      id: question.id,
      author: "user",
      markdown: "Why does last() fail? Is it ENG-12?",
      status: "complete",
      createdAt: question.createdAt.toISOString(),
      run: null,
      files: [],
      workItems: [],
    });
    const blob = "https://github.com/acme/portal/blob/release/2.0";
    expect(om).toEqual({
      id: answer.id,
      author: "om",
      markdown: "`last()` reads one past the end (ENG-12, NOPE-3).",
      status: "complete",
      createdAt: answer.createdAt.toISOString(),
      // The agent's own duration wins over the job's timestamps.
      run: { id: run.id, status: "completed", durationMs: 41_000, filesRead: 2 },
      files: [
        { path: "src/list.ts", startLine: 2, endLine: null, url: `${blob}/src/list.ts#L2` },
        { path: "src/util.ts", startLine: 4, endLine: 9, url: `${blob}/src/util.ts#L4-L9` },
        { path: "README.md", startLine: null, endLine: null, url: `${blob}/README.md` },
      ],
      workItems: [eng12],
    });
    // One lookup for the answer, with every identifier it mentions; none for the question.
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(orgId, ["ENG-12", "NOPE-3"]);
  });

  it("links cited files on GitLab, and times a run without a result by its job", async () => {
    const thread = await chat(null, null);
    const { job, run } = await ask(thread, gitlabRepo, "main", "gitlab");
    await setJob(job.id, {
      status: "completed",
      startedAt: new Date("2026-10-27T12:00:00Z"),
      finishedAt: new Date("2026-10-27T12:03:12Z"),
      result: answered([{ path: "lib/a b.rb", startLine: 4, endLine: 9 }]),
    });
    const answer = (await appendWebMessage(db, {
      threadId: thread.id,
      author: "om",
      markdown: "See `lib/a b.rb`.",
      threadRunId: run.id,
    }))!;
    const { resolver } = fakeWorkItems();

    const [om] = await askMessages({ db, workItems: resolver }, thread, [answer]);
    expect(om!.files).toEqual([
      {
        path: "lib/a b.rb",
        startLine: 4,
        endLine: 9,
        url: "https://gitlab.example.com/acme/infra/api/-/blob/main/lib/a%20b.rb#L4-9",
      },
    ]);

    // A failed attempt has no result: its duration is the job's.
    await setJob(job.id, { status: "failed", result: null });
    const [failed] = await askMessages({ db, workItems: resolver }, thread, [answer]);
    expect(failed!.run).toEqual({
      id: run.id,
      status: "failed",
      durationMs: 192_000,
      filesRead: 0,
    });
    expect(failed!.files).toEqual([]);
  });

  it("looks up no work items for a message still streaming, nor one with none", async () => {
    const thread = await chat(githubRepo, "main");
    const streaming = (await appendWebMessage(db, {
      threadId: thread.id,
      author: "om",
      markdown: "ENG-12 is",
      status: "streaming",
    }))!;
    const plain = (await appendWebMessage(db, {
      threadId: thread.id,
      author: "om",
      markdown: "No identifiers.",
    }))!;
    const { resolver, resolve } = fakeWorkItems();
    const messages = await askMessages({ db, workItems: resolver }, thread, [streaming, plain]);
    expect(messages.map((m) => [m.run, m.workItems])).toEqual([
      [null, []],
      [null, []],
    ]);
    expect(resolve).not.toHaveBeenCalled();
  });

  describe("askActivity", () => {
    it("reports an in-flight ask queued, then running with its live files count, until it's relayed", async () => {
      const thread = await chat(githubRepo, "main");
      expect(await askActivity(db, thread)).toBeNull();
      const { job, run } = await ask(thread, githubRepo, "main");
      const repository = { id: githubRepo, provider: "github", fullPath: "acme/portal" };

      expect(await askActivity(db, thread)).toEqual({
        state: "queued",
        repository,
        filesRead: 0,
        runIds: [run.id],
      });

      await setJob(job.id, { status: "running", startedAt: new Date() });
      await read(job, "src/a.ts", "src/b.ts", "src/a.ts");
      expect(await askActivity(db, thread)).toEqual({
        state: "running",
        repository,
        filesRead: 2,
        runIds: [run.id],
      });

      // Finished, its answer waiting to be relayed: still in flight.
      await setJob(job.id, {
        status: "completed",
        finishedAt: new Date(),
        result: answered([]),
      });
      const { event } = await recordRunEvent(db, {
        organizationId: orgId,
        threadRun: run,
        kind: "response",
        body: { text: "x", outcome: "answered", answer: "x" },
        idempotencyKey: `test:${job.id}`,
      });
      expect(await askActivity(db, thread)).toMatchObject({ state: "running", runIds: [run.id] });

      await markRunEventsProcessed(db, orgId, [event!.id], new Date());
      expect(await askActivity(db, thread)).toBeNull();
    });
  });
});
