import { randomBytes, randomUUID } from "node:crypto";
import {
  chatConnections,
  closeDb,
  connectRepository,
  ensureChatThread,
  saveChatConnection,
  createDb,
  createRun,
  createRunPermissionRequest,
  createTriageRun,
  DEFAULT_RALPH_SETTINGS,
  getMainLane,
  getRun,
  getRunPermissionRequest,
  harnesses,
  insertJob,
  jobs,
  organizations,
  ralphRuns,
  seedReviewProfiles,
  triageRuns,
  updateLane,
  updateRepositoryRalphSettings,
  updateRun,
  upsertScmConnection,
  type Database,
  type NewLinearRalphRunInput,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import type { ScmAdapter } from "@omniralph/scm";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runDetailSchema, type RunDetail, type RunQuestion } from "@/lib/api/runs";
import { inboxItemSchema } from "@/lib/api/inbox";
import { assertRole, type Role } from "@/lib/auth/roles";
import { PostgresDispatcher } from "@/lib/dispatch/dispatcher";
import { FakeLinearGateway, linearRun } from "@/lib/linear/fake-gateway";
import type { LinearGateway } from "@/lib/linear/gateway";
import type * as Adapters from "@/lib/scm/adapters";

vi.mock("server-only", () => ({}));

type TestUser = { id: string; role: Role; name: string | null; email: string | null; image: null };
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  user: null as TestUser | null,
  orgId: "",
  linear: undefined as unknown as LinearGateway,
  dispatcher: undefined as unknown,
  scm: null as ScmAdapter | null,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") =>
    assertRole(
      state.user && { ...state.user, organization: { id: state.orgId, name: "Acme" } },
      role,
    ),
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

const runDetail = await import("@/app/api/ui/runs/[id]/route");
const runAnswer = await import("@/app/api/ui/runs/[id]/answer/route");
const { loadInboxFeed } = await import("@/lib/inbox/feed");
const { disconnectedLinearGateway } = await import("@/lib/linear/client");

const databaseAvailable = testDatabaseAvailable();

const member: TestUser = {
  id: "member-1",
  role: "member",
  name: "Mo Member",
  email: null,
  image: null,
};

async function detailOf(id: string): Promise<RunDetail> {
  const response = await runDetail.GET(new Request("http://localhost/api/ui"), {
    params: Promise.resolve({ id }),
  });
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  return runDetailSchema.parse(await response.json());
}

/** `POST /api/ui/runs/{id}/answer` with `body` as JSON. */
async function answer(id: string, body: unknown) {
  const response = await runAnswer.POST(
    new Request("http://localhost/api/ui", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  return {
    status: response.status,
    body: (await response.json()) as RunDetail & { error?: string },
  };
}

const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000);

describe.skipIf(!databaseAvailable)("POST /api/ui/runs/{id}/answer", () => {
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
    for (const [externalId, fullPath] of [
      ["1", "acme/api"],
      ["2", "acme/web"],
    ] as const) {
      const repository = await connectRepository(db, {
        connectionId: github.id,
        provider: "github",
        externalId,
        fullPath,
      });
      await updateRepositoryRalphSettings(db, repository.id, {
        ralphEnabled: true,
        ralphSettings: DEFAULT_RALPH_SETTINGS,
      });
      if (fullPath === "acme/api") repoA = repository.id;
      else repoB = repository.id;
    }
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
    await db.delete(triageRuns);
    await db.delete(chatConnections);
    state.user = member;
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

  /** A running job of the run whose session asks to use `tool`. */
  async function askPermission(runId: string, tool = "Bash") {
    const { job } = await insertJob(db, {
      organizationId: orgId,
      type: "ralph.story",
      taskType: "coding",
      pool: "long",
      ralphRunId: runId,
    });
    await db.update(jobs).set({ status: "running" }).where(eq(jobs.id, job.id));
    const requestId = randomUUID();
    await updateRun(db, runId, {
      status: "running",
      permission: {
        requestId,
        jobId: job.id,
        tool,
        detail: "git commit -m 'wip'",
        askedAt: new Date().toISOString(),
        expiresAt: minutesFromNow(10).toISOString(),
      },
    });
    return { jobId: job.id, requestId };
  }

  const questionOf = async (runId: string): Promise<RunQuestion> => {
    const { question } = (await detailOf(runId)).details;
    if (!question) throw new Error("no open question");
    return question;
  };

  it("answers a tool permission like a reply, notes it in the session, and refuses the same key twice", async () => {
    const run = await newRun();
    const { requestId } = await askPermission(run.id);

    const question = await questionOf(run.id);
    expect(question).toMatchObject({
      kind: "permission",
      prompt: "Om asks to use Bash: git commit -m 'wip'",
      options: [
        { id: "allow", label: "Allow" },
        { id: "deny", label: "Deny" },
      ],
    });
    expect(question.key).toMatch(new RegExp(`^question:${run.id}:permission:`));
    expect(question.expiresAt).not.toBeNull();

    const answered = await answer(run.id, { questionKey: question.key, optionId: "allow" });
    expect(answered.status).toBe(200);
    expect(runDetailSchema.parse(answered.body).details.question).toBeNull();
    const after = await getRun(db, run.id);
    expect(after?.permission).toMatchObject({
      requestId,
      answer: "allowed",
      answeredBy: "Mo Member",
    });
    expect(linear.bodies(run.linearAgentSessionId, "thought")).toEqual([
      "Mo Member answered from Omniralph: Allow",
      "Allowed **Bash**. Carrying on.",
    ]);

    const again = await answer(run.id, { questionKey: question.key, optionId: "deny" });
    expect(again).toMatchObject({
      status: 409,
      body: { error: "This question was already answered." },
    });
  });

  it("refuses an option the question doesn't offer, an unknown key and a bad body", async () => {
    const run = await newRun();
    await askPermission(run.id);
    const question = await questionOf(run.id);

    expect(await answer(run.id, { questionKey: question.key, optionId: "maybe" })).toMatchObject({
      status: 400,
      body: { error: "Choose one of the offered answers." },
    });
    expect(
      await answer(run.id, { questionKey: `${question.key}0`, optionId: "allow" }),
    ).toMatchObject({ status: 409, body: { error: "This question was already answered." } });
    expect((await answer(run.id, { optionId: "allow" })).status).toBe(400);
    expect((await answer(randomUUID(), { questionKey: "x", optionId: "y" })).status).toBe(404);
    // Nothing was answered.
    expect((await getRun(db, run.id))?.permission?.answer).toBeUndefined();
  });

  it("closes a permission whose job ended instead of answering it", async () => {
    const run = await newRun();
    const { jobId } = await askPermission(run.id);
    const question = await questionOf(run.id);
    await db.update(jobs).set({ status: "canceled" }).where(eq(jobs.id, jobId));

    expect(await answer(run.id, { questionKey: question.key, optionId: "allow" })).toMatchObject({
      status: 409,
    });
    expect((await getRun(db, run.id))?.permission?.answer).toBe("expired");
  });

  it("answers the preparation question of a manual story", async () => {
    const run = await newRun();
    await updateRun(db, run.id, {
      status: "waiting",
      preparation: {
        request: {
          storyIssueId: "story-1",
          identifier: "ENG-51",
          title: "Seed the bucket",
          commandsHash: "hash",
          headSha: null,
          askedAt: new Date().toISOString(),
        },
        handled: {},
      },
    });

    const question = await questionOf(run.id);
    expect(question).toMatchObject({
      kind: "preparation",
      prompt:
        "ENG-51 (Seed the bucket) is a manual story with preparation commands. Should Om run them now?",
      options: [
        { id: "run", label: "Run it" },
        { id: "myself", label: "I'll do it myself" },
        { id: "later", label: "Not yet" },
      ],
      expiresAt: null,
    });

    const answered = await answer(run.id, { questionKey: question.key, optionId: "later" });
    expect(answered.status).toBe(200);
    expect((await getRun(db, run.id))?.preparation?.request).toMatchObject({ answer: "later" });
    expect(linear.bodies(run.linearAgentSessionId, "thought")).toEqual([
      "Mo Member answered from Omniralph: Not yet",
      "OK, I won't run anything for **ENG-51** yet. The question stays open: answer it whenever you're ready.",
    ]);
  });

  it("answers the repository question with one of the offered repos", async () => {
    const issue = linear.add({ title: "Build it", identifier: "ENG-90" });
    const run = await newRun({
      linearIssueId: issue.id,
      linearIdentifier: issue.identifier,
      repositoryId: undefined,
    });
    await updateRun(db, run.id, {
      status: "waiting",
      pendingElicitation: { kind: "repository", repositoryIds: [repoB, repoA] },
    });
    state.scm = { getDefaultBranch: async () => "trunk" } as unknown as ScmAdapter;

    const question = await questionOf(run.id);
    expect(question).toMatchObject({
      kind: "repository",
      prompt: "Which repo should Om work in for ENG-90?",
      options: [
        { id: repoB, label: "acme/web" },
        { id: repoA, label: "acme/api" },
      ],
    });

    const answered = await answer(run.id, { questionKey: question.key, optionId: repoB });
    expect(answered.status).toBe(200);
    const after = await getRun(db, run.id);
    expect(after).toMatchObject({
      repositoryId: repoB,
      routedBy: "your selection",
      pendingElicitation: null,
    });
    expect(linear.bodies(run.linearAgentSessionId, "thought").slice(0, 2)).toEqual([
      "Mo Member answered from Omniralph: acme/web",
      expect.stringMatching(/^Using `acme\/web`\. Building on branch `.+`, based on `trunk`\.$/),
    ]);
  });

  it("answers a merged lane's cleanup question with a cleanup job", async () => {
    const run = await newRun();
    await updateRun(db, run.id, { status: "completed" });
    const lane = (await getMainLane(db, run))!;
    const askedAt = new Date().toISOString();
    await updateLane(db, lane.id, {
      harnessId,
      prNumber: 3,
      prUrl: "https://github.com/acme/api/pull/3",
      cleanup: {
        status: "done",
        at: askedAt,
        mergedSha: "abc",
        questions: [
          { kind: "branch", commits: 2, askedAt, deadline: minutesFromNow(60).toISOString() },
        ],
      },
    });

    const question = await questionOf(run.id);
    expect(question).toMatchObject({
      kind: "cleanup",
      prompt: `${lane.branch} has 2 commits that weren't merged. Should Om push it to origin, or delete it? Without an answer, Om deletes it.`,
      options: [
        { id: "push", label: "Push to origin" },
        { id: "delete", label: "Delete" },
      ],
    });

    const answered = await answer(run.id, { questionKey: question.key, optionId: "delete" });
    expect(answered.status).toBe(200);
    const cleanupJobs = await db.select().from(jobs).where(eq(jobs.type, "worktree.cleanup"));
    expect(cleanupJobs).toHaveLength(1);
    expect(cleanupJobs[0]!.payload).toMatchObject({ action: { kind: "branch", push: false } });
    expect((await getMainLane(db, run))?.cleanup).toMatchObject({
      jobId: cleanupJobs[0]!.id,
      answer: { kind: "branch", option: "Delete" },
    });
  });

  it("answers a chat run's question without Linear", async () => {
    const connection = await saveChatConnection(db, {
      organizationId: orgId,
      platform: "slack",
      externalId: "T1",
      name: "Acme",
      credentials: null,
      installedByUserId: null,
    });
    if (connection === "other_organization") throw new Error("connected elsewhere");
    const thread = (await ensureChatThread(db, {
      connectionId: connection.id,
      externalThreadId: "slack:C0123:1.1",
      channelId: "slack:C0123",
      startedByExternalUserId: "U1",
    }))!;
    const { run } = await createRun(db, {
      origin: "chat",
      organizationId: orgId,
      chatThreadId: thread.id,
      repositoryId: repoA,
      branch: "omniralph/readme-typo",
      baseBranch: "main",
    });
    state.linear = disconnectedLinearGateway();
    await askPermission(run.id, "Edit");

    const question = await questionOf(run.id);
    const answered = await answer(run.id, { questionKey: question.key, optionId: "deny" });
    expect(answered.status).toBe(200);
    expect((await getRun(db, run.id))?.permission).toMatchObject({
      answer: "denied",
      answeredBy: "Mo Member",
    });
  });

  it("answers another run's tool permission on its stored request", async () => {
    const { run: triage } = await createTriageRun(db, {
      organizationId: orgId,
      linearIssueId: "issue-triage",
      linearAgentSessionId: "session-triage",
      trigger: "label",
    });
    await db.update(triageRuns).set({ status: "running" }).where(eq(triageRuns.id, triage.id));
    const { job } = await insertJob(db, {
      organizationId: orgId,
      type: "triage.run",
      taskType: "query",
      pool: "short",
      triageRunId: triage.id,
    });
    await db.update(jobs).set({ status: "running" }).where(eq(jobs.id, job.id));
    await createRunPermissionRequest(db, {
      jobId: job.id,
      requestId: "req-1",
      tool: "WebFetch",
      detail: "https://example.com",
      expiresAt: minutesFromNow(5),
    });

    const question = await questionOf(triage.id);
    expect(question).toMatchObject({
      kind: "permission",
      prompt: "Om asks to use WebFetch: https://example.com",
    });

    // The Inbox item carries the same question.
    const [item] = await loadInboxFeed(
      db,
      { organizations: [{ id: orgId, name: "Acme", role: "member" }], userId: member.id },
      "needs-you",
    );
    expect(inboxItemSchema.parse(item)).toMatchObject({
      key: question.key,
      kind: "question",
      question,
    });

    const answered = await answer(triage.id, { questionKey: question.key, optionId: "deny" });
    expect(answered.status).toBe(200);
    expect(await getRunPermissionRequest(db, job.id, "req-1")).toMatchObject({
      answer: "denied",
      answeredBy: "Mo Member",
    });
    expect(await answer(triage.id, { questionKey: question.key, optionId: "allow" })).toMatchObject(
      { status: 409 },
    );
  });

  it("shows no question for a run without one", async () => {
    const run = await newRun();
    expect((await detailOf(run.id)).details.question).toBeNull();
    expect(await answer(run.id, { questionKey: "question:x", optionId: "allow" })).toMatchObject({
      status: 409,
    });
  });
});
