import { randomBytes, randomUUID } from "node:crypto";
import { createMockAdapter, createMockState } from "@chat-adapter/tests";
import {
  chatConnections,
  chatRunEvents,
  closeDb,
  connectRepository,
  ensureChatThread,
  saveChatConnection,
  createDb,
  createRun,
  createRunPermissionRequest,
  createTriageRun,
  getMainLane,
  getRun,
  getRunPermissionRequest,
  harnesses,
  insertJob,
  jobs,
  organizations,
  ralphRuns,
  triageRuns,
  updateLane,
  updateRepositoryCoding,
  updateRun,
  updateStory,
  upsertScmConnection,
  upsertStories,
  type Database,
  type NewLinearRalphRunInput,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import type { ScmAdapter } from "@omniralph/scm";
import { preparationHash } from "@omniralph/ralph";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runDetailSchema, type RunDetail, type RunQuestion } from "@/lib/api/runs";
import { inboxItemSchema } from "@/lib/api/inbox";
import { assertRole, type Role } from "@/lib/auth/roles";
import { PostgresDispatcher } from "@/lib/dispatch/dispatcher";
import { FakeLinearGateway, linearRun } from "@/lib/linear/fake-gateway";
import type { LinearGateway } from "@/lib/linear/gateway";
import type { ChangeMessage } from "@/lib/live/publisher";
import { withLiveChanges } from "@/lib/live/request";
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
// A chat run's conversation records run events through the chat bot's adapters.
vi.mock("@/lib/chat/bot", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getChatBot: () => ({
    chat: { initialize: async () => undefined },
    adapters: { slack: createMockAdapter("slack") },
    state: createMockState(),
  }),
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
process.env.APP_URL ??= "https://omniralph.example.com";

const runDetail = await import("@/app/api/ui/runs/[id]/route");
const runAnswer = await import("@/app/api/ui/runs/[id]/answer/route");
const { loadInboxFeed } = await import("@/lib/inbox/feed");
const { disconnectedLinearGateway } = await import("@/lib/linear/client");
const { readRunPermission } = await import("@/lib/runs/permissions");

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

/** Runs `fn` as a request whose change events a fake publisher receives. */
async function published(fn: () => Promise<unknown>): Promise<ChangeMessage[]> {
  const messages: ChangeMessage[] = [];
  const scheduled: Array<() => Promise<void>> = [];
  await withLiveChanges(fn, {
    publisher: { publish: async (batch) => void messages.push(...batch) },
    schedule: (task) => scheduled.push(task),
  });
  for (const task of scheduled) await task();
  return messages;
}

/** A manual story's description with preparation commands. */
const PREPARE_COMMANDS = ["terraform init"];
const MANUAL_DESCRIPTION = `Create the bucket in the console.

\`\`\`cyralph-prepare
${PREPARE_COMMANDS.join("\n")}
\`\`\`
`;

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
      await updateRepositoryCoding(db, repository.id, {
        ralphEnabled: true,
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

  /**
   * A running job of the run whose session asks to use `tool`, on the run and on the job's
   * stored request (`run_permission_requests`), as the harness asks.
   */
  async function askPermission(runId: string, tool = "Bash") {
    const { job } = await insertJob(db, {
      organizationId: orgId,
      type: "ralph.story",
      taskType: "coding",
      ralphRunId: runId,
    });
    await db.update(jobs).set({ status: "running" }).where(eq(jobs.id, job.id));
    const requestId = randomUUID();
    const expiresAt = minutesFromNow(10);
    await createRunPermissionRequest(db, {
      jobId: job.id,
      requestId,
      tool,
      detail: "git commit -m 'wip'",
      expiresAt,
    });
    await updateRun(db, runId, {
      status: "running",
      permission: {
        requestId,
        jobId: job.id,
        tool,
        detail: "git commit -m 'wip'",
        askedAt: new Date().toISOString(),
        expiresAt: expiresAt.toISOString(),
      },
    });
    return { jobId: job.id, requestId };
  }

  const questionOf = async (runId: string): Promise<RunQuestion> => {
    const { question } = (await detailOf(runId)).details;
    if (!question) throw new Error("no open question");
    return question;
  };

  it("answers a tool permission like a reply, on the run and its stored request, notes it in the session, and refuses the same key twice", async () => {
    const run = await newRun();
    const { jobId, requestId } = await askPermission(run.id);

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

    let answered!: Awaited<ReturnType<typeof answer>>;
    const messages = await published(async () => {
      answered = await answer(run.id, { questionKey: question.key, optionId: "allow" });
    });
    expect(answered.status).toBe(200);
    expect(runDetailSchema.parse(answered.body).details.question).toBeNull();
    const after = await getRun(db, run.id);
    expect(after?.permission).toMatchObject({
      requestId,
      answer: "allowed",
      answeredBy: "Mo Member",
    });
    // The stored request holds the answer already, before the agent's next poll reads it.
    expect(await getRunPermissionRequest(db, jobId, requestId)).toMatchObject({
      answer: "allowed",
      answeredBy: "Mo Member",
    });
    expect(await readRunPermission(db, { id: jobId, ralphRunId: run.id }, requestId)).toEqual({
      status: "allowed",
      answeredBy: "Mo Member",
    });
    expect(linear.bodies(run.linearAgentSessionId, "thought")).toEqual([
      "Allowed **Bash**. Carrying on.",
      "Mo Member answered from Omniralph: Allow",
    ]);
    // The run's change goes on the organization's channel.
    expect(messages).toContainEqual({
      channel: `org:${orgId}:changes`,
      event: expect.objectContaining({ resource: "run", runId: run.id }),
    });

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

  it("closes a permission whose job ended instead of answering it, and notes no answer", async () => {
    const run = await newRun();
    const { jobId, requestId } = await askPermission(run.id);
    const question = await questionOf(run.id);
    await db.update(jobs).set({ status: "canceled" }).where(eq(jobs.id, jobId));

    expect(await answer(run.id, { questionKey: question.key, optionId: "allow" })).toMatchObject({
      status: 409,
    });
    expect((await getRun(db, run.id))?.permission?.answer).toBe("expired");
    expect(
      linear
        .bodies(run.linearAgentSessionId, "thought")
        .filter((b) => b.includes("answered from Omniralph")),
    ).toEqual([]);
    expect((await getRunPermissionRequest(db, jobId, requestId))?.answer).not.toBe("allowed");
  });

  it("answers the preparation question of a manual story with Not yet", async () => {
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
      "OK, I won't run anything for **ENG-51** yet. The question stays open: answer it whenever you're ready.",
      "Mo Member answered from Omniralph: Not yet",
    ]);
  });

  /** An epic waiting on its manual story ENG-81, whose preparation it asks about. */
  async function preparationEpic() {
    const epic = linear.add({ identifier: "ENG-80", title: "Epic", description: "Build it." });
    const bucket = linear.add({
      identifier: "ENG-81",
      title: "Create the bucket",
      parentId: epic.id,
      labels: ["manual"],
      description: MANUAL_DESCRIPTION,
    });
    const run = await newRun({
      linearIssueId: epic.id,
      linearIdentifier: "ENG-80",
      linearUrl: "https://linear.app/acme/issue/ENG-80/epic",
    });
    const [row] = await upsertStories(db, run.id, [
      { linearIssueId: bucket.id, identifier: "ENG-81", title: "Create the bucket" },
    ]);
    await updateStory(db, row!.id, { status: "manual" });
    await updateRun(db, run.id, {
      status: "waiting",
      waitingOn: {
        blockers: [],
        manual: [{ id: bucket.id, identifier: "ENG-81", title: "Create the bucket" }],
      },
      preparation: {
        request: {
          storyIssueId: bucket.id,
          identifier: "ENG-81",
          title: "Create the bucket",
          commandsHash: preparationHash(PREPARE_COMMANDS),
          headSha: null,
          askedAt: new Date().toISOString(),
        },
        handled: {},
      },
    });
    return { run, bucket };
  }

  const execJobs = (runId: string) =>
    db
      .select()
      .from(jobs)
      .where(and(eq(jobs.ralphRunId, runId), eq(jobs.type, "worktree.exec")));

  it("answers the preparation question with Run it: the preparation job is queued", async () => {
    const { run, bucket } = await preparationEpic();
    const question = await questionOf(run.id);
    const answered = await answer(run.id, { questionKey: question.key, optionId: "run" });
    expect(answered.status).toBe(200);

    // As the reply "Run it" leaves it: approved, and its `worktree.exec` job queued.
    const [job, ...more] = await execJobs(run.id);
    expect(more).toEqual([]);
    expect(job).toMatchObject({ status: "queued", taskType: "system" });
    expect(job!.payload).toMatchObject({ commands: PREPARE_COMMANDS });
    expect(await getRun(db, run.id)).toMatchObject({
      status: "running",
      preparation: {
        request: { storyIssueId: bucket.id, answer: "run", jobId: job!.id },
        handled: {},
      },
    });
    expect(linear.bodies(run.linearAgentSessionId, "thought")).toContain(
      "Mo Member answered from Omniralph: Run it",
    );
  });

  it("answers the preparation question with I'll do it myself: it isn't asked again", async () => {
    const { run, bucket } = await preparationEpic();
    const question = await questionOf(run.id);
    const answered = await answer(run.id, { questionKey: question.key, optionId: "myself" });
    expect(answered.status).toBe(200);
    expect(runDetailSchema.parse(answered.body).details.question).toBeNull();

    // As the reply "I'll do it myself" leaves it: handled by a person, nothing runs.
    expect((await getRun(db, run.id))?.preparation).toMatchObject({
      request: null,
      handled: { [bucket.id]: { how: "myself" } },
    });
    expect(await execJobs(run.id)).toEqual([]);
    expect(linear.bodies(run.linearAgentSessionId, "thought")).toContain(
      "Mo Member answered from Omniralph: I'll do it myself",
    );
  });

  it("answers the repository question with one of the offered repos, and the run starts its first story", async () => {
    const issue = linear.add({ title: "Build it", identifier: "ENG-90", description: "Build it." });
    linear.add({ title: "First story", identifier: "ENG-91", parentId: issue.id });
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
    const thoughts = linear.bodies(run.linearAgentSessionId, "thought");
    expect(thoughts[0]).toMatch(
      /^Using `acme\/web`\. Building on branch `.+`, based on `trunk`\.$/,
    );
    expect(thoughts).toContain("Mo Member answered from Omniralph: acme/web");
    // The run advanced to its first story.
    const storyJobs = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.ralphRunId, run.id), eq(jobs.type, "ralph.story")));
    expect(storyJobs).toEqual([expect.objectContaining({ status: "queued", repositoryId: repoB })]);
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

  it("answers a chat run's question without Linear, on its stored request, noted in the thread's run events", async () => {
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
    const { jobId, requestId } = await askPermission(run.id, "Edit");

    const question = await questionOf(run.id);
    const answered = await answer(run.id, { questionKey: question.key, optionId: "deny" });
    expect(answered.status).toBe(200);
    expect((await getRun(db, run.id))?.permission).toMatchObject({
      answer: "denied",
      answeredBy: "Mo Member",
    });
    expect(await getRunPermissionRequest(db, jobId, requestId)).toMatchObject({
      answer: "denied",
      answeredBy: "Mo Member",
    });
    expect(await readRunPermission(db, { id: jobId, ralphRunId: run.id }, requestId)).toEqual({
      status: "denied",
      answeredBy: "Mo Member",
    });
    const events = await db
      .select()
      .from(chatRunEvents)
      .where(eq(chatRunEvents.chatThreadId, thread.id));
    expect(events.map((e) => e.body.text)).toContain("Mo Member answered from Omniralph: Deny");
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

    let answered!: Awaited<ReturnType<typeof answer>>;
    const messages = await published(async () => {
      answered = await answer(triage.id, { questionKey: question.key, optionId: "deny" });
    });
    expect(answered.status).toBe(200);
    expect(await getRunPermissionRequest(db, job.id, "req-1")).toMatchObject({
      answer: "denied",
      answeredBy: "Mo Member",
    });
    // Noted in the triage run's Linear session.
    expect(linear.bodies("session-triage", "thought")).toEqual([
      "Mo Member answered from Omniralph: Deny",
    ]);
    expect(messages).toContainEqual({
      channel: `org:${orgId}:changes`,
      event: expect.objectContaining({ resource: "run", runId: triage.id }),
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
