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
  getJob,
  getMainLane,
  getRun,
  insertJob,
  insertMessage,
  integrations,
  jobs,
  listStories,
  ralphMessages,
  ralphRuns,
  RUN_DETAIL_MESSAGE_LIMIT,
  saveChatConnection,
  saveIntegration,
  updateLane,
  updateMessage,
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
import type { RunDetail } from "@/app/api/ui/runs/[id]/route";

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
  return body;
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

  async function connectLinear() {
    await saveIntegration(db, {
      organizationId: orgId,
      provider: "linear",
      externalId: "org-1",
      name: "Acme",
      credentials: { accessToken: "lin_x" },
      installedByUserId: null,
    });
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

  it("shows a chat run's detail with its platform and channel instead of a Linear issue", async () => {
    const thread = await slackThread();
    const { run } = await createRun(db, {
      origin: "chat",
      organizationId: orgId,
      chatThreadId: thread.id,
      repositoryId: repoA,
      branch: "omniralph/readme-typo",
      baseBranch: "main",
    });

    const { run: view } = await detailPage(run.id);
    expect(view).toMatchObject({
      origin: "chat",
      linearIdentifier: null,
      chatThread: { platform: "slack", channelId: "slack:C0123" },
      branch: "omniralph/readme-typo",
    });
  });

  it("is empty with no runs", async () => {
    expect(await listPage()).toEqual({ runs: [], nextCursor: null });
  });

  it("loads a run's detail: header, stories, guidance, progress and jobs", async () => {
    const run = await newRun();
    const [s1, s2] = await upsertStories(db, run.id, [
      { linearIssueId: "d-1", identifier: "ENG-21", title: "First" },
      { linearIssueId: "d-2", identifier: "ENG-22", title: "Second" },
    ]);
    const { job } = await insertJob(db, {
      organizationId: orgId,
      type: "ralph.story",
      taskType: "coding",
      pool: "long",
      ralphRunId: run.id,
    });
    await db
      .update(jobs)
      .set({ status: "completed", harnessId, finishedAt: new Date() })
      .where(eq(jobs.id, job.id));
    await updateStory(db, s1!.id, {
      status: "completed",
      attempts: 2,
      commitSha: "a".repeat(40),
      lastJobId: job.id,
    });
    await updateStory(db, s2!.id, {
      status: "blocked",
      attempts: 1,
      lastFeedback: "Gates failed.",
    });
    await updateRun(db, run.id, {
      status: "waiting",
      harnessId,
      waitingOn: {
        blockers: [{ id: "x", identifier: "OPS-1", title: "Provision DB" }],
        manual: [],
      },
      guidance: [{ text: "Use pnpm.", at: "2026-10-06T01:00:00.000Z" }],
      progress: "## Progress\n- did ENG-21",
    });
    await connectLinear();

    const { run: view, linearConnected } = await detailPage(run.id);
    expect(linearConnected).toBe(true);
    expect(view).toMatchObject({
      id: run.id,
      linearIdentifier: run.linearIdentifier,
      linearTitle: run.linearTitle,
      linearUrl: run.linearUrl,
      status: "waiting",
      repository: { id: repoA, fullPath: "acme/api" },
      branch: `eng-${session}`,
      baseBranch: "main",
      agent: { id: harnessId, name: "agent-a" },
      pullRequest: null,
      waitingOn: { blockers: [{ identifier: "OPS-1", title: "Provision DB" }], manual: [] },
      guidance: [{ text: "Use pnpm.", at: "2026-10-06T01:00:00.000Z" }],
      progress: "## Progress\n- did ENG-21",
      storyCounts: { total: 2, completed: 1 },
    });
    expect(view.stories).toEqual([
      {
        id: s1!.id,
        identifier: "ENG-21",
        title: "First",
        status: "completed",
        attempts: 2,
        lastFeedback: null,
        commitSha: "a".repeat(40),
        lastJobId: job.id,
        laneId: null,
        elsewhere: null,
        recommendations: [],
      },
      {
        id: s2!.id,
        identifier: "ENG-22",
        title: "Second",
        status: "blocked",
        attempts: 1,
        lastFeedback: "Gates failed.",
        commitSha: null,
        lastJobId: null,
        laneId: null,
        elsewhere: null,
        recommendations: [],
      },
    ]);
    expect(view.jobs).toMatchObject([
      { id: job.id, type: "ralph.story", status: "completed", agent: { name: "agent-a" } },
    ]);

    // One section per lane: the main lane first, each with its branch, PR/MR and stories.
    const main = (await getMainLane(db, run))!;
    const web = await ensureLane(db, {
      runId: run.id,
      repositoryId: repoB,
      branch: main.branch,
      baseBranch: "develop",
    });
    await updateLane(db, web.id, {
      prNumber: 8,
      prUrl: "https://gitlab.com/acme/web/-/merge_requests/8",
    });
    await upsertStories(db, run.id, [
      { linearIssueId: "d-1", identifier: "ENG-21", title: "First", laneId: main.id },
      { linearIssueId: "d-2", identifier: "ENG-22", title: "Second", laneId: web.id },
      {
        linearIssueId: "d-3",
        identifier: "ENG-23",
        title: "Docs",
        elsewhere: "it's in project Docs",
      },
    ]);
    const laned = (await detailPage(run.id)).run;
    expect(laned.lanes).toEqual([
      {
        id: main.id,
        repository: { id: repoA, provider: "github", fullPath: "acme/api" },
        main: true,
        branch: main.branch,
        baseBranch: "main",
        pullRequest: null,
        cleanup: null,
        reviewRounds: { done: 0, max: 3 },
        ciFixRounds: { done: 0, max: 3 },
      },
      {
        id: web.id,
        repository: { id: repoB, provider: "gitlab", fullPath: "acme/web" },
        main: false,
        branch: main.branch,
        baseBranch: "develop",
        pullRequest: {
          number: 8,
          url: "https://gitlab.com/acme/web/-/merge_requests/8",
          label: "!8",
        },
        cleanup: null,
        reviewRounds: { done: 0, max: 3 },
        ciFixRounds: { done: 0, max: 3 },
      },
    ]);
    expect(laned.stories.map((s) => [s.identifier, s.laneId, s.elsewhere])).toEqual([
      ["ENG-21", main.id, null],
      ["ENG-22", web.id, null],
      ["ENG-23", null, "it's in project Docs"],
    ]);

    // waiting_on is only shown while waiting.
    await updateRun(db, run.id, { status: "running" });
    expect((await detailPage(run.id)).run.waitingOn).toBeNull();

    await expect(detailPage("00000000-0000-4000-8000-000000000000")).rejects.toThrow("HTTP 404");
    await expect(detailPage("nope")).rejects.toThrow("HTTP 404");
  });

  it("shows each lane's review/CI rounds, the pending requests and the live messages", async () => {
    // acme/web turned CI fixes off and allows 5 review rounds.
    await updateRepositoryRalphSettings(db, repoB, {
      ralphEnabled: true,
      ralphSettings: { ...DEFAULT_RALPH_SETTINGS, maxReviewRounds: 5, respondToCiFailures: false },
    });
    const run = await newRun();
    const main = (await getMainLane(db, run))!;
    await updateLane(db, main.id, { reviewRounds: 2, ciFixRounds: 3 });
    const web = await ensureLane(db, {
      runId: run.id,
      repositoryId: repoB,
      branch: main.branch,
      baseBranch: "main",
    });
    await updateLane(db, web.id, { reviewRounds: 1, ciFixRounds: 1 });

    // Pending: no job, not consumed (lane null: the main lane's). Consumed ones aren't listed.
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 6, 10, minute));
    const ask = await insertMessage(db, {
      runId: run.id,
      kind: "request",
      text: "Open the PR",
      author: "Ada",
    });
    const fix = await insertMessage(db, {
      runId: run.id,
      laneId: web.id,
      kind: "request",
      text: "Fix the CI",
    });
    const done = await insertMessage(db, { runId: run.id, kind: "request", text: "Done already" });
    await updateMessage(db, done.id, { consumedAt: new Date() });

    // Live messages: delivered, rejected (kept as guidance), still waiting.
    const { job: story } = await insertJob(db, {
      organizationId: orgId,
      type: "ralph.story",
      taskType: "coding",
      pool: "long",
      ralphRunId: run.id,
    });
    await db.update(jobs).set({ status: "running", harnessId }).where(eq(jobs.id, story.id));
    const live = async (
      minute: number,
      text: string,
      update: Parameters<typeof updateMessage>[2],
    ) => {
      const message = await insertMessage(db, {
        runId: run.id,
        jobId: story.id,
        kind: "guidance",
        text,
        author: "Bob",
      });
      await db
        .update(ralphMessages)
        .set({ createdAt: at(minute) })
        .where(eq(ralphMessages.id, message.id));
      if (Object.keys(update).length > 0) await updateMessage(db, message.id, update);
      return message;
    };
    const delivered = await live(1, "Use pnpm", { deliveredAt: at(2), consumedAt: at(2) });
    const rejected = await live(3, "Skip the docs", { consumedAt: at(4) });
    const waiting = await live(5, "Also add a test", {});

    const view = (await detailPage(run.id)).run;
    expect(view.lanes.map((l) => [l.repository.fullPath, l.reviewRounds, l.ciFixRounds])).toEqual([
      ["acme/api", { done: 2, max: 3 }, { done: 3, max: 3 }],
      ["acme/web", { done: 1, max: 5 }, { done: 1, max: null }],
    ]);
    expect(view.pendingRequests).toEqual([
      {
        id: ask.id,
        laneId: null,
        text: "Open the PR",
        author: "Ada",
        createdAt: ask.createdAt.toISOString(),
      },
      {
        id: fix.id,
        laneId: web.id,
        text: "Fix the CI",
        author: null,
        createdAt: fix.createdAt.toISOString(),
      },
    ]);
    expect(view.messageLimit).toBe(RUN_DETAIL_MESSAGE_LIMIT);
    const job = { id: story.id, type: "ralph.story", status: "running" };
    expect(view.messages).toEqual([
      {
        id: waiting.id,
        kind: "guidance",
        text: "Also add a test",
        author: "Bob",
        job,
        state: "waiting",
        createdAt: at(5).toISOString(),
        deliveredAt: null,
        consumedAt: null,
      },
      {
        id: rejected.id,
        kind: "guidance",
        text: "Skip the docs",
        author: "Bob",
        job,
        state: "guidance",
        createdAt: at(3).toISOString(),
        deliveredAt: null,
        consumedAt: at(4).toISOString(),
      },
      {
        id: delivered.id,
        kind: "guidance",
        text: "Use pnpm",
        author: "Bob",
        job,
        state: "delivered",
        createdAt: at(1).toISOString(),
        deliveredAt: at(2).toISOString(),
        consumedAt: at(2).toISOString(),
      },
    ]);

    // A run without requests or messages.
    const empty = (await detailPage((await newRun()).id)).run;
    expect(empty).toMatchObject({ pendingRequests: [], messages: [] });
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

    const { run: view } = await detailPage(run.id);
    expect(view.status).toBe("stopped");
    expect(view.jobs).toMatchObject([{ id: jobId, status: "running", cancelRequested: true }]);
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
    expect((await detailPage(theirs.id)).run).toMatchObject({ id: theirs.id });
    await expect(detailPage(ours.id)).rejects.toThrow("HTTP 404");
  });
});
