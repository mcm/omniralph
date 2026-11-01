import { randomBytes } from "node:crypto";
import {
  closeDb,
  createDb,
  createTriageRun,
  insertJob,
  jobs,
  organizations,
  triageRuns,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runTriageSummarySchema, type RunTriageSummary } from "@/lib/api/runs";
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

const triageRoute = await import("@/app/api/ui/runs/[id]/triage/route");

const databaseAvailable = testDatabaseAvailable();

const member: TestUser = { id: "member-1", role: "member", name: null, email: null, image: null };

/** `GET /api/ui/runs/{id}/triage`. */
async function triageRequest(id: string) {
  const response = await triageRoute.GET(new Request("http://localhost/api/ui"), {
    params: Promise.resolve({ id }),
  });
  return {
    status: response.status,
    body: (await response.json()) as RunTriageSummary & { error?: string },
  };
}

async function summaryOf(id: string): Promise<RunTriageSummary> {
  const { status, body } = await triageRequest(id);
  if (status !== 200) throw new Error(`HTTP ${status}: ${body.error}`);
  return runTriageSummarySchema.parse(body);
}

const USAGE = { inputTokens: 1200, outputTokens: 300 };

/** A valid `TriageRunResult` that leaves `openQuestions`. */
function result(openQuestions: string[]) {
  return {
    summary: "Wrote a PRD for the export and split it into 3 stories.",
    error: null,
    outcome: {
      outcome: "prd",
      size: "L",
      title: "Billing export",
      description: "## Introduction\n\nExport invoices.",
      openQuestions,
      stories: [1, 2, 3].map((n) => ({
        title: `Story ${n}`,
        body: "As a user…",
        priority: 3,
        dependsOn: [],
        manual: false,
      })),
      subIssueUpdates: [],
    },
    usage: USAGE,
    durationMs: 1000,
  };
}

describe.skipIf(!databaseAvailable)("GET /api/ui/runs/{id}/triage", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let session = 0;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
    state.db = db;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    await db.delete(jobs);
    await db.delete(triageRuns);
    state.user = member;
    state.orgId = orgId;
  });

  /** A triage run in `status` with `lastResult`, whose jobs read each description in turn. */
  async function triageRun(
    status: "queued" | "running" | "completed" | "failed" | "stopped",
    lastResult: unknown,
    descriptions: string[],
  ) {
    session += 1;
    const { run } = await createTriageRun(db, {
      organizationId: orgId,
      trackerIssueId: `issue-${session}`,
      trackerSessionId: `session-${session}`,
      trigger: "label",
    });
    await db
      .update(triageRuns)
      .set({ status, lastResult: lastResult as Record<string, unknown> | null })
      .where(eq(triageRuns.id, run.id));
    for (const [index, description] of descriptions.entries()) {
      const { job } = await insertJob(db, {
        organizationId: orgId,
        type: "triage.run",
        taskType: "query",
        triageRunId: run.id,
        payload: {
          trigger: {
            kind: "tracker.triage",
            context: {
              triageRunId: run.id,
              issue: { identifier: "ENG-90", title: `Title ${index + 1}`, description },
            },
          },
        },
      });
      await db
        .update(jobs)
        .set({ createdAt: new Date(Date.UTC(2026, 9, 1, 9, index)), status: "completed" })
        .where(eq(jobs.id, job.id));
    }
    return run;
  }

  it("shows the outcome, open questions, and the issue as its first job read it", async () => {
    // The second job (after a reply) read the PRD the first one wrote.
    const run = await triageRun("completed", result(["Which currency?"]), [
      "export invoices pls",
      "## Introduction\n\nExport invoices.",
    ]);
    expect(await summaryOf(run.id)).toEqual({
      outcome: "needs_answers",
      summary: "Wrote a PRD for the export and split it into 3 stories.",
      error: null,
      change: "prd",
      size: "L",
      storyCount: 3,
      openQuestions: ["Which currency?"],
      originalIssue: { title: "Title 1", description: "export invoices pls" },
    });
  });

  it("is ready to start when nothing is left to answer", async () => {
    const run = await triageRun("completed", result([]), ["export invoices"]);
    expect((await summaryOf(run.id)).outcome).toBe("ready");
  });

  it("is triaging while a job runs, even with an earlier job's result", async () => {
    const run = await triageRun("running", result(["Which currency?"]), ["a", "b"]);
    expect((await summaryOf(run.id)).outcome).toBe("triaging");
  });

  it("says why it failed, and counts a completed run without a valid result as failed", async () => {
    const failed = await triageRun(
      "failed",
      {
        summary: "boom",
        error: "the triage ended without a result (error)",
        outcome: null,
        usage: USAGE,
        durationMs: 1,
      },
      ["export invoices"],
    );
    expect(await summaryOf(failed.id)).toMatchObject({
      outcome: "failed",
      error: "the triage ended without a result (error)",
      change: null,
      openQuestions: [],
    });
    const invalid = await triageRun("completed", { nonsense: true }, []);
    expect(await summaryOf(invalid.id)).toMatchObject({
      outcome: "failed",
      summary: null,
      originalIssue: null,
    });
  });

  it("is not found outside the user's organizations", async () => {
    const run = await triageRun("completed", result([]), ["x"]);
    const [other] = await db.insert(organizations).values({ name: "Beta" }).returning();
    state.orgId = other!.id;
    state.user = { ...member, id: "outsider" };
    expect((await triageRequest(run.id)).status).toBe(404);
  });
});
