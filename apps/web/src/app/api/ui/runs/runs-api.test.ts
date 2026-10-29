import { randomBytes, randomUUID } from "node:crypto";
import {
  agents,
  chatConnections,
  chatThreadRuns,
  CANCELED_REVIEW_ERROR,
  connectRepository,
  closeDb,
  createWebChatThread,
  users,
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
  listRunEvents,
  threadRunOf,
  getJob,
  getMainLane,
  getRun,
  insertJob,
  insertMessage,
  integrations,
  jobs,
  listStories,
  modelPrices,
  replaceAttemptModelUsage,
  ralphRuns,
  saveChatConnection,
  saveIntegration,
  scmConnections,
  updateLane,
  updateRun,
  updateStory,
  upsertScmConnection,
  upsertStories,
  type Database,
  organizations,
  settleReviewRun,
  type LinearRun,
  type NewLinearRalphRunInput,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
  setCodingEnabled,
} from "@omniralph/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRole, type Role } from "@/lib/auth/roles";
import { PostgresDispatcher } from "@/lib/dispatch/dispatcher";
import { FakeLinearGateway, linearRun } from "@/lib/linear/fake-gateway";
import type { LinearGateway } from "@/lib/linear/gateway";
import { runListSchema, type RunList, type RunRow } from "@/lib/api/runs";
import {
  runDetailSchema,
  runFilterOptionsSchema,
  runRetryResultSchema,
  transcriptPageSchema,
  type RunDetail,
  type RunRetryResult,
} from "@/lib/api/runs";
import type * as Adapters from "@/lib/scm/adapters";
import type { ChatChannel } from "@/lib/ralph/conversation";
import { applyChatAnswer, chatThreadSink } from "@/lib/sinks/chat-thread";
import { parseSinkResult } from "@/lib/sinks";
import { createMockAdapter, createMockState } from "@chat-adapter/tests";
import type { Adapter } from "chat";
import type { QueryRunResult } from "@omniralph/shared";
import type { ChangeRequest, ChangeRequestState, ScmAdapter } from "@omniralph/scm";

vi.mock("server-only", () => ({}));

type TestUser = { id: string; role: Role; name: string | null; email: string | null; image: null };
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  user: null as TestUser | null,
  /** The user's active organization. */
  orgId: "",
  linear: undefined as unknown as LinearGateway,
  dispatcher: undefined as unknown,
  /** The code host every adapter talks to, when set. */
  scm: null as ScmAdapter | null,
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
vi.mock("@/lib/scm/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof Adapters>();
  return {
    ...actual,
    scmAdapterFor: (...args: Parameters<typeof actual.scmAdapterFor>) =>
      state.scm ?? actual.scmAdapterFor(...args),
  };
});

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const runList = await import("@/app/api/ui/runs/route");
const filterOptions = await import("@/app/api/ui/runs/filter-options/route");
const runDetail = await import("@/app/api/ui/runs/[id]/route");
const runStop = await import("@/app/api/ui/runs/[id]/stop/route");
const runRetry = await import("@/app/api/ui/runs/[id]/retry/route");
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

/** `POST /api/ui/runs/{id}/retry` with `body` as is (a string) or as JSON; no body when omitted. */
async function retryRequest(
  id: string,
  body?: unknown,
): Promise<{ status: number; body: RunRetryResult & { error?: string } }> {
  const response = await runRetry.POST(
    new Request("http://localhost/api/ui", {
      method: "POST",
      ...(body !== undefined && {
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    }),
    { params: Promise.resolve({ id }) },
  );
  return {
    status: response.status,
    body: (await response.json()) as RunRetryResult & { error?: string },
  };
}

describe.skipIf(!databaseAvailable)("/api/ui/runs", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let repoA: string;
  let repoB: string;
  let agentId: string;
  let linear: FakeLinearGateway;
  let session = 0;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
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
    await setCodingEnabled(db, repoA);
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
    await db.delete(reviewRuns);
    await db.delete(triageRuns);
    await db.delete(chatConnections);
    await db.delete(integrations);
    state.user = admin;
    state.orgId = orgId;
    linear = new FakeLinearGateway();
    state.linear = linear;
    state.dispatcher = new PostgresDispatcher({ db });
    state.scm = null;
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
    await updateRun(db, epic.id, { status: "completed", agentId });
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
      depth: "standard",
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
        depth: "standard",
        model: null,
        budget: 100_000,
      });
      await db
        .update(reviews)
        .set({ status, agentId, tokensIn: 50 + i, tokensOut: 5 })
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
      repositoryId: repoA,
      payload: {
        trigger: { kind: "chat.request", context: { question: "Where is auth handled?" } },
      },
    });
    await db
      .update(jobs)
      .set({
        status: "canceled",
        agentId,
        finishedAt: new Date(Date.UTC(2026, 9, 5, 1)),
      })
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
    const agent = { id: agentId, name: "agent-a" };

    expect(byId.get(epic.id)).toEqual({
      id: epic.id,
      kind: "epic",
      status: "completed",
      origin: "linear",
      organization,
      title: epic.linearTitle!,
      workItem: {
        id: `linear-${epic.linearIssueId}`,
        tracker: "linear",
        identifier: epic.linearIdentifier,
        url: epic.linearUrl,
      },
      repository: github,
      branch: (await getMainLane(db, epic))!.branch,
      pullRequest: { provider: "github", number: 7, url: "https://github.com/acme/api/pull/7" },
      agent,
      progress: { done: 1, total: 2, running: null },
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
      workItem: {
        id: `linear-${request.linearIssueId}`,
        tracker: "linear",
        identifier: request.linearIdentifier,
      },
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
        id: "linear-issue-triage",
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
    // The detail carries the same reference: the work item's URL ID, or null without one.
    expect((await detailPage(epic.id)).workItem).toMatchObject({
      id: `linear-${epic.linearIssueId}`,
    });
    expect((await detailPage(triage.id)).workItem).toMatchObject({ id: "linear-issue-triage" });
    expect((await detailPage(chat.id)).workItem).toBeNull();
  });

  it("links an ask run, and a request started from a chat, to the chat it came from", async () => {
    const { request, ask, chat } = await runOfEachKind();
    // Slack threads: the chat is named, with no link.
    expect((await detailPage(ask.id)).chat).toMatchObject({ platform: "slack", href: null });
    expect((await detailPage(chat.id)).chat).toMatchObject({ platform: "slack", href: null });
    // A run that didn't come from a chat.
    expect((await detailPage(request.id)).chat).toBeNull();

    // A web chat Ada started, with an ask run and a request run.
    await db
      .insert(users)
      .values([
        { id: admin.id, email: "ada@acme.test" },
        { id: member.id, email: "mo@acme.test" },
      ])
      .onConflictDoNothing();
    const web = await createWebChatThread(db, {
      organizationId: orgId,
      userId: admin.id,
      title: "Where is auth handled?",
      repositoryId: repoA,
      branch: "main",
    });
    const { job: webJob } = await insertJob(db, {
      organizationId: orgId,
      type: "chat.ask",
      taskType: "query",
      repositoryId: repoA,
      payload: {
        trigger: {
          kind: "chat.request",
          context: {
            question: `Where is auth handled?\n\n${"Explain the session flow. ".repeat(8)}`,
          },
        },
      },
    });
    const webAsk = (await mapThreadRun(db, {
      organizationId: orgId,
      chatThreadId: web.id,
      jobId: webJob.id,
    }))!;
    const { run: webRequest } = await createRun(db, {
      origin: "chat",
      organizationId: orgId,
      chatThreadId: web.id,
      repositoryId: repoA,
      branch: "omniralph/auth",
      baseBranch: "main",
    });

    const own = { threadId: web.id, platform: "web", href: `/ask/${web.id}` };
    const askDetail = await detailPage(webAsk.id);
    expect(askDetail.chat).toEqual(own);
    expect((await detailPage(webRequest.id)).chat).toEqual(own);
    // Its title is the question, on one line of at most 120 characters.
    expect(askDetail.title).toHaveLength(120);
    expect(askDetail.title).toMatch(/^Where is auth handled\? Explain the session flow\. /);
    expect(askDetail.title).not.toMatch(/\n/);
    expect(askDetail.title.endsWith("…")).toBe(true);

    // Another member sees the runs, and that they came from a web chat, with no link.
    state.user = member;
    const other = { threadId: web.id, platform: "web", href: null };
    expect((await detailPage(webAsk.id)).chat).toEqual(other);
    expect((await detailPage(webRequest.id)).chat).toEqual(other);
  });

  it("offers the organization's repositories as filter options, by full path", async () => {
    const zeta = (await upsertScmConnection(db, {
      organizationId: orgId,
      provider: "github",
      name: "zeta",
      baseUrl: "https://api.github.com",
      externalId: "zeta",
      credentials: {},
    }))!;
    const early = await connectRepository(db, {
      connectionId: zeta.id,
      provider: "github",
      externalId: "zeta-1",
      fullPath: "aardvark/tools",
    });
    try {
      const expected = {
        repositories: [
          { id: early.id, provider: "github", fullPath: "aardvark/tools" },
          { id: repoA, provider: "github", fullPath: "acme/api" },
          { id: repoB, provider: "gitlab", fullPath: "acme/web" },
        ].map((repo) => ({ ...repo, organization: { id: orgId, name: "Acme", role: "admin" } })),
      };
      for (const search of [{}, { organization: orgId }] as Record<string, string>[]) {
        const { status, body } = await call(filterOptions.GET, { search });
        expect(status).toBe(200);
        expect(runFilterOptionsSchema.parse(body)).toEqual(expected);
      }
      expect((await call(filterOptions.GET, { search: { organization: "acme" } })).status).toBe(
        400,
      );
    } finally {
      await db.delete(scmConnections).where(eq(scmConnections.id, zeta.id));
    }
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
    expect(ids(await listPage({ repository: [repoA, repoB], kind: ["review", "epic"] }))).toEqual([
      reviewRun.id,
      epic.id,
    ]);
    expect(ids(await listPage({ repository: repoA, kind: "request" }))).toEqual([
      chat.id,
      request.id,
    ]);
    expect(ids(await listPage({ origin: "chat" }))).toEqual([chat.id, ask.id]);
    expect(ids(await listPage({ origin: ["linear", "pr_mention"] }))).toEqual([
      reviewRun.id,
      epic.id,
    ]);
    expect(ids(await listPage({ agent: agentId }))).toEqual([ask.id, reviewRun.id, epic.id]);
    expect(ids(await listPage({ agent: agentId, origin: "chat", status: "stopped" }))).toEqual([
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
      { repository: [repoA, "not-a-uuid"] },
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
    const { triage, reviewRun, ask } = await runOfEachKind();
    for (const id of [triage.id, reviewRun.id, ask.id]) {
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
    input: Omit<Parameters<typeof insertJob>[1], "organizationId" | "taskType"> & {
      taskType?: "coding" | "query" | "review";
    },
    finish: Partial<typeof jobs.$inferInsert> = {},
  ) {
    const taskType = input.taskType ?? "coding";
    const { job } = await insertJob(db, {
      organizationId: orgId,
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
      agentId,
    });

    const builtJob = await attempt(
      { type: "ralph.story", ralphRunId: run.id, ralphStoryId: built!.id },
      {
        status: "completed",
        agentId,
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
        agentId,
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
      // The work item's URL ID, for the run ⋯ menu's View PRD.
      workItem: {
        id: `linear-${run.linearIssueId}`,
        tracker: "linear",
        identifier: run.linearIdentifier,
      },
      organization: { id: orgId, name: "Acme", role: "admin" },
      progress: { done: 1, total: 4, running: null },
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
      agent: { id: agentId, name: "agent-a" },
      deliveries: 1,
      cancelRequested: false,
      createdAt: at(9).toISOString(),
      startedAt: at(9).toISOString(),
      finishedAt: at(9, 30).toISOString(),
      tokens: { in: 100, out: 10 },
      // Its result has no usage per model (as before agents reported it): unpriced.
      costUsd: null,
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
      agent: { id: agentId, name: "agent-a" },
      tokens: { in: 100, out: 10 },
      costUsd: null,
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
      question: null,
      actions: {
        // A failed run doesn't stop.
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
    // A running one can be stopped (by any member), and retries nothing.
    await updateRun(db, run.id, { status: "running" });
    expect((await detailPage(run.id)).details.actions).toEqual({
      stop: true,
      retry: { run: false, storyIds: [], attemptIds: [] },
    });
    state.user = member;
    state.orgId = orgId;
    expect((await detailPage(run.id)).details.actions.stop).toBe(true);
  });

  it("prices each attempt, and the run when every token-bearing attempt is priced", async () => {
    const run = await newRun({ mode: "request", kind: "single" });
    const byModel = (model: string, canonicalModel: string | null) => [
      {
        model,
        canonicalModel,
        inputTokens: 1_000_000,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheWrite1hInputTokens: 0,
        outputTokens: 100_000,
        largestRequestInputTokens: 1_000_000,
        fastMode: false,
      },
    ];
    const finished = async (usage: Record<string, unknown> | null, hour: number) => {
      const job = await attempt(
        { type: "ralph.request", ralphRunId: run.id },
        {
          status: "completed",
          createdAt: at(hour),
          startedAt: at(hour),
          finishedAt: at(hour, 5),
          result: usage ? { usage } : {},
        },
      );
      await replaceAttemptModelUsage(db, job.id, usage ? { usage } : null);
      return job;
    };
    const tokens = { inputTokens: 1_000_000, outputTokens: 100_000 };
    const priced = await finished(
      { ...tokens, byModel: byModel("claude-opus-5-5", "claude-opus-5-5") },
      9,
    );
    const tiny = await finished(
      {
        ...tokens,
        byModel: [
          { ...byModel("claude-opus-5-5", "claude-opus-5-5")[0]!, inputTokens: 1, outputTokens: 0 },
        ],
      },
      10,
    );
    // No tokens (e.g. a request answered without a session): it doesn't hold the run's figure up.
    await finished(null, 11);
    await db.insert(modelPrices).values({
      modelId: "anthropic/claude-opus-5.5",
      name: "Claude Opus 5.5",
      inputUsd: "0.000004",
      outputUsd: "0.00002",
      cacheReadUsd: "0.0000002",
      cacheWriteUsd: "0.000005",
      validFrom: new Date("2026-01-01T00:00:00Z"),
      checkedAt: new Date(),
    });
    try {
      const view = await detailPage(run.id);
      const costOf = (id: string) => view.attempts.find((a) => a.id === id)!.costUsd;
      expect(costOf(priced.id)).toBeCloseTo(6, 10);
      expect(costOf(tiny.id)).toBeCloseTo(0.000004, 10);
      expect(view.details.costUsd).toBeCloseTo(6.000004, 6);

      // One token-bearing attempt the agent reported only an alias for: no run figure.
      const alias = await finished({ ...tokens, byModel: byModel("opus", null) }, 12);
      const partial = await detailPage(run.id);
      expect(partial.attempts.find((a) => a.id === alias.id)!.costUsd).toBeNull();
      expect(partial.attempts.find((a) => a.id === priced.id)!.costUsd).toBeCloseTo(6, 10);
      expect(partial.details.costUsd).toBeNull();
    } finally {
      await db.delete(modelPrices);
    }
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

  it("says why a waiting, stopped or failed run is where it is, as its Inbox item does", async () => {
    const waiting = await newRun();
    await updateRun(db, waiting.id, {
      status: "waiting",
      waitingOn: { blockers: [{ id: "b-1", identifier: "OPS-3", title: "Infra" }], manual: [] },
    });
    expect((await detailPage(waiting.id)).reason).toBe(
      "Waiting on OPS-3, which is outside the epic.",
    );

    const stopped = await newRun();
    await updateRun(db, stopped.id, { status: "stopped", error: "Stopped by Ada Admin." });
    expect((await detailPage(stopped.id)).reason).toBe(
      "The epic was stopped. Stopped by Ada Admin.",
    );

    const failed = await newRun({ mode: "request", kind: "single" });
    await updateRun(db, failed.id, {
      status: "failed",
      error: "The agent ran out of turns.\nmore",
    });
    expect((await detailPage(failed.id)).reason).toBe(
      "The run failed. The agent ran out of turns. more",
    );

    await updateRun(db, failed.id, { status: "running", error: null });
    expect((await detailPage(failed.id)).reason).toBeNull();
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
        label: `Worked on ${run.linearIdentifier}`,
        status: "completed",
        durationMs: 120_000,
      },
      {
        kind: "attempt",
        id: second.id,
        label: `Stopped working on ${run.linearIdentifier}`,
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
          { status: pass === security ? "completed" : "failed", agentId },
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

  it("matches a legacy review.run job to its pass by the payload's top-level review ID", async () => {
    // As migration 0084 made them: the review's run has the review's own ID.
    const review = await createReview(db, {
      repositoryId: repoA,
      prNumber: 12,
      prTitle: "Old change",
      headSha: "e".repeat(40),
      baseSha: "b".repeat(40),
      trigger: "webhook",
      depth: "standard",
      model: null,
      budget: 100_000,
    });
    await db.insert(reviewRuns).values({
      id: review.id,
      organizationId: orgId,
      repositoryId: repoA,
      prNumber: 12,
      headSha: "e".repeat(40),
      baseSha: "b".repeat(40),
      trigger: "webhook",
      mode: "fresh",
      depth: "standard",
      status: "completed",
    });
    await db
      .update(reviews)
      .set({ reviewRunId: review.id, status: "completed" })
      .where(eq(reviews.id, review.id));
    const job = await attempt(
      {
        type: "review.run",
        taskType: "review",
        reviewRunId: review.id,
        repositoryId: repoA,
        payload: { reviewId: review.id },
      },
      { status: "completed", finishedAt: at(10) },
    );

    const view = await detailPage(review.id);
    expect(view).toMatchObject({ id: review.id, kind: "review", status: "completed" });
    expect(view.steps).toMatchObject([{ kind: "review_pass", id: review.id, taskName: "Review" }]);
    expect(view.attempts.map((a) => [a.id, a.type, a.step])).toEqual([
      [job.id, "review.run", review.id],
    ]);
    // A legacy pass has no task to name.
    expect(view.attempts[0]!.label).toBe("Reviewed pull request #12 in api");
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
      { status: "running", agentId, startedAt: at(9), createdAt: at(9) },
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
      steps: [{ kind: "attempt", id: askJob!.id, label: "Stopped answering a question about api" }],
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

  it("counts a running epic's progress by the running story's place", async () => {
    const run = await newRun();
    const stories = await upsertStories(db, run.id, [
      { linearIssueId: "p-1", identifier: "ENG-51", title: "One" },
      { linearIssueId: "p-2", identifier: "ENG-52", title: "Two" },
      { linearIssueId: "p-3", identifier: "ENG-53", title: "Three" },
      { linearIssueId: "p-4", identifier: "ENG-54", title: "Four" },
    ]);
    // Story 2 runs while 1 is built and 4 was canceled: two done, yet story 2 (not 3).
    await updateStory(db, stories[0]!.id, { status: "completed" });
    await updateStory(db, stories[1]!.id, { status: "running" });
    await updateStory(db, stories[3]!.id, { status: "canceled" });
    await updateRun(db, run.id, { status: "running" });

    const progress = { done: 2, total: 4, running: 2 };
    expect((await detailPage(run.id)).progress).toEqual(progress);
    expect((await listPage()).runs.find((row) => row.id === run.id)?.progress).toEqual(progress);

    // Between stories nothing runs.
    await updateStory(db, stories[1]!.id, { status: "completed" });
    expect((await detailPage(run.id)).progress).toEqual({ done: 3, total: 4, running: null });
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

  it("stops a run whose job is running: the job shows its cancel request until its agent confirms", async () => {
    const { run, jobId } = await runningRun();
    await db.update(jobs).set({ status: "running", agentId }).where(eq(jobs.id, jobId));
    expect(await stopRalphRun(run.id)).toEqual({ ok: true });

    const view = await detailPage(run.id);
    expect(view.status).toBe("stopped");
    expect(view.attempts).toMatchObject([{ id: jobId, status: "running", cancelRequested: true }]);
  });

  it("lets members stop a run, but not a signed-out user", async () => {
    const { run, jobId } = await runningRun();
    state.user = null;
    expect((await stopRalphRun(run.id)).ok).toBe(false);
    expect((await getRun(db, run.id))!.status).toBe("running");
    expect(linear.bodies(run.linearAgentSessionId, "response")).toEqual([]);

    state.user = { ...member, name: "Mo Member" };
    expect(await stopRalphRun(run.id)).toEqual({ ok: true });
    expect((await getRun(db, run.id))!.status).toBe("stopped");
    expect((await getJob(db, jobId))!.status).toBe("canceled");
    expect(linear.bodies(run.linearAgentSessionId, "response")[0]).toContain(
      "Stopped (requested by Mo Member).",
    );
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

  describe("retry", () => {
    /** A stopped epic of two Linear stories (ENG-41 built, ENG-42 not). */
    async function stoppedEpic() {
      const epic = linear.add({ identifier: "ENG-40", title: "Epic", description: "Build it." });
      const built = linear.add({ identifier: "ENG-41", title: "Built", parentId: epic.id });
      const open = linear.add({ identifier: "ENG-42", title: "Open", parentId: epic.id });
      await linear.setIssueState(built.id, { type: "completed" });
      const run = await newRun({
        linearIssueId: epic.id,
        linearIdentifier: "ENG-40",
        linearUrl: "https://linear.app/acme/issue/ENG-40/epic",
      });
      const [builtRow, openRow] = await upsertStories(db, run.id, [
        { linearIssueId: built.id, identifier: "ENG-41", title: "Built" },
        { linearIssueId: open.id, identifier: "ENG-42", title: "Open" },
      ]);
      await updateStory(db, builtRow!.id, {
        status: "completed",
        attempts: 1,
        commitSha: "1".repeat(40),
      });
      await updateStory(db, openRow!.id, { status: "exhausted", attempts: 3 });
      await updateRun(db, run.id, { status: "stopped", iterations: 9 });
      return { run, built: builtRow!, open: openRow!, openIssue: open };
    }

    const queuedStoryJobs = (runId: string) =>
      db
        .select()
        .from(jobs)
        .where(sql`${jobs.ralphRunId} = ${runId} and ${jobs.status} = 'queued'`);

    it("lets a member retry a stopped epic: it resumes and the session says who retried it", async () => {
      const { run, open } = await stoppedEpic();
      state.user = { ...member, name: "Mo Member" };
      const { status, body } = await retryRequest(run.id);
      expect(status).toBe(200);
      const view = runDetailSchema.parse(body);
      expect(view).toMatchObject({ id: run.id, status: "running" });
      expect(await getRun(db, run.id)).toMatchObject({ status: "running", iterations: 1 });
      const [job, ...more] = await queuedStoryJobs(run.id);
      expect(more).toEqual([]);
      expect(job).toMatchObject({ type: "ralph.story", ralphStoryId: open.id });
      expect(linear.bodies(run.linearAgentSessionId, "thought")).toContain(
        "Retried from Omniralph by Mo Member.",
      );
      expect((await listStories(db, run.id)).find((s) => s.id === open.id)).toMatchObject({
        status: "running",
        attempts: 0,
      });
    });

    it("retries one story, and an attempt of a story, by focusing it", async () => {
      const { run, open, openIssue } = await stoppedEpic();
      expect(
        await retryRequest(run.id, { target: { kind: "story", storyId: open.id } }),
      ).toMatchObject({ status: 200, body: { status: "running" } });
      expect(await getRun(db, run.id)).toMatchObject({ focusStoryId: openIssue.id });
      expect(linear.bodies(run.linearAgentSessionId, "thought")).toContain(
        "Retried **ENG-42** from Omniralph by Ada Admin.",
      );

      // Its attempt fails, is canceled or expires; retrying that attempt retries the story.
      for (const status of ["failed", "canceled", "expired"] as const) {
        const [job] = await queuedStoryJobs(run.id);
        await db.update(jobs).set({ status, finishedAt: new Date() }).where(eq(jobs.id, job!.id));
        await updateStory(db, open.id, { status: "exhausted", attempts: 3 });
        await updateRun(db, run.id, { status: "stopped" });
        expect((await detailPage(run.id)).details.actions.retry).toMatchObject({
          storyIds: expect.arrayContaining([open.id]),
          attemptIds: [job!.id],
        });
        expect(
          await retryRequest(run.id, { target: { kind: "attempt", attemptId: job!.id } }),
        ).toMatchObject({ status: 200, body: { status: "running", warning: null } });
        const [again, ...more] = await queuedStoryJobs(run.id);
        expect(more).toEqual([]);
        expect(again).toMatchObject({ type: "ralph.story", ralphStoryId: open.id });
        expect(again!.id).not.toBe(job!.id);
        // The story starts over.
        expect((await listStories(db, run.id)).find((s) => s.id === open.id)).toMatchObject({
          status: "running",
          attempts: 0,
        });
      }
    });

    it("refuses a completed or skipped run or attempt (400)", async () => {
      const { run, built, open } = await stoppedEpic();
      const attempt = (status: "completed" | "skipped") =>
        insertJob(db, {
          organizationId: orgId,
          type: "ralph.story",
          taskType: "coding",
          ralphRunId: run.id,
          ralphStoryId: status === "completed" ? built.id : open.id,
          payload: {},
        }).then(async ({ job }) => {
          await db.update(jobs).set({ status, finishedAt: new Date() }).where(eq(jobs.id, job.id));
          return job;
        });
      const completed = await attempt("completed");
      const skipped = await attempt("skipped");
      for (const job of [completed, skipped]) {
        expect(
          await retryRequest(run.id, { target: { kind: "attempt", attemptId: job.id } }),
        ).toMatchObject({
          status: 400,
          body: {
            error:
              "Only the latest attempt of a step that failed, was canceled or expired can be retried.",
          },
        });
      }
      // A skipped review run, and its skipped pass.
      const review = await createReviewRun(db, {
        organizationId: orgId,
        repositoryId: repoA,
        prNumber: 4,
        headSha: "d".repeat(40),
        baseSha: "b".repeat(40),
        trigger: "webhook",
        mode: "fresh",
        depth: "standard",
      });
      const { job: pass } = await insertJob(db, {
        organizationId: orgId,
        type: "review.task",
        taskType: "review",
        repositoryId: repoA,
        reviewRunId: review.id,
        payload: {},
      });
      await db
        .update(jobs)
        .set({ status: "skipped", finishedAt: new Date() })
        .where(eq(jobs.id, pass.id));
      await db.update(reviewRuns).set({ status: "skipped" }).where(eq(reviewRuns.id, review.id));
      expect(await retryRequest(review.id)).toMatchObject({
        status: 400,
        body: { error: "This run is skipped, so there's nothing to retry." },
      });
      expect(
        await retryRequest(review.id, { target: { kind: "attempt", attemptId: pass.id } }),
      ).toMatchObject({ status: 400 });
      expect(await queuedStoryJobs(run.id)).toEqual([]);
      expect((await getRun(db, run.id))!.status).toBe("stopped");
    });

    it("re-runs a completed story of a finished epic, but not the finished epic as a whole", async () => {
      const { run, built } = await stoppedEpic();
      await updateStory(db, (await listStories(db, run.id))[1]!.id, { status: "completed" });
      await updateRun(db, run.id, { status: "completed" });
      expect(await retryRequest(run.id, { target: { kind: "run" } })).toMatchObject({
        status: 400,
        body: { error: "This epic is finished: re-run one of its stories instead." },
      });
      expect(
        await retryRequest(run.id, { target: { kind: "story", storyId: built.id } }),
      ).toMatchObject({ status: 200, body: { status: "running" } });
      const [job] = await queuedStoryJobs(run.id);
      expect(job).toMatchObject({ type: "ralph.story", ralphStoryId: built.id });
    });

    it("refuses a story whose pull request is merged or closed", async () => {
      const { run, open } = await stoppedEpic();
      const lane = (await getMainLane(db, run))!;
      await updateLane(db, lane.id, {
        prNumber: 5,
        prUrl: "https://github.com/acme/api/pull/5",
        prMerged: true,
        prClosed: true,
      });
      expect(
        await retryRequest(run.id, { target: { kind: "story", storyId: open.id } }),
      ).toMatchObject({
        status: 400,
        body: { error: "The pull request for this story is already merged." },
      });
      await updateLane(db, lane.id, { prMerged: false });
      expect(
        await retryRequest(run.id, { target: { kind: "story", storyId: open.id } }),
      ).toMatchObject({
        status: 400,
        body: { error: "The pull request for this story is already closed." },
      });
      expect((await getRun(db, run.id))!.status).toBe("stopped");
      expect(await queuedStoryJobs(run.id)).toEqual([]);
    });

    it("answers 409 while Om works on the run", async () => {
      const { run } = await runningRun();
      expect(await retryRequest(run.id)).toMatchObject({
        status: 409,
        body: { error: "Om is already working on this run." },
      });
      // A stopped run whose canceled job hasn't confirmed yet is still busy.
      await updateRun(db, run.id, { status: "stopped" });
      expect((await retryRequest(run.id)).status).toBe(409);
    });

    it("retries a request run whose request attempt failed", async () => {
      const issue = linear.add({ identifier: "ENG-50", title: "A request" });
      const run = await newRun({
        mode: "request",
        kind: "single",
        linearIssueId: issue.id,
        linearIdentifier: "ENG-50",
      });
      const message = await insertMessage(db, {
        runId: run.id,
        kind: "request",
        text: "Fix the README typo.",
      });
      const { job } = await insertJob(db, {
        organizationId: orgId,
        type: "ralph.request",
        taskType: "coding",
        taskId: "builtin:handle-request",
        ralphRunId: run.id,
        // A coding run's payload: the request is its trigger context.
        payload: {
          trigger: {
            kind: "linear.mention",
            context: { requests: [{ id: message.id, text: message.text }] },
          },
        },
      });
      await db
        .update(jobs)
        .set({ status: "failed", finishedAt: new Date(), error: "Crashed." })
        .where(eq(jobs.id, job.id));
      await db.execute(sql`update ralph_messages set consumed_at = now() where id = ${message.id}`);
      await updateRun(db, run.id, { status: "completed" });
      expect((await detailPage(run.id)).details.actions.retry.run).toBe(true);

      expect(await retryRequest(run.id)).toMatchObject({ status: 200 });
      const [again] = await queuedStoryJobs(run.id);
      expect(again).toMatchObject({ type: "ralph.request" });
      expect(JSON.stringify(again!.payload)).toContain("Fix the README typo.");
    });

    it("validates the target and the run kind", async () => {
      const { run } = await stoppedEpic();
      expect(await retryRequest(run.id, "{")).toMatchObject({ status: 400 });
      expect(await retryRequest(run.id, { target: { kind: "lane" } })).toMatchObject({
        status: 400,
      });
      expect(
        await retryRequest(run.id, { target: { kind: "story", storyId: randomUUID() } }),
      ).toMatchObject({ status: 404, body: { error: "That story doesn't exist." } });
      expect(
        await retryRequest(run.id, { target: { kind: "attempt", attemptId: randomUUID() } }),
      ).toMatchObject({ status: 404, body: { error: "That attempt doesn't exist." } });
      expect(await retryRequest(randomUUID())).toMatchObject({
        status: 404,
        body: { error: "That run doesn't exist." },
      });
      expect((await retryRequest("nope")).status).toBe(404);
      state.user = null;
      expect((await retryRequest(run.id)).status).toBe(401);
    });
  });

  describe("retry of reviews, triage and asks", () => {
    const HEAD = "c".repeat(40);

    /** A code host whose PR/MRs are in `pr.state` at `pr.headSha`. */
    function fakeScm() {
      const pr = { state: "open" as ChangeRequestState, headSha: HEAD };
      state.scm = {
        provider: "github",
        async getChangeRequest(_repo: unknown, number: number): Promise<ChangeRequest> {
          return {
            number,
            title: "Add login",
            description: "Please review",
            author: "octocat",
            draft: false,
            state: pr.state,
            baseSha: "b".repeat(40),
            headSha: pr.headSha,
            baseRef: "main",
            headRef: "feature",
            url: `https://github.com/acme/api/pull/${number}`,
          };
        },
        getDefaultBranch: async () => "main",
      } as unknown as ScmAdapter;
      return pr;
    }

    /**
     * A fresh review run of acme/api#9 whose one pass's job ended `status`, settled as the review
     * sink leaves it: a failed or expired job fails its review, a canceled one skips it as
     * canceled; either way the run fails.
     */
    async function endedReview(status: "failed" | "canceled" | "expired" = "failed") {
      const run = await createReviewRun(db, {
        organizationId: orgId,
        repositoryId: repoA,
        prNumber: 9,
        headSha: "a".repeat(40),
        baseSha: "b".repeat(40),
        trigger: "webhook",
        mode: "fresh",
        depth: "deep",
      });
      const review = await createReview(db, {
        reviewRunId: run.id,
        repositoryId: repoA,
        prNumber: 9,
        prTitle: "Add login",
        headSha: "a".repeat(40),
        baseSha: "b".repeat(40),
        trigger: "webhook",
        depth: "deep",
        model: null,
        budget: 100_000,
      });
      const { job } = await insertJob(db, {
        organizationId: orgId,
        type: "review.task",
        taskType: "review",
        repositoryId: repoA,
        reviewRunId: run.id,
        payload: { trigger: { kind: "pr.opened", context: { reviewId: review.id } } },
      });
      await db
        .update(jobs)
        .set({ status, finishedAt: new Date(), error: status === "failed" ? "Crashed." : null })
        .where(eq(jobs.id, job.id));
      await db
        .update(reviews)
        .set(
          status === "canceled"
            ? { status: "skipped", error: CANCELED_REVIEW_ERROR }
            : { status: "failed", error: "Crashed." },
        )
        .where(eq(reviews.id, review.id));
      expect(await settleReviewRun(db, run.id)).toBe("failed");
      return { run, review, job };
    }

    /** The jobs queued for review run `reviewRunId`. */
    const queuedReviewJobs = (reviewRunId: string) =>
      db
        .select()
        .from(jobs)
        .where(sql`${jobs.reviewRunId} = ${reviewRunId} and ${jobs.status} = 'queued'`);

    it.each(["failed", "canceled", "expired"] as const)(
      "re-runs a review whose pass %s on the PR's current head with the run's mode and profile",
      async (status) => {
        fakeScm();
        const { run, job } = await endedReview(status);
        state.user = member;
        const before = await detailPage(run.id);
        expect(before.status).toBe("failed");
        expect(before.details.actions.retry).toMatchObject({ run: true, attemptIds: [job.id] });

        const { status: code, body } = await retryRequest(run.id);
        expect(code).toBe(200);
        const view = runRetryResultSchema.parse(body);
        // The retry is a new review run of the current head, which the answer shows.
        expect(view).toMatchObject({
          kind: "review",
          status: "queued",
          origin: "manual",
          warning: null,
        });
        expect(view.id).not.toBe(run.id);
        const [retried] = await db.select().from(reviewRuns).where(eq(reviewRuns.id, view.id));
        expect(retried).toMatchObject({
          headSha: HEAD,
          mode: "fresh",
          depth: "deep",
          prNumber: 9,
        });
        const queued = await queuedReviewJobs(view.id);
        expect(queued.map((j) => j.type)).toEqual(["review.task"]);

        // Its pass retries the run too; while the new run is queued, the head is busy: the
        // answer is that run, with a warning, and nothing new is queued.
        const again = await retryRequest(run.id, {
          target: { kind: "attempt", attemptId: job.id },
        });
        expect(again.status).toBe(200);
        expect(runRetryResultSchema.parse(again.body)).toMatchObject({
          id: view.id,
          kind: "review",
          status: "queued",
          warning: `A review of ${HEAD.slice(0, 12)} is already queued or running.`,
        });
        expect(await queuedReviewJobs(view.id)).toHaveLength(1);
        expect(await db.select().from(reviewRuns)).toHaveLength(2);
      },
    );

    it("re-runs a review from its failed pass, as an attempt target", async () => {
      fakeScm();
      const { run, job } = await endedReview("expired");
      const { status, body } = await retryRequest(run.id, {
        target: { kind: "attempt", attemptId: job.id },
      });
      expect(status).toBe(200);
      const view = runRetryResultSchema.parse(body);
      expect(view).toMatchObject({ kind: "review", status: "queued", warning: null });
      expect(view.id).not.toBe(run.id);
      expect((await queuedReviewJobs(view.id)).map((j) => j.type)).toEqual(["review.task"]);
    });

    it("refuses a review of a merged pull request, and a review that didn't fail", async () => {
      const pr = fakeScm();
      const { run } = await endedReview();
      pr.state = "merged";
      expect(await retryRequest(run.id)).toMatchObject({
        status: 400,
        body: { error: "This change request is merged, so it can't be reviewed again." },
      });
      await db.update(reviewRuns).set({ status: "completed" }).where(eq(reviewRuns.id, run.id));
      expect(await retryRequest(run.id)).toMatchObject({
        status: 400,
        body: { error: "This run is completed, so there's nothing to retry." },
      });
      expect(
        await retryRequest(run.id, { target: { kind: "story", storyId: randomUUID() } }),
      ).toMatchObject({ status: 400, body: { error: "Only an epic's stories can be retried." } });
    });

    /** A triage run of a Backlog issue whose attempt (given `reply`) ended `status`. */
    async function endedTriage(status: "failed" | "canceled" | "expired") {
      const issue = linear.add({ identifier: "ENG-70", title: "Shape it", description: "Rough." });
      await linear.setIssueState(issue.id, { type: "backlog" });
      session += 1;
      const { run } = await createTriageRun(db, {
        organizationId: orgId,
        linearIssueId: issue.id,
        linearAgentSessionId: `triage-session-${session}`,
        trigger: "mention",
      });
      const { job } = await insertJob(db, {
        organizationId: orgId,
        type: "triage.run",
        taskType: "query",
        triageRunId: run.id,
        payload: {
          trigger: {
            kind: "linear.triage",
            context: {
              triageRunId: run.id,
              reply: "Owners only.",
              issue: { identifier: "ENG-70" },
            },
          },
        },
      });
      await db.update(jobs).set({ status, finishedAt: new Date() }).where(eq(jobs.id, job.id));
      await db
        .update(triageRuns)
        .set({ status: status === "canceled" ? "stopped" : "failed", currentJobId: job.id })
        .where(eq(triageRuns.id, run.id));
      return { run, job, issue };
    }

    it("retries a triage run whose attempt failed, was canceled or expired, with a new attempt", async () => {
      for (const status of ["failed", "canceled", "expired"] as const) {
        await db.delete(triageRuns);
        await db.delete(jobs);
        const { run, job } = await endedTriage(status);
        state.user = { ...member, name: "Mo Member" };
        const target =
          status === "expired" ? { target: { kind: "attempt", attemptId: job.id } } : undefined;
        const { status: code, body } = await retryRequest(run.id, target);
        expect(code).toBe(200);
        expect(runDetailSchema.parse(body)).toMatchObject({ id: run.id, status: "queued" });
        const [again, ...more] = await db
          .select()
          .from(jobs)
          .where(sql`${jobs.triageRunId} = ${run.id} and ${jobs.status} = 'queued'`);
        expect(more).toEqual([]);
        expect(again).toMatchObject({ type: "triage.run" });
        // The attempt gives the retried attempt's reply again.
        expect(JSON.stringify(again!.payload)).toContain("Owners only.");
        const [row] = await db.select().from(triageRuns).where(eq(triageRuns.id, run.id));
        expect(row).toMatchObject({ status: "queued", currentJobId: again!.id });
        expect(linear.bodies(run.linearAgentSessionId, "thought")).toContain(
          "Retried from Omniralph by Mo Member.",
        );
        // Now busy.
        expect(await retryRequest(run.id)).toMatchObject({
          status: 409,
          body: { error: "Om is already working on this run." },
        });
      }
    });

    it("refuses a triage whose issue is in progress, and ends the run as triage would", async () => {
      const { run, issue } = await endedTriage("failed");
      await linear.setIssueState(issue.id, { type: "started" });
      expect(await retryRequest(run.id)).toMatchObject({
        status: 400,
        body: {
          error:
            "Triage only rewrites work items whose work hasn't started, and ENG-70 is already in progress or done.",
        },
      });
      const [row] = await db.select().from(triageRuns).where(eq(triageRuns.id, run.id));
      expect(row!.status).toBe("stopped");
    });

    /** An ask from Slack about acme/api whose attempt ended `status`. */
    async function endedAsk(status: "failed" | "canceled" | "expired") {
      const thread = await slackThread(`slack:C0123:${randomUUID()}`);
      const { job } = await insertJob(db, {
        organizationId: orgId,
        type: "chat.ask",
        taskType: "query",
        repositoryId: repoA,
        dedupeKey: `chat.ask:${thread.id}:q`,
        // As `enqueueChatAsk` stores it (`ChatThreadContext`).
        payload: {
          trigger: {
            kind: "chat.request",
            context: {
              repository: "acme/api",
              branch: "main",
              provider: "github",
              question: "Where is auth handled?",
              chatThreadId: thread.id,
              chat: { context: null },
              budgetTokens: 12_000,
            },
          },
          repositoryId: repoA,
          ref: "main",
          requireCheckout: true,
        },
      });
      await db.update(jobs).set({ status, finishedAt: new Date() }).where(eq(jobs.id, job.id));
      const ask = (await mapThreadRun(db, {
        organizationId: orgId,
        chatThreadId: thread.id,
        jobId: job.id,
      }))!;
      return { ask, job, thread };
    }

    /** The chat bot the `chat-thread` sink records answers with (nothing is posted). */
    const chatChannel = (): ChatChannel => ({
      db,
      adapters: { slack: createMockAdapter("slack") as Adapter },
      state: createMockState(),
      appUrl: "https://omniralph.example.com",
    });

    it("retries an ask with a copy of its last attempt, relayed to the same thread", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      for (const status of ["failed", "canceled", "expired"] as const) {
        const { ask, job, thread } = await endedAsk(status);
        state.user = member;
        expect((await detailPage(ask.id)).status).toBe(
          status === "canceled" ? "stopped" : "failed",
        );
        const { status: code, body } = await retryRequest(ask.id);
        expect(code).toBe(200);
        const view = runDetailSchema.parse(body);
        expect(view).toMatchObject({ id: ask.id, kind: "ask", status: "queued" });
        expect(view.attempts.map((a) => a.status)).toEqual(["queued", status]);
        const copy = view.attempts[0]!;
        expect(await getJob(db, copy.id)).toMatchObject({
          type: "chat.ask",
          chatThreadRunId: ask.id,
          repositoryId: repoA,
          payload: job.payload,
        });
        // The thread's run now points at the copy, so its answer reaches the thread.
        const [mapped] = await db
          .select()
          .from(chatThreadRuns)
          .where(eq(chatThreadRuns.id, ask.id));
        expect(mapped!.jobId).toBe(copy.id);
        expect(await threadRunOf(db, orgId, { jobId: copy.id })).toMatchObject({
          id: ask.id,
          chatThreadId: thread.id,
        });
        expect(await retryRequest(ask.id)).toMatchObject({ status: 409 });

        // The copy's answer goes the way an agent's result does (the `chat-thread` sink): it is
        // recorded for the original thread, as the ask's event.
        const answer: QueryRunResult = {
          outcome: "answered",
          structured: null,
          answer: "Auth is handled in `src/auth.ts`.",
          references: [],
          usage: { inputTokens: 10, outputTokens: 5 },
          durationMs: 5,
        };
        await db
          .update(jobs)
          .set({ status: "completed", finishedAt: new Date(), result: answer })
          .where(eq(jobs.id, copy.id));
        const completed = (await getJob(db, copy.id))!;
        expect(
          await applyChatAnswer(
            db,
            completed,
            parseSinkResult(chatThreadSink, completed.result)!,
            chatChannel(),
          ),
        ).toBe(true);
        const events = await listRunEvents(db, orgId, thread.id);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          kind: "response",
          chatThreadId: thread.id,
          threadRunId: ask.id,
          idempotencyKey: `chat-run-event:job:${copy.id}:response`,
          body: { outcome: "answered", text: "Auth is handled in `src/auth.ts`." },
        });
        expect((await detailPage(ask.id)).status).toBe("completed");
      }
    });
  });

  it("keeps another organization's runs out: not listed, 404 and can't be stopped", async () => {
    // Another organization with its own repository, Linear workspace and run.
    const [other] = await db.insert(organizations).values({ name: "Other" }).returning();
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
    await setCodingEnabled(db, otherRepo);
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
