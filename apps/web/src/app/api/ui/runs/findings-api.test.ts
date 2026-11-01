import { randomBytes } from "node:crypto";
import {
  closeDb,
  connectRepository,
  createDb,
  createReview,
  createReviewRun,
  createRun,
  dismissFinding,
  findings,
  organizations,
  ralphRuns,
  reviewRuns,
  reviews,
  upsertScmConnection,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runFindingsSchema, type RunFindings } from "@/lib/api/runs";
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

const findingsRoute = await import("@/app/api/ui/runs/[id]/findings/route");

const databaseAvailable = testDatabaseAvailable();

const member: TestUser = { id: "member-1", role: "member", name: null, email: null, image: null };

/** `GET /api/ui/runs/{id}/findings`. */
async function findingsRequest(id: string) {
  const response = await findingsRoute.GET(new Request("http://localhost/api/ui"), {
    params: Promise.resolve({ id }),
  });
  return {
    status: response.status,
    body: (await response.json()) as RunFindings & { error?: string },
  };
}

async function findingsOf(id: string): Promise<RunFindings> {
  const { status, body } = await findingsRequest(id);
  if (status !== 200) throw new Error(`HTTP ${status}: ${body.error}`);
  return runFindingsSchema.parse(body);
}

describe.skipIf(!databaseAvailable)("GET /api/ui/runs/{id}/findings", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let repoId: string;
  let base = Date.UTC(2026, 9, 1, 9);

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
    state.db = db;
    const github = (await upsertScmConnection(db, {
      organizationId: orgId,
      provider: "github",
      name: "bot",
      baseUrl: "https://github.com",
      externalId: "5",
      credentials: {},
    }))!;
    repoId = (
      await connectRepository(db, {
        connectionId: github.id,
        provider: "github",
        externalId: "1",
        fullPath: "acme/api",
      })
    ).id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    await db.delete(reviewRuns);
    await db.delete(reviews);
    await db.delete(ralphRuns);
    state.user = member;
    state.orgId = orgId;
  });

  async function reviewRun(passCount: number) {
    const run = await createReviewRun(db, {
      organizationId: orgId,
      repositoryId: repoId,
      prNumber: 7,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      trigger: "webhook",
      mode: "full",
      depth: "standard",
    });
    const passes = [];
    for (let i = 0; i < passCount; i += 1) {
      const pass = await createReview(db, {
        reviewRunId: run.id,
        repositoryId: repoId,
        prNumber: 7,
        prTitle: "Tidy the API",
        headSha: "a".repeat(40),
        baseSha: "b".repeat(40),
        trigger: "webhook",
        depth: "standard",
        model: null,
        budget: 100_000,
      });
      // Passes in creation order.
      base += 1000;
      await db
        .update(reviews)
        .set({ createdAt: new Date(base) })
        .where(eq(reviews.id, pass.id));
      passes.push(pass);
    }
    return { run, passes };
  }

  function finding(
    reviewId: string,
    path: string,
    startLine: number,
    extra: Partial<typeof findings.$inferInsert> = {},
  ) {
    base += 1000;
    return {
      reviewId,
      path,
      startLine,
      endLine: startLine + 1,
      severity: "high" as const,
      category: "bug",
      title: `${path}:${startLine}`,
      body: "Body",
      confidence: 0.8,
      createdAt: new Date(base),
      ...extra,
    };
  }

  it("lists each pass's findings by file, with dismissals and skipped files", async () => {
    const { run, passes } = await reviewRun(2);
    const [security, style] = passes;
    await db
      .update(reviews)
      .set({ status: "completed", skippedFiles: [{ path: "dist/app.js", reason: "generated" }] })
      .where(eq(reviews.id, security!.id));
    const [late, , early] = await db
      .insert(findings)
      .values([
        finding(security!.id, "src/a.ts", 30, { suggestion: "return null;" }),
        finding(security!.id, "src/b.ts", 5, { severity: "low" }),
        finding(security!.id, "src/a.ts", 3),
      ])
      .returning();
    await dismissFinding(db, {
      findingId: early!.id,
      reason: "false_positive",
      note: "Checked upstream.",
      scmUsername: "alex",
    });

    const view = await findingsOf(run.id);
    expect(view.passes.map((p) => p.id)).toEqual([security!.id, style!.id]);
    const [first, second] = view.passes;
    expect(first).toMatchObject({
      status: "completed",
      findingCount: 3,
      skippedFiles: [{ path: "dist/app.js", reason: "generated" }],
    });
    // Files in the order of their first finding, findings by start line.
    expect(first!.files.map((f) => [f.path, f.findings.map((x) => x.startLine)])).toEqual([
      ["src/a.ts", [3, 30]],
      ["src/b.ts", [5]],
    ]);
    expect(first!.files[0]!.findings).toEqual([
      expect.objectContaining({
        id: early!.id,
        status: "dismissed",
        supersededBy: null,
        feedback: [
          expect.objectContaining({
            source: "scm",
            reason: "false_positive",
            note: "Checked upstream.",
            actor: "@alex",
            restoredAt: null,
          }),
        ],
      }),
      expect.objectContaining({
        id: late!.id,
        severity: "high",
        category: "bug",
        title: "src/a.ts:30",
        suggestion: "return null;",
        confidence: 0.8,
        status: "open",
        feedback: [],
      }),
    ]);
    expect(second).toEqual({
      id: style!.id,
      status: "queued",
      files: [],
      findingCount: 0,
      skippedFiles: [],
    });
  });

  it("links a superseded finding to the later run's pass", async () => {
    const older = await reviewRun(1);
    const newer = await reviewRun(1);
    const [replacement] = await db
      .insert(findings)
      .values(finding(newer.passes[0]!.id, "src/a.ts", 3))
      .returning();
    await db.insert(findings).values(
      finding(older.passes[0]!.id, "src/a.ts", 3, {
        status: "superseded",
        supersededByFindingId: replacement!.id,
      }),
    );

    const view = await findingsOf(older.run.id);
    expect(view.passes[0]!.files[0]!.findings[0]).toMatchObject({
      status: "superseded",
      supersededBy: {
        runId: newer.run.id,
        stepId: newer.passes[0]!.id,
        findingId: replacement!.id,
      },
    });
  });

  it("answers 400 for other run kinds and 404 for runs outside the user's organizations", async () => {
    const { run: epic } = await createRun(db, {
      organizationId: orgId,
      trackerIssueId: "issue-1",
      trackerIdentifier: "ENG-1",
      trackerTitle: "Epic",
      trackerUrl: "https://linear.app/acme/issue/ENG-1/epic",
      trackerSessionId: "session-1",
      kind: "children",
      repositoryId: repoId,
      branch: "eng-1",
      baseBranch: "main",
    });
    expect(await findingsRequest(epic.id)).toMatchObject({
      status: 400,
      body: { error: "Only review runs have findings." },
    });

    const { run } = await reviewRun(1);
    const [other] = await db.insert(organizations).values({ name: "Other" }).returning();
    state.orgId = other!.id;
    expect(await findingsRequest(run.id)).toMatchObject({
      status: 404,
      body: { error: "That run doesn't exist." },
    });
    for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
      expect((await findingsRequest(id)).status).toBe(404);
    }
  });

  it("refuses signed-out users", async () => {
    const { run } = await reviewRun(1);
    state.user = null;
    expect((await findingsRequest(run.id)).status).toBe(401);
  });
});
