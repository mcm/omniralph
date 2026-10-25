import { randomBytes, randomUUID } from "node:crypto";
import {
  harnesses,
  chatConnections,
  chatThreadRuns,
  connectRepository,
  closeDb,
  createReview,
  createReviewRun,
  createTriageRun,
  mapThreadRun,
  reviewRuns,
  reviews,
  triageRuns,
  createDb,
  createRun,
  ensureChatThread,
  ensureLane,
  findings,
  insertRunActivity,
  getJob,
  getMainLane,
  getRun,
  insertJob,
  insertMessage,
  integrations,
  jobs,
  listStories,
  ralphRuns,
  saveChatConnection,
  saveIntegration,
  updateLane,
  updateRepositoryRalphSettings,
  updateRun,
  updateStory,
  upsertScmConnection,
  upsertStories,
  DEFAULT_RALPH_SETTINGS,
  type Database,
  organizations,
  seedReviewProfiles,
  type LinearRun,
  type NewLinearRalphRunInput,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRole, type Role } from "@/lib/auth/roles";
import { PostgresDispatcher } from "@/lib/dispatch/dispatcher";
import { FakeLinearGateway, linearRun } from "@/lib/linear/fake-gateway";
import type { LinearGateway } from "@/lib/linear/gateway";
import { runListSchema, type RunList, type RunRow } from "@/lib/api/runs";
import { runDetailSchema, transcriptPageSchema, type RunDetail } from "@/lib/api/runs";

vi.mock("server-only", () => ({}));

type TestUser = { id: string; role: Role; name: string | null; email: string | null; image: null };
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  user: null as TestUser | null,
  /** The user's active organization. */
  orgId: "",
  linear: undefined as unknown as LinearGateway,
  dispatcher: undefined as unknown,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
const withOrganization = (user: TestUser | null) =>
  user && { ...user, organization: { id: state.orgId, name: "Acme" } };
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") => assertRole(withOrganization(state.user), role),
}));
vi.mock("@/lib/dispatch", () => ({ getDispatcher: () => state.dispatcher }));
vi.mock("@/lib/linear/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getLinearGatewayOrDisconnected: async () => state.linear,
}));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const runList = await import("@/app/api/ui/runs/route");
const runDetail = await import("@/app/api/ui/runs/[id]/route");
const runStop = await import("@/app/api/ui/runs/[id]/stop/route");
const transcriptRoute =
  await import("@/app/api/ui/runs/[id]/attempts/[attemptId]/transcript/route");
const { disconnectedLinearGateway } = await import("@/lib/linear/client");

const databaseAvailable = testDatabaseAvailable();

const admin: TestUser = {
  id: "admin-1",
  role: "admin",
  name: "Ada Admin",
  email: null,
  image: null,
};
const member: TestUser = { id: "member-1", role: "member", name: null, email: null, image: null };

/** Calls an `/api/ui` handler; a non-2xx answer throws with its status and error. */
async function call<T>(
  handler: (request: Request, route: { params: Promise<{ id: string }> }) => Promise<Response>,
  {
    id = "",
    search = {},
    method = "GET",
  }: { id?: string; search?: Record<string, string>; method?: string },
): Promise<{ status: number; body: T & { error?: string } }> {
  const response = await handler(
    new Request(`http://localhost/api/ui?${new URLSearchParams(search)}`, { method }),
    { params: Promise.resolve({ id }) },
  );
  return { status: response.status, body: (await response.json()) as T & { error?: string } };
}

/** `GET /api/ui/runs`; `search` values that are lists repeat their parameter. */
async function listRequest(search: Record<string, string | string[]> = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    for (const v of [value].flat()) params.append(key, v);
  }
  const response = await runList.GET(new Request(`http://localhost/api/ui/runs?${params}`), {
    params: Promise.resolve({}),
  });
  return { status: response.status, body: (await response.json()) as RunList & { error?: string } };
}

async function listPage(search: Record<string, string | string[]> = {}): Promise<RunList> {
  const { status, body } = await listRequest(search);
  if (status !== 200) throw new Error(`HTTP ${status}: ${body.error}`);
  return runListSchema.parse(body);
}

const ids = (list: RunList) => list.runs.map((r) => r.id);

async function detailPage(id: string): Promise<RunDetail> {
  const { status, body } = await call<RunDetail>(runDetail.GET, { id });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  return runDetailSchema.parse(body);
}

type Result = { ok: true } | { ok: false; error: string };

async function stopRalphRun(id: string): Promise<Result> {
  const { status, body } = await call<Result>(runStop.POST, { id, method: "POST" });
  return status === 200 ? body : { ok: false, error: body.error! };
}

describe.skipIf(!databaseAvailable)("/api/ui/runs", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let repoA: string;
  let repoB: string;
  let harnessId: string;
  let linear: FakeLinearGateway;
  let session = 0;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    await seedReviewProfiles(db, org!.id);
    orgId = org!.id;
    state.db = db;
    const github = (await upsertScmConnection(db, {
      organizationId: orgId,
      provider: "github",
      name: "acme",
      baseUrl: "https://api.github.com",
      externalId: "1",
      credentials: {},
    }))!;
    const gitlab = (await upsertScmConnection(db, {
      organizationId: orgId,
      provider: "gitlab",
      name: "bot",
      baseUrl: "https://gitlab.example.com",
      externalId: "5",
      credentials: { token: "glpat-bot", webhookSecret: "hook" },
    }))!;
    repoA = (
      await connectRepository(db, {
        connectionId: github.id,
        provider: "github",
        externalId: "1",
        fullPath: "acme/api",
      })
    ).id;
    repoB = (
      await connectRepository(db, {
        connectionId: gitlab.id,
        provider: "gitlab",
        externalId: "2",
        fullPath: "acme/web",
      })
    ).id;
    await updateRepositoryRalphSettings(db, repoA, {
      ralphEnabled: true,
      ralphSettings: DEFAULT_RALPH_SETTINGS,
    });
    [{ id: harnessId }] = (await db
      .insert(harnesses)
      .values({ organizationId: orgId, name: "agent-a", acceptedTaskTypes: ["coding"] })
      .returning({ id: harnesses.id })) as [{ id: string }];
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    await db.delete(jobs);
    await db.delete(ralphRuns);
    await db.delete(reviewRuns);
    await db.delete(triageRuns);
    await db.delete(chatConnections);
    await db.delete(integrations);
    state.user = admin;
    state.orgId = orgId;
    linear = new FakeLinearGateway();
    state.linear = linear;
    state.dispatcher = new PostgresDispatcher({ db });
  });

  async function newRun(overrides: Partial<NewLinearRalphRunInput> = {}) {
    session += 1;
    const { run } = await createRun(db, {
      organizationId: orgId,
      linearIssueId: `issue-${session}`,
      linearIdentifier: `ENG-${session}`,
      linearTitle: `Epic ${session}`,
      linearUrl: `https://linear.app/acme/issue/ENG-${session}/epic`,
      linearAgentSessionId: `session-${session}`,
      kind: "children",
      repositoryId: repoA,
      branch: `eng-${session}`,
      baseBranch: "main",
      ...overrides,
    });
    return linearRun(run);
  }

  /** Sets a run's `created_at` (in any source table) to day `day` of October 2026. */
  async function createdOn(
    table: typeof ralphRuns | typeof reviewRuns | typeof triageRuns,
    id: string,
    day: number,
  ) {
    const at = new Date(Date.UTC(2026, 9, day)).toISOString();
    await db.execute(sql`update ${table} set created_at = ${at}::timestamptz where id = ${id}`);
  }

  async function slackThread(externalThreadId = "slack:C0123:1.1") {
    const connection = await saveChatConnection(db, {
      organizationId: orgId,
      platform: "slack",
      externalId: "T1",
      name: "Acme",
      credentials: null,
      installedByUserId: null,
    });
    if (connection === "other_organization") throw new Error("connected elsewhere");
    return (await ensureChatThread(db, {
      connectionId: connection.id,
      externalThreadId,
      channelId: "slack:C0123",
      startedByExternalUserId: "U1",
    }))!;
  }

  /** One run of each kind (and a chat request), oldest first. */
  async function runOfEachKind() {
    // Epic: two stories, one built; its story job used tokens.
    const epic = await newRun();
    await updateRun(db, epic.id, { status: "completed", harnessId });
    await updateLane(db, (await getMainLane(db, epic))!.id, {
      prNumber: 7,
      prUrl: "https://github.com/acme/api/pull/7",
    });
    const stories = await upsertStories(db, epic.id, [
      { linearIssueId: "s-1", identifier: "ENG-11", title: "One" },
      { linearIssueId: "s-2", identifier: "ENG-12", title: "Two" },
    ]);
    await updateStory(db, stories[0]!.id, { status: "completed" });
    const { job: storyJob } = await insertJob(db, {
      organizationId: orgId,
      type: "ralph.story",
      taskType: "coding",
      pool: "long",
      ralphRunId: epic.id,
    });
    const started = new Date(Date.UTC(2026, 9, 1, 9));
    await db
      .update(jobs)
      .set({
        status: "completed",
        startedAt: started,
        finishedAt: new Date(Date.UTC(2026, 9, 1, 10)),
        result: { usage: { inputTokens: 1200, outputTokens: 300 } },
      })
      .where(eq(jobs.id, storyJob.id));
    await createdOn(ralphRuns, epic.id, 1);

    // Request: a Linear mention, waiting.
    const request = await newRun({ mode: "request", kind: "single" });
    await updateRun(db, request.id, { status: "waiting" });
    await createdOn(ralphRuns, request.id, 2);

    // Review: a merge request mention whose two passes are being correlated.
    const reviewRun = await createReviewRun(db, {
      organizationId: orgId,
      repositoryId: repoB,
      prNumber: 3,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      trigger: "mention",
      mode: "full",
      profileId: "standard",
    });
    await db
      .update(reviewRuns)
      .set({ status: "correlating" })
      .where(eq(reviewRuns.id, reviewRun.id));
    for (const [i, status] of (["completed", "completed"] as const).entries()) {
      const review = await createReview(db, {
        reviewRunId: reviewRun.id,
        repositoryId: repoB,
        prNumber: 3,
        prTitle: "Tidy the web app",
        headSha: "a".repeat(40),
        baseSha: "b".repeat(40),
        trigger: "mention",
        profileId: "standard",
        model: null,
        budget: 100_000,
      });
      await db
        .update(reviews)
        .set({ status, harnessId, tokensIn: 50 + i, tokensOut: 5 })
        .where(eq(reviews.id, review.id));
    }
    await createdOn(reviewRuns, reviewRun.id, 3);

    // Triage: from the label, its job read the issue.
    const { run: triage } = await createTriageRun(db, {
      organizationId: orgId,
      linearIssueId: "issue-triage",
      linearAgentSessionId: "session-triage",
      trigger: "label",
    });
    await db.update(triageRuns).set({ status: "running" }).where(eq(triageRuns.id, triage.id));
    await insertJob(db, {
      organizationId: orgId,
      type: "triage.run",
      taskType: "query",
      pool: "short",
      repositoryId: repoA,
      triageRunId: triage.id,
      payload: {
        trigger: {
          kind: "linear.triage",
          context: {
            triageRunId: triage.id,
            issue: {
              identifier: "ENG-90",
              title: "Shape the import",
              url: "https://linear.app/acme/issue/ENG-90/shape-the-import",
            },
          },
        },
      },
    });
    await createdOn(triageRuns, triage.id, 4);

    // Ask: a question from Slack whose job was canceled.
    const thread = await slackThread();
    const { job: askJob } = await insertJob(db, {
      organizationId: orgId,
      type: "chat.ask",
      taskType: "query",
      pool: "short",
      repositoryId: repoA,
      payload: {
        trigger: { kind: "chat.request", context: { question: "Where is auth handled?" } },
      },
    });
    await db
      .update(jobs)
      .set({ status: "canceled", harnessId, finishedAt: new Date(Date.UTC(2026, 9, 5, 1)) })
      .where(eq(jobs.id, askJob.id));
    const ask = (await mapThreadRun(db, {
      organizationId: orgId,
      chatThreadId: thread.id,
      jobId: askJob.id,
    }))!;
    await db
      .update(chatThreadRuns)
      .set({ createdAt: new Date(Date.UTC(2026, 9, 5)) })
      .where(eq(chatThreadRuns.id, ask.id));

    // A coding request from another Slack thread.
    const chatThread = await slackThread("slack:C0123:2.2");
    const { run: chat } = await createRun(db, {
      origin: "chat",
      organizationId: orgId,
      chatThreadId: chatThread.id,
      repositoryId: repoA,
      branch: "omniralph/readme-typo",
      baseBranch: "main",
    });
    await insertMessage(db, { runId: chat.id, kind: "request", text: "Fix the  README typo" });
    await createdOn(ralphRuns, chat.id, 6);

    return { epic, request, reviewRun, triage, ask, chat };
  }

  it("lists one run of each kind, newest first, with its kind, status, title and references", async () => {
    const { epic, request, reviewRun, triage, ask, chat } = await runOfEachKind();

    const list = await listPage();
    expect(list.nextCursor).toBeNull();
    expect(ids(list)).toEqual([chat.id, ask.id, triage.id, reviewRun.id, request.id, epic.id]);
    const byId = new Map(list.runs.map((r) => [r.id, r]));
    const organization = { id: orgId, name: "Acme", role: "admin" } as const;
    const github = { id: repoA, provider: "github", fullPath: "acme/api" } as const;
    const gitlab = { id: repoB, provider: "gitlab", fullPath: "acme/web" } as const;
    const agent = { id: harnessId, name: "agent-a" };

    expect(byId.get(epic.id)).toEqual({
      id: epic.id,
      kind: "epic",
      status: "completed",
      origin: "linear",
      organization,
      title: epic.linearTitle!,
      workItem: { tracker: "linear", identifier: epic.linearIdentifier, url: epic.linearUrl },
      repository: github,
      branch: (await getMainLane(db, epic))!.branch,
      pullRequest: { provider: "github", number: 7, url: "https://github.com/acme/api/pull/7" },
      agent,
      progress: { done: 1, total: 2 },
      tokens: { in: 1200, out: 300 },
      createdAt: "2026-10-01T00:00:00.000Z",
      startedAt: "2026-10-01T09:00:00.000Z",
      finishedAt: expect.any(String),
      updatedAt: expect.any(String),
    } satisfies RunRow);
    expect(byId.get(request.id)).toMatchObject({
      kind: "request",
      status: "waiting",
      origin: "linear_mention",
      title: request.linearTitle,
      workItem: { tracker: "linear", identifier: request.linearIdentifier },
      repository: github,
      pullRequest: null,
      agent: null,
      progress: null,
      tokens: { in: 0, out: 0 },
      startedAt: null,
      finishedAt: null,
    });
    expect(byId.get(reviewRun.id)).toMatchObject({
      kind: "review",
      status: "running",
      origin: "pr_mention",
      organization,
      title: "Tidy the web app",
      workItem: null,
      repository: gitlab,
      branch: null,
      pullRequest: {
        provider: "gitlab",
        number: 3,
        url: "https://gitlab.example.com/acme/web/-/merge_requests/3",
      },
      agent,
      // Two passes done; no correlation yet.
      progress: { done: 2, total: 2 },
      tokens: { in: 101, out: 10 },
      finishedAt: null,
    });
    expect(byId.get(triage.id)).toMatchObject({
      kind: "triage",
      status: "running",
      origin: "triage_label",
      title: "Shape the import",
      workItem: {
        tracker: "linear",
        identifier: "ENG-90",
        url: "https://linear.app/acme/issue/ENG-90/shape-the-import",
      },
      repository: github,
      pullRequest: null,
      agent: null,
    });
    expect(byId.get(ask.id)).toMatchObject({
      kind: "ask",
      // Its job was canceled.
      status: "stopped",
      origin: "chat",
      title: "Where is auth handled?",
      workItem: null,
      repository: github,
      agent,
      finishedAt: "2026-10-05T01:00:00.000Z",
    });
    expect(byId.get(chat.id)).toMatchObject({
      kind: "request",
      status: "queued",
      origin: "chat",
      title: "Fix the README typo",
      workItem: null,
      branch: "omniralph/readme-typo",
    });
  });

  it("combines filters, and refuses unknown filter values", async () => {
    const { epic, request, reviewRun, triage, ask, chat } = await runOfEachKind();

    expect(ids(await listPage({ kind: ["epic", "review"] }))).toEqual([reviewRun.id, epic.id]);
    expect(ids(await listPage({ kind: "request" }))).toEqual([chat.id, request.id]);
    expect(ids(await listPage({ status: ["running", "waiting"] }))).toEqual([
      triage.id,
      reviewRun.id,
      request.id,
    ]);
    expect(ids(await listPage({ kind: "review", status: "running" }))).toEqual([reviewRun.id]);
    expect(ids(await listPage({ kind: "epic", status: "running" }))).toEqual([]);
    expect(ids(await listPage({ repository: repoB }))).toEqual([reviewRun.id]);
    expect(ids(await listPage({ repository: repoA, kind: "request" }))).toEqual([
      chat.id,
      request.id,
    ]);
    expect(ids(await listPage({ origin: "chat" }))).toEqual([chat.id, ask.id]);
    expect(ids(await listPage({ origin: ["linear", "pr_mention"] }))).toEqual([
      reviewRun.id,
      epic.id,
    ]);
    expect(ids(await listPage({ agent: harnessId }))).toEqual([ask.id, reviewRun.id, epic.id]);
    expect(ids(await listPage({ agent: harnessId, origin: "chat", status: "stopped" }))).toEqual([
      ask.id,
    ]);
    expect(ids(await listPage({ organization: orgId, kind: "triage" }))).toEqual([triage.id]);

    const refused: Record<string, string | string[]>[] = [
      { kind: "coding" },
      { kind: ["epic", "bogus"] },
      // A source status, not a unified one.
      { status: "pending" },
      { origin: "github" },
      { repository: "not-a-uuid" },
      { agent: "agent-a" },
      { organization: "acme" },
      { cursor: "not-a-cursor" },
      { limit: "0" },
      { limit: "101" },
      { limit: "ten" },
    ];
    for (const search of refused) {
      const { status, body } = await listRequest(search);
      expect([JSON.stringify(search), status, body.error]).toEqual([
        JSON.stringify(search),
        400,
        expect.any(String),
      ]);
    }
    // An organization the user isn't a member of.
    expect((await listRequest({ organization: randomUUID() })).status).toBe(404);
  });

  it("pages with a cursor: each run once, also when runs share a created_at", async () => {
    const runs = [];
    for (let i = 0; i < 5; i++) runs.push(await newRun());
    const triage = (
      await createTriageRun(db, {
        organizationId: orgId,
        linearIssueId: "issue-page",
        linearAgentSessionId: "session-page",
        trigger: "mention",
      })
    ).run;
    // All at the same instant, to the microsecond.
    const at = new Date(Date.UTC(2026, 9, 10));
    for (const run of runs) await createdOn(ralphRuns, run.id, 10);
    await createdOn(triageRuns, triage.id, 10);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: RunList = await listPage({ limit: "2", ...(cursor ? { cursor } : {}) });
      expect(page.runs.length).toBeLessThanOrEqual(2);
      for (const run of page.runs) expect(run.createdAt).toBe(at.toISOString());
      seen.push(...ids(page));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(6);
    expect(new Set(seen)).toEqual(new Set([...runs.map((r) => r.id), triage.id]));

    // The default limit takes them all.
    expect(await listPage()).toMatchObject({ nextCursor: null });
    expect(ids(await listPage())).toEqual(seen);
  });

  it("stops only epic and request runs", async () => {
    const { triage, reviewRun } = await runOfEachKind();
    for (const id of [triage.id, reviewRun.id]) {
      const { status, body } = await call<Result>(runStop.POST, { id, method: "POST" });
      expect([status, body.error]).toEqual([400, "Only epic and request runs can be stopped."]);
    }
    const request = await newRun({ mode: "request", kind: "single" });
    await updateRun(db, request.id, { status: "running" });
    expect(await stopRalphRun(request.id)).toEqual({ ok: true });
    expect((await getRun(db, request.id))!.status).toBe("stopped");
  });

  it("is empty with no runs", async () => {
    expect(await listPage()).toEqual({ runs: [], nextCursor: null });
  });

  /** A job of the run, set to `finish` (status, times, usage, agent…) once inserted. */
  async function attempt(
    input: Omit<Parameters<typeof insertJob>[1], "organizationId" | "taskType" | "pool"> & {
      taskType?: "coding" | "query" | "review";
    },
    finish: Partial<typeof jobs.$inferInsert> = {},
  ) {
    const taskType = input.taskType ?? "coding";
    const { job } = await insertJob(db, {
      organizationId: orgId,
      pool: taskType === "coding" ? "long" : "short",
      ...input,
      taskType,
    });
    if (Object.keys(finish).length) await db.update(jobs).set(finish).where(eq(jobs.id, job.id));
    return job;
  }

  const at = (hour: number, minute = 0) => new Date(Date.UTC(2026, 9, 1, hour, minute));

  it("shows a multi-story epic: stories with their attempts, lanes, PR and actions", async () => {
    const run = await newRun();
    const main = (await getMainLane(db, run))!;
    await updateLane(db, main.id, { prNumber: 7, prUrl: "https://github.com/acme/api/pull/7" });
    const web = await ensureLane(db, {
      runId: run.id,
      repositoryId: repoB,
      branch: "eng-web",
      baseBranch: "develop",
    });
    await updateLane(db, web.id, { prNumber: 4, prClosed: true, prMerged: true });
    const [built, retried, merged, manual] = await upsertStories(db, run.id, [
      { linearIssueId: "e-1", identifier: "ENG-41", title: "Built", laneId: main.id },
      { linearIssueId: "e-2", identifier: "ENG-42", title: "Retried", laneId: main.id },
      { linearIssueId: "e-3", identifier: "ENG-43", title: "Web", laneId: web.id },
      { linearIssueId: "e-4", identifier: "ENG-44", title: "By hand" },
    ]);
    await updateStory(db, built!.id, { status: "completed", attempts: 1, commitSha: "abc123" });
    await updateStory(db, retried!.id, {
      status: "exhausted",
      attempts: 2,
      lastFeedback: "The tests still fail.",
    });
    await updateStory(db, merged!.id, { status: "exhausted", attempts: 1 });
    await updateStory(db, manual!.id, { status: "manual" });
    await updateRun(db, run.id, {
      status: "failed",
      error: "A story ran out of attempts.",
      harnessId,
    });

    const builtJob = await attempt(
      { type: "ralph.story", ralphRunId: run.id, ralphStoryId: built!.id },
      {
        status: "completed",
        harnessId,
        deliveryCount: 1,
        createdAt: at(9),
        startedAt: at(9),
        finishedAt: at(9, 30),
        result: { usage: { inputTokens: 100, outputTokens: 10 } },
      },
    );
    const firstTry = await attempt(
      { type: "ralph.story", ralphRunId: run.id, ralphStoryId: retried!.id },
      {
        status: "failed",
        error: "Tests failed.",
        harnessId,
        deliveryCount: 2,
        createdAt: at(10),
        startedAt: at(10),
        finishedAt: at(10, 10),
      },
    );
    const secondTry = await attempt(
      { type: "ralph.story", ralphRunId: run.id, ralphStoryId: retried!.id },
      { status: "expired", createdAt: at(11), startedAt: at(11), finishedAt: at(11, 5) },
    );
    const webJob = await attempt(
      { type: "ralph.story", ralphRunId: run.id, ralphStoryId: merged!.id },
      { status: "failed", createdAt: at(12) },
    );
    const describe = await attempt(
      { type: "ralph.describe-pr", ralphRunId: run.id },
      { status: "completed", createdAt: at(13) },
    );
    for (const body of ["Reading the code", "Running tests"]) {
      await insertRunActivity(db, {
        jobId: builtJob.id,
        organizationId: orgId,
        type: "thought",
        body,
      });
    }

    const view = await detailPage(run.id);
    expect(view).toMatchObject({
      id: run.id,
      kind: "epic",
      status: "failed",
      organization: { id: orgId, name: "Acme", role: "admin" },
      progress: { done: 1, total: 4 },
    });
    expect(view.steps).toEqual([
      {
        kind: "story",
        id: built!.id,
        workItem: {
          tracker: "linear",
          identifier: "ENG-41",
          url: "https://linear.app/acme/issue/ENG-41",
        },
        title: "Built",
        status: "completed",
        attempts: 1,
        durationMs: 30 * 60_000,
        commit: "abc123",
        lastFeedback: null,
        lane: {
          id: main.id,
          repository: { id: repoA, provider: "github", fullPath: "acme/api" },
          branch: main.branch,
        },
      },
      expect.objectContaining({
        id: retried!.id,
        status: "exhausted",
        attempts: 2,
        // Both attempts: 10 + 5 minutes.
        durationMs: 15 * 60_000,
        lastFeedback: "The tests still fail.",
      }),
      expect.objectContaining({
        id: merged!.id,
        durationMs: 0,
        lane: {
          id: web.id,
          repository: { id: repoB, provider: "gitlab", fullPath: "acme/web" },
          branch: "eng-web",
        },
      }),
      expect.objectContaining({ id: manual!.id, status: "manual", lane: null }),
    ]);

    // Newest first, each with its story.
    expect(view.attempts.map((a) => [a.id, a.step])).toEqual([
      [describe.id, null],
      [webJob.id, merged!.id],
      [secondTry.id, retried!.id],
      [firstTry.id, retried!.id],
      [builtJob.id, built!.id],
    ]);
    expect(view.attempts.at(-1)).toEqual({
      id: builtJob.id,
      label: "Built ENG-41",
      type: "ralph.story",
      status: "completed",
      agent: { id: harnessId, name: "agent-a" },
      deliveries: 1,
      cancelRequested: false,
      createdAt: at(9).toISOString(),
      startedAt: at(9).toISOString(),
      finishedAt: at(9, 30).toISOString(),
      tokens: { in: 100, out: 10 },
      error: null,
      step: built!.id,
      transcriptEvents: 2,
    });
    expect(view.attempts.find((a) => a.id === firstTry.id)).toMatchObject({
      label: "Couldn't build ENG-42",
      error: "Tests failed.",
      deliveries: 2,
      transcriptEvents: 0,
    });
    expect(view.attempts[0]!.label).toBe(
      "Wrote the pull request description for " + run.linearIdentifier,
    );
    for (const a of view.attempts) expect(a.label).not.toContain("ralph");

    expect(view.details).toEqual({
      repository: { id: repoA, provider: "github", fullPath: "acme/api" },
      branch: main.branch,
      baseBranch: "main",
      routedBy: null,
      agent: { id: harnessId, name: "agent-a" },
      tokens: { in: 100, out: 10 },
      attemptCount: 5,
      pullRequest: {
        provider: "github",
        number: 7,
        url: "https://github.com/acme/api/pull/7",
        merged: false,
        closed: false,
      },
      lanes: [
        {
          id: main.id,
          repository: { id: repoA, provider: "github", fullPath: "acme/api" },
          branch: main.branch,
          baseBranch: "main",
          pullRequest: {
            provider: "github",
            number: 7,
            url: "https://github.com/acme/api/pull/7",
            merged: false,
            closed: false,
            draft: false,
            reviewState: "none",
          },
        },
        {
          id: web.id,
          repository: { id: repoB, provider: "gitlab", fullPath: "acme/web" },
          branch: "eng-web",
          baseBranch: "develop",
          pullRequest: {
            provider: "gitlab",
            number: 4,
            url: "https://gitlab.example.com/acme/web/-/merge_requests/4",
            merged: true,
            closed: true,
            draft: false,
            reviewState: "none",
          },
        },
      ],
      error: "A story ran out of attempts.",
      waitingOn: null,
      actions: {
        // Members can't stop runs yet; a failed run doesn't stop anyway.
        stop: false,
        retry: {
          run: true,
          // Not the story whose merge request is merged, nor the manual one.
          storyIds: [built!.id, retried!.id],
          // The newest attempt of each story that didn't succeed.
          attemptIds: [webJob.id, secondTry.id],
        },
      },
    });

    // A finished epic re-runs only a completed story.
    await updateRun(db, run.id, { status: "completed" });
    expect((await detailPage(run.id)).details.actions.retry).toEqual({
      run: false,
      storyIds: [built!.id],
      attemptIds: [],
    });
    // A running one can be stopped (by an admin), and retries nothing.
    await updateRun(db, run.id, { status: "running" });
    expect((await detailPage(run.id)).details.actions).toEqual({
      stop: true,
      retry: { run: false, storyIds: [], attemptIds: [] },
    });
    state.user = member;
    state.orgId = orgId;
    expect((await detailPage(run.id)).details.actions.stop).toBe(false);
  });

  it("shows what a waiting epic waits for", async () => {
    const run = await newRun();
    await updateRun(db, run.id, {
      status: "waiting",
      routedBy: "team `ENG`",
      waitingOn: {
        blockers: [{ id: "b-1", identifier: "OPS-3", title: "Infra" }],
        manual: [{ id: "m-1", identifier: "ENG-50", title: "By hand" }],
      },
    });
    const view = await detailPage(run.id);
    expect(view.details).toMatchObject({
      routedBy: "team `ENG`",
      waitingOn: {
        blockers: [
          { tracker: "linear", identifier: "OPS-3", url: "https://linear.app/acme/issue/OPS-3" },
        ],
        manual: [
          { tracker: "linear", identifier: "ENG-50", url: "https://linear.app/acme/issue/ENG-50" },
        ],
      },
      pullRequest: null,
      actions: { stop: true, retry: { run: true, storyIds: [], attemptIds: [] } },
    });
    expect(view.steps).toEqual([]);
  });

  it("shows a request run's attempts as its steps", async () => {
    const run = await newRun({ mode: "request", kind: "single" });
    await updateRun(db, run.id, { status: "stopped" });
    const first = await attempt(
      { type: "ralph.request", ralphRunId: run.id },
      { status: "completed", createdAt: at(9), startedAt: at(9), finishedAt: at(9, 2) },
    );
    const second = await attempt(
      { type: "ralph.request", ralphRunId: run.id },
      { status: "canceled", createdAt: at(10) },
    );
    const view = await detailPage(run.id);
    expect(view.steps).toEqual([
      {
        kind: "attempt",
        id: first.id,
        label: `Worked on a request in ${run.linearIdentifier}`,
        status: "completed",
        durationMs: 120_000,
      },
      {
        kind: "attempt",
        id: second.id,
        label: `Couldn't work on a request in ${run.linearIdentifier}`,
        status: "canceled",
        durationMs: null,
      },
    ]);
    expect(view.attempts.map((a) => [a.id, a.step])).toEqual([
      [second.id, second.id],
      [first.id, first.id],
    ]);
    expect(view.details.actions.retry).toEqual({
      run: true,
      storyIds: [],
      attemptIds: [second.id],
    });
  });

  it("shows a review run: two passes with their open findings, and the correlation", async () => {
    const { reviewRun } = await runOfEachKind();
    const passes = await db
      .select()
      .from(reviews)
      .where(eq(reviews.reviewRunId, reviewRun.id))
      .orderBy(reviews.createdAt, reviews.id);
    const [security, style] = passes;
    await db
      .update(reviews)
      .set({ taskId: "builtin:review-pr", durationMs: 4000 })
      .where(eq(reviews.id, security!.id));
    await db.update(reviews).set({ status: "failed" }).where(eq(reviews.id, style!.id));
    const finding = (severity: "high" | "low", status: "open" | "dismissed" = "open") => ({
      reviewId: security!.id,
      path: "src/a.ts",
      startLine: 1,
      endLine: 2,
      severity,
      category: "bug",
      title: "A finding",
      body: "Body",
      confidence: 0.9,
      status,
    });
    await db
      .insert(findings)
      .values([finding("high"), finding("high"), finding("low"), finding("low", "dismissed")]);
    const passJobs = [];
    for (const pass of [security!, style!]) {
      passJobs.push(
        await attempt(
          {
            type: "review.task",
            taskType: "review",
            reviewRunId: reviewRun.id,
            repositoryId: repoB,
            payload: { trigger: { kind: "pr.mention", context: { reviewId: pass.id } } },
          },
          { status: pass === security ? "completed" : "failed", harnessId },
        ),
      );
    }
    const correlation = await attempt(
      { type: "review.correlate", taskType: "query", reviewRunId: reviewRun.id },
      {
        status: "running",
        startedAt: at(9),
        result: { usage: { inputTokens: 7, outputTokens: 3 } },
      },
    );
    await db
      .update(reviewRuns)
      .set({ correlationJobId: correlation.id })
      .where(eq(reviewRuns.id, reviewRun.id));

    const view = await detailPage(reviewRun.id);
    expect(view).toMatchObject({ kind: "review", status: "running", progress: { total: 3 } });
    expect(view.steps).toEqual([
      {
        kind: "review_pass",
        id: security!.id,
        taskName: "Review a pull request",
        status: "completed",
        tokens: { in: 50, out: 5 },
        durationMs: 4000,
        openFindings: { critical: 0, high: 2, medium: 0, low: 1, info: 0 },
      },
      {
        kind: "review_pass",
        id: style!.id,
        taskName: "Review",
        status: "failed",
        tokens: { in: 51, out: 5 },
        durationMs: null,
        openFindings: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      },
      {
        kind: "correlation",
        id: correlation.id,
        label: "Combining the review findings for merge request !3 in web",
        status: "running",
        tokens: { in: 7, out: 3 },
        durationMs: null,
      },
    ]);
    expect(view.attempts.map((a) => [a.id, a.step])).toEqual([
      [correlation.id, correlation.id],
      [passJobs[1]!.id, style!.id],
      [passJobs[0]!.id, security!.id],
    ]);
    expect(view.attempts.map((a) => a.label)).toEqual([
      "Combining the review findings for merge request !3 in web",
      expect.stringContaining("Couldn't"),
      expect.not.stringContaining("Couldn't"),
    ]);
    expect(view.details).toMatchObject({
      repository: { id: repoB, provider: "gitlab", fullPath: "acme/web" },
      routedBy: null,
      lanes: [],
      attemptCount: 3,
      pullRequest: {
        provider: "gitlab",
        number: 3,
        url: "https://gitlab.example.com/acme/web/-/merge_requests/3",
        // Not a merge request Om opened: unknown.
        merged: null,
        closed: null,
      },
      // Correlating: nothing to retry or stop.
      actions: { stop: false, retry: { run: false, storyIds: [], attemptIds: [] } },
    });

    await db.update(reviewRuns).set({ status: "failed" }).where(eq(reviewRuns.id, reviewRun.id));
    expect((await detailPage(reviewRun.id)).details.actions.retry).toEqual({
      run: true,
      storyIds: [],
      attemptIds: [passJobs[1]!.id],
    });
  });

  it("shows a triage run's turns, and an ask", async () => {
    const { triage, ask } = await runOfEachKind();
    const [firstTurn] = await db.select().from(jobs).where(eq(jobs.triageRunId, triage.id));
    await db
      .update(jobs)
      .set({ status: "completed", createdAt: at(8), startedAt: at(8), finishedAt: at(8, 1) })
      .where(eq(jobs.id, firstTurn!.id));
    const secondTurn = await attempt(
      { type: "triage.run", taskType: "query", triageRunId: triage.id, repositoryId: repoA },
      { status: "running", harnessId, startedAt: at(9), createdAt: at(9) },
    );

    const triageView = await detailPage(triage.id);
    expect(triageView.steps).toEqual([
      {
        kind: "attempt",
        id: firstTurn!.id,
        label: "Triaged ENG-90",
        status: "completed",
        durationMs: 60_000,
      },
      {
        kind: "attempt",
        id: secondTurn.id,
        label: "Triaging ENG-90",
        status: "running",
        durationMs: null,
      },
    ]);
    expect(triageView.attempts.map((a) => [a.id, a.step, a.agent?.name ?? null])).toEqual([
      [secondTurn.id, secondTurn.id, "agent-a"],
      [firstTurn!.id, firstTurn!.id, null],
    ]);
    expect(triageView.details).toMatchObject({
      attemptCount: 2,
      pullRequest: null,
      lanes: [],
      actions: { stop: false, retry: { run: false, storyIds: [], attemptIds: [] } },
    });

    const askView = await detailPage(ask.id);
    const [askJob] = askView.attempts;
    expect(askView).toMatchObject({
      kind: "ask",
      status: "stopped",
      title: "Where is auth handled?",
      steps: [{ kind: "attempt", id: askJob!.id, label: "Couldn't answer a question about api" }],
    });
    expect(askJob).toMatchObject({ type: "chat.ask", status: "canceled", step: askJob!.id });
    expect(askView.details).toMatchObject({
      attemptCount: 1,
      actions: { stop: false, retry: { run: true, attemptIds: [askJob!.id] } },
    });
  });

  it("is 404 for an unknown run", async () => {
    await expect(detailPage(randomUUID())).rejects.toThrow("HTTP 404");
    await expect(detailPage("nope")).rejects.toThrow("HTTP 404");
  });

  async function transcript(id: string, attemptId: string, search: Record<string, string> = {}) {
    const response = await transcriptRoute.GET(
      new Request(`http://localhost/api/ui?${new URLSearchParams(search)}`),
      { params: Promise.resolve({ id, attemptId }) },
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it("pages an attempt's transcript oldest first, and 404s on another run's attempt", async () => {
    const run = await newRun();
    const job = await attempt({ type: "ralph.story", ralphRunId: run.id });
    const base = Date.UTC(2026, 9, 1, 9);
    const activities = [];
    for (let i = 0; i < 5; i++) {
      const activity = await insertRunActivity(db, {
        jobId: job.id,
        organizationId: orgId,
        type: i % 2 ? "action" : "thought",
        body: i % 2 ? "Bash" : `Thought ${i}`,
        parameter: i % 2 ? `cmd ${i}` : null,
      });
      activities.push(activity);
    }
    // Two share an instant, to the microsecond.
    for (const [i, activity] of activities.entries()) {
      const when = new Date(base + Math.min(i, 3) * 1000).toISOString();
      await db.execute(
        sql`update run_activities set created_at = ${when}::timestamptz where id = ${activity.id}`,
      );
    }

    const all = await transcript(run.id, job.id);
    expect(all.status).toBe(200);
    const page = transcriptPageSchema.parse(all.body);
    expect(page.nextCursor).toBeNull();
    expect(page.events[0]).toEqual({
      id: activities[0]!.id,
      type: "thought",
      body: "Thought 0",
      parameter: null,
      at: new Date(base).toISOString(),
    });
    expect(page.events[1]).toMatchObject({ type: "action", body: "Bash", parameter: "cmd 1" });
    const order = page.events.map((e) => e.id);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const { body } = await transcript(run.id, job.id, {
        limit: "2",
        ...(cursor ? { cursor } : {}),
      });
      const next = transcriptPageSchema.parse(body);
      seen.push(...next.events.map((e) => e.id));
      cursor = next.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(order);
    expect(new Set(seen)).toEqual(new Set(activities.map((a) => a.id)));

    const refused: Record<string, string>[] = [
      { limit: "0" },
      { limit: "501" },
      { limit: "x" },
      { cursor: "bad" },
    ];
    for (const search of refused) {
      expect((await transcript(run.id, job.id, search)).status).toBe(400);
    }
    expect((await transcript(run.id, job.id, { limit: "500" })).status).toBe(200);

    // Another run's attempt, an unknown one and an unknown run.
    const other = await newRun();
    const otherJob = await attempt({ type: "ralph.story", ralphRunId: other.id });
    expect(await transcript(run.id, otherJob.id)).toMatchObject({
      status: 404,
      body: { error: "That attempt doesn't exist." },
    });
    expect((await transcript(run.id, randomUUID())).status).toBe(404);
    expect((await transcript(run.id, "nope")).status).toBe(404);
    expect((await transcript(randomUUID(), job.id)).status).toBe(404);
  });

  async function runningRun(): Promise<{ run: LinearRun; jobId: string }> {
    const run = await newRun();
    const [story] = await upsertStories(db, run.id, [
      { linearIssueId: "r-1", identifier: "ENG-31", title: "Story" },
    ]);
    const { job } = await insertJob(db, {
      organizationId: orgId,
      type: "ralph.story",
      taskType: "coding",
      pool: "long",
      ralphRunId: run.id,
    });
    await updateStory(db, story!.id, { status: "running", lastJobId: job.id });
    await updateRun(db, run.id, { status: "running" });
    return { run: linearRun((await getRun(db, run.id))!), jobId: job.id };
  }

  it("stops a run like the Linear stop reply: job canceled, session told who stopped it", async () => {
    const { run, jobId } = await runningRun();
    expect(await stopRalphRun(run.id)).toEqual({ ok: true });

    expect((await getRun(db, run.id))!.status).toBe("stopped");
    expect((await getJob(db, jobId))!.status).toBe("canceled");
    expect((await listStories(db, run.id)).map((s) => s.status)).toEqual(["pending"]);
    const [response] = linear.bodies(run.linearAgentSessionId, "response");
    expect(response).toContain("Stopped (requested by Ada Admin).");
    expect(response).toContain("I canceled the job that was running.");
    expect(linear.plan(run.linearAgentSessionId)).toBeDefined();

    expect(await stopRalphRun(run.id)).toEqual({
      ok: false,
      error: "This run is already stopped.",
    });
  });

  it("stops a run whose job is running: the job shows its cancel request until its harness confirms", async () => {
    const { run, jobId } = await runningRun();
    await db.update(jobs).set({ status: "running", harnessId }).where(eq(jobs.id, jobId));
    expect(await stopRalphRun(run.id)).toEqual({ ok: true });

    const view = await detailPage(run.id);
    expect(view.status).toBe("stopped");
    expect(view.attempts).toMatchObject([{ id: jobId, status: "running", cancelRequested: true }]);
  });

  it("only lets admins stop a run", async () => {
    const { run, jobId } = await runningRun();
    state.user = member;
    const result = await stopRalphRun(run.id);
    expect(result.ok).toBe(false);
    state.user = null;
    expect((await stopRalphRun(run.id)).ok).toBe(false);

    expect((await getRun(db, run.id))!.status).toBe("running");
    expect((await getJob(db, jobId))!.status).toBe("queued");
    expect(linear.bodies(run.linearAgentSessionId, "response")).toEqual([]);
  });

  it("stops a run while Linear isn't connected, and rejects unknown or finished runs", async () => {
    const { run } = await runningRun();
    state.linear = disconnectedLinearGateway();
    expect(await stopRalphRun(run.id)).toEqual({ ok: true });
    expect((await getRun(db, run.id))!.status).toBe("stopped");

    const done = await newRun();
    await updateRun(db, done.id, { status: "completed" });
    expect(await stopRalphRun(done.id)).toEqual({
      ok: false,
      error: "This run is already over (completed).",
    });
    expect(await stopRalphRun("00000000-0000-4000-8000-000000000000")).toEqual({
      ok: false,
      error: "That run doesn't exist.",
    });
    expect((await stopRalphRun("nope")).ok).toBe(false);
  });

  it("keeps another organization's runs out: not listed, 404 and can't be stopped", async () => {
    // Another organization with its own repository, Linear workspace and run.
    const [other] = await db.insert(organizations).values({ name: "Other" }).returning();
    await seedReviewProfiles(db, other!.id);
    const connection = (await upsertScmConnection(db, {
      organizationId: other!.id,
      provider: "github",
      name: "other",
      baseUrl: "https://api.github.com",
      externalId: "other-1",
      credentials: {},
    }))!;
    const otherRepo = (
      await connectRepository(db, {
        connectionId: connection.id,
        provider: "github",
        externalId: "99",
        fullPath: "other/api",
      })
    ).id;
    await updateRepositoryRalphSettings(db, otherRepo, {
      ralphEnabled: true,
      ralphSettings: DEFAULT_RALPH_SETTINGS,
    });
    await saveIntegration(db, {
      organizationId: other!.id,
      provider: "linear",
      externalId: "org-2",
      name: "Other",
      credentials: { accessToken: "lin_other" },
      installedByUserId: null,
    });
    const theirs = await newRun({ organizationId: other!.id, repositoryId: otherRepo });
    await updateRun(db, theirs.id, { status: "running" });
    const ours = await newRun();

    const list = await listPage();
    expect(ids(list)).toEqual([ours.id]);
    expect(JSON.stringify(list)).not.toContain("other/api");
    expect(await listPage({ repository: otherRepo })).toEqual({ runs: [], nextCursor: null });
    expect((await listRequest({ organization: other!.id })).status).toBe(404);
    await expect(detailPage(theirs.id)).rejects.toThrow("HTTP 404");
    expect(await stopRalphRun(theirs.id)).toEqual({
      ok: false,
      error: "That run doesn't exist.",
    });
    expect((await getRun(db, theirs.id))!.status).toBe("running");

    // Their members see it.
    state.orgId = other!.id;
    expect(ids(await listPage())).toEqual([theirs.id]);
    expect(await detailPage(theirs.id)).toMatchObject({ id: theirs.id });
    await expect(detailPage(ours.id)).rejects.toThrow("HTTP 404");
  });
});
