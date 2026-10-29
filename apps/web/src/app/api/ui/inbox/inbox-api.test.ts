import { randomBytes, randomUUID } from "node:crypto";
import {
  closeDb,
  connectRepository,
  createDb,
  findings,
  agents,
  inboxItemStates,
  insertJob,
  jobs,
  organizations,
  ralphLanes,
  ralphRuns,
  ralphStories,
  reviewRuns,
  reviews,
  triageRuns,
  upsertScmConnection,
  users,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  inboxCountsSchema,
  inboxFeedSchema,
  type InboxFeed,
  type InboxItem,
} from "@/lib/api/inbox";
import { runDetailSchema } from "@/lib/api/runs";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));

type TestUser = { id: string; role: Role; name: string | null; email: string | null; image: null };
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  user: null as TestUser | null,
  orgId: "",
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") =>
    assertRole(
      state.user && { ...state.user, organization: { id: state.orgId, name: "Acme" } },
      role,
    ),
}));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const inbox = await import("@/app/api/ui/inbox/route");
const counts = await import("@/app/api/ui/inbox/counts/route");
const runDetail = await import("@/app/api/ui/runs/[id]/route");

const databaseAvailable = testDatabaseAvailable();

const alice: TestUser = {
  id: "inbox-alice",
  role: "member",
  name: "Alice",
  email: null,
  image: null,
};
const bob: TestUser = { id: "inbox-bob", role: "member", name: "Bob", email: null, image: null };

async function call<T>(
  handler: (
    request: Request,
    route: { params: Promise<Record<string, string>> },
  ) => Promise<Response>,
  search: Record<string, string> = {},
): Promise<{ status: number; body: T & { error?: string } }> {
  const response = await handler(
    new Request(`http://localhost/api/ui/inbox?${new URLSearchParams(search)}`),
    { params: Promise.resolve({}) },
  );
  return { status: response.status, body: (await response.json()) as T & { error?: string } };
}

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

describe.skipIf(!databaseAvailable)("/api/ui/inbox", () => {
  let testDb: TestDatabase;
  let db: Database;
  let repoId: string;
  const ids: Record<string, string> = {};

  const run = async (name: string, values: Partial<typeof ralphRuns.$inferInsert>) => {
    const id = randomUUID();
    ids[name] = id;
    await db.insert(ralphRuns).values({
      id,
      organizationId: state.orgId,
      linearIssueId: `issue-${name}`,
      linearIdentifier: `ENG-${Object.keys(ids).length}`,
      linearTitle: `Epic ${name}`,
      linearUrl: `https://linear.app/acme/issue/ENG-${Object.keys(ids).length}/epic`,
      linearAgentSessionId: `session-${name}`,
      kind: "children",
      repositoryId: repoId,
      status: "completed",
      ...values,
    });
  };

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    state.orgId = org!.id;
    await db.insert(users).values([{ id: alice.id }, { id: bob.id }]);
    const connection = (await upsertScmConnection(
      db,
      {
        organizationId: state.orgId,
        provider: "github",
        name: "app",
        baseUrl: "https://api.github.com",
        externalId: "installation-1",
        credentials: {},
      },
      randomBytes(32),
    ))!;
    repoId = (
      await connectRepository(db, {
        connectionId: connection.id,
        provider: "github",
        externalId: "1",
        fullPath: "acme/web",
      })
    ).id;

    await run("waiting", { status: "waiting" });
    const [story] = await db
      .insert(ralphStories)
      .values({
        runId: ids.waiting!,
        linearIssueId: "story-1",
        identifier: "ENG-11",
        title: "Point DNS at the new host",
        status: "manual",
      })
      .returning();
    ids.story = story!.id;
    await run("prReady", {});
    const [lane] = await db
      .insert(ralphLanes)
      .values({
        runId: ids.prReady!,
        repositoryId: repoId,
        branch: "omniralph/eng-2",
        baseBranch: "main",
        prNumber: 42,
        prReviewState: "changes_requested",
      })
      .returning();
    ids.lane = lane!.id;
    const [reviewRun] = await db
      .insert(reviewRuns)
      .values({
        organizationId: state.orgId,
        repositoryId: repoId,
        prNumber: 42,
        headSha: "h",
        baseSha: "b",
        trigger: "webhook",
        mode: "full",
        status: "completed",
      })
      .returning();
    ids.reviewRun = reviewRun!.id;
    const [pass] = await db
      .insert(reviews)
      .values({
        reviewRunId: reviewRun!.id,
        repositoryId: repoId,
        prNumber: 42,
        headSha: "h",
        baseSha: "b",
        trigger: "webhook",
        status: "completed",
        budget: 1000,
      })
      .returning();
    await db.insert(findings).values({
      reviewId: pass!.id,
      path: "a.ts",
      startLine: 1,
      endLine: 1,
      severity: "critical",
      category: "security",
      title: "t",
      body: "b",
      confidence: 0.9,
    });
    const [agent] = await db
      .insert(agents)
      .values({ organizationId: state.orgId, name: "build-box", lastHeartbeatAt: ago(30) })
      .returning();
    ids.agent = agent!.id;
    // An online agent whose update to 1.4.0 failed.
    await db.insert(agents).values({
      organizationId: state.orgId,
      name: "edge-box",
      lastHeartbeatAt: new Date(),
      updateState: {
        state: "idle",
        version: "1.4.0",
        previous: "1.3.0",
        startsSincePending: 0,
        error: "checksum mismatch",
      },
    });
    const [sync] = await db
      .insert(jobs)
      .values({
        organizationId: state.orgId,
        type: "repo.sync",
        taskType: "system",
        status: "failed",
        error: "git fetch failed",
        repositoryId: repoId,
        agentId: agent!.id,
        finishedAt: ago(5),
      })
      .returning();
    ids.sync = sync!.id;
    await run("running", { status: "running", mode: "request" });
    await db.insert(triageRuns).values({
      organizationId: state.orgId,
      linearIssueId: "triage-1",
      linearAgentSessionId: "triage-session-1",
      trigger: "label",
      status: "queued",
    });
    // A PRD triage wrote, sized M, that nobody started.
    const [prd] = await db
      .insert(triageRuns)
      .values({
        organizationId: state.orgId,
        linearIssueId: "triage-prd",
        linearAgentSessionId: "triage-session-prd",
        trigger: "label",
        status: "completed",
        lastResult: {
          summary: "s",
          error: null,
          outcome: { outcome: "prd", size: "M", openQuestions: [] },
        },
        updatedAt: ago(20),
      })
      .returning();
    ids.prd = prd!.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  const feed = async (tab?: string, user = alice) => {
    state.user = user;
    const response = await call<InboxFeed>(inbox.GET, tab ? { tab } : {});
    expect(response.status).toBe(200);
    return inboxFeedSchema.parse(response.body).items;
  };
  const byKind = (items: InboxItem[], kind: InboxItem["kind"]) =>
    items.find((item) => item.kind === kind)!;

  it("lists Needs you with typed references, reasons and actions", async () => {
    const items = await feed();
    expect(items.map((i) => i.kind).sort()).toEqual(["manual_story", "pr_waiting", "prd_ready"]);
    expect(byKind(items, "manual_story")).toEqual({
      key: `manual_story:${ids.story}`,
      tab: "needs-you",
      kind: "manual_story",
      organization: { id: state.orgId, name: "Acme", role: "member" },
      title: "Point DNS at the new host",
      run: { id: ids.waiting, kind: "epic", status: "waiting" },
      // A manual story is a story of the epic, not a Backlog item to start.
      workItem: {
        id: null,
        tracker: "linear",
        identifier: "ENG-11",
        url: "https://linear.app/acme/issue/ENG-11",
      },
      repository: { id: repoId, provider: "github", fullPath: "acme/web" },
      pullRequest: null,
      agent: null,
      reason: "ENG-11 is a manual story: a person has to do it before the epic can finish.",
      reasonLink: null,
      since: expect.any(String),
      actions: ["done", "skip", "snooze"],
      question: null,
      reviewState: null,
      review: null,
      size: null,
      version: null,
    });
    expect(byKind(items, "prd_ready")).toMatchObject({
      run: { id: ids.prd, kind: "triage", status: "completed" },
      size: "M",
      actions: ["done", "snooze"],
    });
    expect(byKind(items, "pr_waiting")).toMatchObject({
      size: null,
      key: `pr:${ids.lane}:changes_requested`,
      pullRequest: { provider: "github", number: 42, url: "https://github.com/acme/web/pull/42" },
      reason: "A reviewer asked for changes to pull request #42.",
      reviewState: "changes_requested",
      review: {
        runId: ids.reviewRun,
        status: "completed",
        openFindings: { critical: 1, high: 0, medium: 0, low: 0, info: 0 },
      },
      actions: ["done", "snooze"],
    });
  });

  it("lists Problems and Running, without raw job types", async () => {
    const problems = await feed("problems");
    expect(problems.map((i) => i.kind).sort()).toEqual([
      "agent_offline",
      "agent_update_failed",
      "failed_system",
    ]);
    expect(byKind(problems, "agent_update_failed")).toMatchObject({
      title: "edge-box",
      version: "1.4.0",
      reason: "edge-box couldn't update to 1.4.0. checksum mismatch",
    });
    expect(byKind(problems, "failed_system")).toMatchObject({
      key: `failed_attempt:${ids.sync}`,
      run: null,
      title: "Couldn't sync web",
      repository: { id: repoId, fullPath: "acme/web" },
      agent: { id: ids.agent, name: "build-box" },
      reason: "Couldn't sync web. git fetch failed",
      actions: ["retry", "done", "snooze"],
    });
    expect(byKind(problems, "agent_offline")).toMatchObject({
      title: "build-box",
      agent: { id: ids.agent, name: "build-box" },
      actions: ["done", "snooze"],
    });
    const running = await feed("running");
    expect(running.map((i) => [i.kind, i.run?.kind, i.run?.status, i.actions]).sort()).toEqual([
      ["run", "request", "running", []],
      ["run", "triage", "queued", []],
    ]);
    for (const item of [...problems, ...running]) {
      for (const text of [item.title, item.reason]) expect(text).not.toMatch(/\b[a-z]+\.[a-z-]+\b/);
    }
  });

  it("applies the user's Done and Snooze, and counts consistently", async () => {
    await db.insert(inboxItemStates).values([
      {
        userId: alice.id,
        organizationId: state.orgId,
        itemKey: `manual_story:${ids.story}`,
        state: "done",
      },
      {
        userId: alice.id,
        organizationId: state.orgId,
        itemKey: `failed_attempt:${ids.sync}`,
        state: "snoozed",
        snoozedUntil: new Date(Date.now() + 3_600_000),
      },
    ]);
    expect((await feed(undefined, alice)).map((i) => i.kind).sort()).toEqual([
      "pr_waiting",
      "prd_ready",
    ]);
    expect((await feed(undefined, bob)).map((i) => i.kind).sort()).toEqual([
      "manual_story",
      "pr_waiting",
      "prd_ready",
    ]);
    for (const user of [alice, bob]) {
      state.user = user;
      const response = await call(counts.GET);
      expect(response.status).toBe(200);
      expect(inboxCountsSchema.parse(response.body)).toEqual({
        needsYou: (await feed("needs-you", user)).length,
        problems: (await feed("problems", user)).length,
        running: (await feed("running", user)).length,
      });
    }
    state.user = alice;
    expect((await call(counts.GET)).body).toEqual({ needsYou: 2, problems: 2, running: 2 });
  });

  it("carries each kind of open question with the run detail's question, and offers Answer", async () => {
    const askedAt = new Date().toISOString();
    const inAnHour = new Date(Date.now() + 3_600_000).toISOString();
    await run("repositoryQuestion", {
      status: "waiting",
      repositoryId: null,
      pendingElicitation: { kind: "repository", repositoryIds: [repoId] },
    });
    await run("preparationQuestion", {
      status: "waiting",
      preparation: {
        request: {
          storyIssueId: "story-prep",
          identifier: "ENG-51",
          title: "Seed the bucket",
          commandsHash: "hash",
          headSha: null,
          askedAt,
        },
        handled: {},
      },
    });
    await run("cleanupQuestion", {});
    await db.insert(ralphLanes).values({
      runId: ids.cleanupQuestion!,
      repositoryId: repoId,
      branch: "omniralph/cleanup",
      baseBranch: "main",
      prNumber: 7,
      cleanup: {
        status: "done",
        at: askedAt,
        mergedSha: "abc",
        questions: [{ kind: "branch", commits: 2, askedAt, deadline: inAnHour }],
      },
    });
    await run("permissionQuestion", { status: "running" });
    const [job] = await db
      .insert(jobs)
      .values({
        organizationId: state.orgId,
        type: "ralph.story",
        taskType: "coding",
        status: "running",
        ralphRunId: ids.permissionQuestion!,
      })
      .returning();
    await db
      .update(ralphRuns)
      .set({
        permission: {
          requestId: "req-1",
          jobId: job!.id,
          tool: "Bash",
          detail: "rm -rf build",
          askedAt,
          expiresAt: inAnHour,
        },
      })
      .where(inArray(ralphRuns.id, [ids.permissionQuestion!]));
    const questionRuns = {
      repository: ids.repositoryQuestion!,
      preparation: ids.preparationQuestion!,
      cleanup: ids.cleanupQuestion!,
      permission: ids.permissionQuestion!,
    };
    try {
      const items = (await feed("needs-you", bob)).filter((i) => i.kind === "question");
      for (const [kind, runId] of Object.entries(questionRuns)) {
        const item = items.find((i) => i.run?.id === runId);
        expect(item, kind).toBeDefined();
        const response = await runDetail.GET(new Request("http://localhost/api/ui"), {
          params: Promise.resolve({ id: runId }),
        });
        expect(response.status).toBe(200);
        const { question } = runDetailSchema.parse(await response.json()).details;
        expect(question).toMatchObject({ kind, key: item!.key });
        expect(question!.options.length).toBeGreaterThan(0);
        expect(item!.question).toEqual(question);
        expect(item!.actions).toContain("answer");
      }
    } finally {
      await db.delete(jobs).where(inArray(jobs.id, [job!.id]));
      await db.delete(ralphRuns).where(inArray(ralphRuns.id, Object.values(questionRuns)));
    }
  });

  it("says why a queued run waits for host tools, in its Running item and its detail", async () => {
    const [triage] = await db
      .insert(triageRuns)
      .values({
        organizationId: state.orgId,
        linearIssueId: "triage-host-tools",
        linearAgentSessionId: "triage-session-host-tools",
        trigger: "label",
        status: "queued",
      })
      .returning();
    // No online agent of the organization reports gh or opengrep with a path.
    const { job } = await insertJob(db, {
      organizationId: state.orgId,
      type: "triage.run",
      taskType: "query",
      triageRunId: triage!.id,
      requiredHostTools: ["opengrep", "gh"],
    });
    try {
      const expected = {
        reason: "Waiting for an agent with gh and opengrep installed",
        reasonLink: { label: "Open Fleet", href: "/fleet" },
      };
      const item = (await feed("running")).find((i) => i.run?.id === triage!.id);
      expect(item).toMatchObject({ kind: "run", ...expected });
      const response = await runDetail.GET(new Request("http://localhost/api/ui"), {
        params: Promise.resolve({ id: triage!.id }),
      });
      expect(response.status).toBe(200);
      expect(runDetailSchema.parse(await response.json())).toMatchObject({
        status: "queued",
        ...expected,
      });
      // The other queued run waits for any agent: no link.
      const other = (await feed("running")).find(
        (i) => i.run?.kind === "triage" && i.run.id !== triage!.id,
      );
      expect(other).toMatchObject({ reason: "Waiting for an agent.", reasonLink: null });
    } finally {
      await db.delete(jobs).where(inArray(jobs.id, [job.id]));
      await db.delete(triageRuns).where(inArray(triageRuns.id, [triage!.id]));
    }
  });

  it("refuses an unknown tab or organization, and anonymous users", async () => {
    state.user = alice;
    expect(await call(inbox.GET, { tab: "later" })).toMatchObject({
      status: 400,
      body: { error: "Unknown Inbox tab." },
    });
    expect((await call(inbox.GET, { organization: randomUUID() })).status).toBe(404);
    expect((await call(counts.GET, { organization: "nope" })).status).toBe(400);
    state.user = null;
    expect((await call(inbox.GET)).status).toBe(401);
    expect((await call(counts.GET)).status).toBe(401);
  });
});
