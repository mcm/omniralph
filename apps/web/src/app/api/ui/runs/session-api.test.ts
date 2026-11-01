import { randomBytes } from "node:crypto";
import {
  agents,
  appendGuidance,
  appendProgress,
  closeDb,
  connectRepository,
  createDb,
  createReviewRun,
  createRun,
  ensureLane,
  insertJob,
  insertMessage,
  jobs,
  organizations,
  ralphRuns,
  reviewRuns,
  updateMessage,
  updateStory,
  upsertScmConnection,
  upsertStories,
  type Database,
  type NewTrackerRalphRunInput,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
  setCodingEnabled,
} from "@omniralph/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runSessionSchema, type RunSession } from "@/lib/api/runs";
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

const sessionRoute = await import("@/app/api/ui/runs/[id]/session/route");
const { RUN_SESSION_MESSAGE_LIMIT } = await import("@omniralph/db");

const databaseAvailable = testDatabaseAvailable();

const member: TestUser = { id: "member-1", role: "member", name: null, email: null, image: null };

/** `GET /api/ui/runs/{id}/session`, with `cursor` when given. */
async function sessionRequest(id: string, cursor?: string) {
  const search = cursor ? `?${new URLSearchParams({ cursor })}` : "";
  const response = await sessionRoute.GET(new Request(`http://localhost/api/ui${search}`), {
    params: Promise.resolve({ id }),
  });
  return {
    status: response.status,
    body: (await response.json()) as RunSession & { error?: string },
  };
}

async function sessionOf(id: string, cursor?: string): Promise<RunSession> {
  const { status, body } = await sessionRequest(id, cursor);
  if (status !== 200) throw new Error(`HTTP ${status}: ${body.error}`);
  return runSessionSchema.parse(body);
}

describe.skipIf(!databaseAvailable)("GET /api/ui/runs/{id}/session", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let api: string;
  let web: string;
  let agentId: string;
  let session = 0;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
    state.db = db;
    const gitlab = (await upsertScmConnection(db, {
      organizationId: orgId,
      provider: "gitlab",
      name: "bot",
      baseUrl: "https://gitlab.example.com",
      externalId: "5",
      credentials: {},
    }))!;
    api = (
      await connectRepository(db, {
        connectionId: gitlab.id,
        provider: "gitlab",
        externalId: "1",
        fullPath: "acme/api",
      })
    ).id;
    web = (
      await connectRepository(db, {
        connectionId: gitlab.id,
        provider: "gitlab",
        externalId: "2",
        fullPath: "acme/web",
      })
    ).id;
    await setCodingEnabled(db, api);
    [{ id: agentId }] = (await db
      .insert(agents)
      .values({ organizationId: orgId, name: "agent-a" })
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
    state.user = member;
    state.orgId = orgId;
  });

  async function newRun(overrides: Partial<NewTrackerRalphRunInput> = {}) {
    session += 1;
    const { run } = await createRun(db, {
      organizationId: orgId,
      trackerIssueId: `issue-${session}`,
      trackerIdentifier: `ENG-${session}`,
      trackerTitle: `Epic ${session}`,
      trackerUrl: `https://linear.app/acme/issue/ENG-${session}/epic`,
      trackerSessionId: `session-${session}`,
      kind: "children",
      repositoryId: api,
      branch: `eng-${session}`,
      baseBranch: "main",
      ...overrides,
    });
    return run;
  }

  async function attempt(
    input: { storyId?: string; type?: string; runId: string },
    status: string,
  ) {
    const { job } = await insertJob(db, {
      organizationId: orgId,
      type: input.type ?? "ralph.story",
      taskType: "coding",
      ralphRunId: input.runId,
      ralphStoryId: input.storyId ?? null,
    });
    await db
      .update(jobs)
      .set({ status: status as "running", agentId })
      .where(eq(jobs.id, job.id));
    return job;
  }

  async function createdAt(id: string, minute: number) {
    const at = `2026-10-01T09:${String(minute).padStart(2, "0")}:00Z`;
    await db.execute(
      sql`update ralph_messages set created_at = ${at}::timestamptz where id = ${id}`,
    );
  }

  it("shows an epic's pending requests, messages, guidance, recommendations and progress log", async () => {
    const run = await newRun();
    const webLane = await ensureLane(db, {
      runId: run.id,
      repositoryId: web,
      branch: "eng-web",
      baseBranch: "main",
    });
    const [story] = await upsertStories(db, run.id, [
      { trackerIssueId: "s-1", identifier: "ENG-41", title: "Build the importer" },
    ]);
    await updateStory(db, story!.id, {
      recommendations: [
        { title: "Fix the SDK", description: "Upstream bug.", at: "2026-10-01T10:00:00.000Z" },
      ],
    });
    const running = await attempt({ runId: run.id, storyId: story!.id }, "running");
    const ended = await attempt({ runId: run.id, storyId: story!.id }, "failed");

    const request = await insertMessage(db, {
      runId: run.id,
      laneId: webLane.id,
      kind: "request",
      text: "Open the MR",
      author: "Ada",
    });
    const waiting = await insertMessage(db, {
      runId: run.id,
      jobId: running.id,
      kind: "guidance",
      text: "Use the new client",
      author: "Bo",
    });
    const delivered = await insertMessage(db, {
      runId: run.id,
      jobId: running.id,
      kind: "guidance",
      text: "Keep the old flag",
    });
    await updateMessage(db, delivered.id, {
      deliveredAt: new Date("2026-10-01T09:05:00Z"),
      consumedAt: new Date("2026-10-01T09:05:00Z"),
    });
    const kept = await insertMessage(db, {
      runId: run.id,
      jobId: ended.id,
      kind: "guidance",
      text: "Try again",
    });
    await updateMessage(db, kept.id, { consumedAt: new Date("2026-10-01T09:06:00Z") });
    const lost = await insertMessage(db, {
      runId: run.id,
      jobId: ended.id,
      kind: "request",
      text: "Rename it",
    });
    for (const [id, minute] of [
      [request.id, 0],
      [lost.id, 1],
      [kept.id, 2],
      [delivered.id, 3],
      [waiting.id, 4],
    ] as const) {
      await createdAt(id, minute);
    }
    await appendGuidance(db, run.id, "First", new Date("2026-10-01T08:00:00Z"));
    await appendGuidance(db, run.id, "Second", new Date("2026-10-01T08:30:00Z"));
    await appendProgress(db, run.id, "## ENG-41\n- importer built");

    const view = await sessionOf(run.id);
    expect(view.pendingRequests).toEqual([
      {
        id: request.id,
        text: "Open the MR",
        author: "Ada",
        createdAt: "2026-10-01T09:00:00.000Z",
        repository: { id: web, provider: "gitlab", fullPath: "acme/web" },
      },
    ]);
    expect(view.messages).toEqual([
      {
        id: waiting.id,
        kind: "guidance",
        text: "Use the new client",
        author: "Bo",
        attempt: { id: running.id, label: "Building ENG-41" },
        state: "waiting",
        createdAt: "2026-10-01T09:04:00.000Z",
        settledAt: null,
      },
      expect.objectContaining({
        id: delivered.id,
        state: "delivered",
        settledAt: "2026-10-01T09:05:00.000Z",
      }),
      expect.objectContaining({
        id: kept.id,
        state: "guidance",
        settledAt: "2026-10-01T09:06:00.000Z",
      }),
      expect.objectContaining({ id: lost.id, state: "undelivered", settledAt: null }),
    ]);
    // Labels are sentences, never job types (Design rule 4).
    expect(JSON.stringify(view.messages)).not.toContain("ralph.");
    expect(view.nextCursor).toBeNull();
    expect(view.guidance).toEqual([
      { text: "Second", at: "2026-10-01T08:30:00.000Z" },
      { text: "First", at: "2026-10-01T08:00:00.000Z" },
    ]);
    expect(view.recommendations).toEqual([
      {
        story: {
          id: story!.id,
          identifier: "ENG-41",
          title: "Build the importer",
          url: "https://linear.app/acme/issue/ENG-41",
        },
        title: "Fix the SDK",
        description: "Upstream bug.",
        at: "2026-10-01T10:00:00.000Z",
      },
    ]);
    expect(view.progressLog).toBe("## ENG-41\n- importer built");
  });

  it("pages a request run's messages with a cursor, and refuses a bad cursor", async () => {
    const run = await newRun({ mode: "request", kind: "single" });
    const job = await attempt({ runId: run.id, type: "ralph.request" }, "completed");
    const total = RUN_SESSION_MESSAGE_LIMIT + 3;
    for (let i = 0; i < total; i += 1) {
      const message = await insertMessage(db, {
        runId: run.id,
        jobId: job.id,
        kind: "request",
        text: `m${i}`,
      });
      await db.execute(
        sql`update ralph_messages set created_at = ${new Date(Date.UTC(2026, 9, 1, 9, 0, i)).toISOString()}::timestamptz where id = ${message.id}`,
      );
    }
    const first = await sessionOf(run.id);
    expect(first.messages).toHaveLength(RUN_SESSION_MESSAGE_LIMIT);
    expect(first.messages[0]!.text).toBe(`m${total - 1}`);
    expect(first.nextCursor).not.toBeNull();
    const older = await sessionOf(run.id, first.nextCursor!);
    expect(older.messages.map((m) => m.text)).toEqual(["m2", "m1", "m0"]);
    expect(older.nextCursor).toBeNull();

    expect(await sessionRequest(run.id, "not-a-cursor")).toMatchObject({ status: 400 });
  });

  it("has no session for other run kinds (400), and 404s on unknown runs", async () => {
    const review = await createReviewRun(db, {
      organizationId: orgId,
      repositoryId: web,
      prNumber: 3,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      trigger: "mention",
      mode: "full",
      depth: "standard",
    });
    expect(await sessionRequest(review.id)).toMatchObject({
      status: 400,
      body: { error: "Only epic and request runs have a session." },
    });
    for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
      expect(await sessionRequest(id)).toMatchObject({ status: 404 });
    }
  });

  it("needs a signed-in member", async () => {
    const run = await newRun();
    state.user = null;
    expect((await sessionRequest(run.id)).status).toBe(401);
  });
});
