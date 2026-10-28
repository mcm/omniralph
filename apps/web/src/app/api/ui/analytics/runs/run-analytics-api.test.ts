import { randomBytes } from "node:crypto";
import {
  closeDb,
  connectRepository,
  createDb,
  createRun,
  createTriageRun,
  jobs,
  modelPrices,
  organizationMembers,
  ralphRuns,
  replaceAttemptModelUsage,
  organizations,
  upsertScmConnection,
  upsertStories,
  updateRun,
  updateStory,
  users,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runAnalyticsResponseSchema, type RunAnalyticsResponse } from "@/lib/api/analytics";
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

const route = await import("@/app/api/ui/analytics/runs/route");

const databaseAvailable = testDatabaseAvailable();

const member: TestUser = { id: "member-1", role: "member", name: null, email: null, image: null };

async function get(search: Record<string, string> = {}) {
  const response = await route.GET(
    new Request(`http://localhost/api/ui/analytics/runs?${new URLSearchParams(search)}`),
    { params: Promise.resolve({}) },
  );
  return {
    status: response.status,
    body: (await response.json()) as RunAnalyticsResponse & { error?: string },
  };
}

describe.skipIf(!databaseAvailable)("GET /api/ui/analytics/runs", () => {
  let testDb: TestDatabase;
  let db: Database;
  let acme: string;
  let beta: string;
  let other: string;
  let acmeRepo: string;
  let betaRepo: string;
  let otherRepo: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    const [acmeOrg, betaOrg, otherOrg] = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Beta" }, { name: "Other" }])
      .returning();
    acme = acmeOrg!.id;
    beta = betaOrg!.id;
    other = otherOrg!.id;
    state.orgId = acme;
    await db.insert(users).values({ id: member.id, email: "member@acme.io" });
    await db.insert(organizationMembers).values([
      { organizationId: acme, userId: member.id, role: "member" },
      { organizationId: beta, userId: member.id, role: "member" },
    ]);

    const connect = async (organizationId: string, name: string) => {
      const connection = (await upsertScmConnection(db, {
        organizationId,
        provider: "github",
        name,
        baseUrl: "https://api.github.com",
        externalId: `${name}-installation`,
        credentials: {},
      }))!;
      return (
        await connectRepository(db, {
          connectionId: connection.id,
          provider: "github",
          externalId: `${name}-1`,
          fullPath: `${name}/app`,
        })
      ).id;
    };
    acmeRepo = await connect(acme, "acme");
    betaRepo = await connect(beta, "beta");
    otherRepo = await connect(other, "other");

    // A run with one built story in each organization.
    for (const [organizationId, repositoryId, name] of [
      [acme, acmeRepo, "acme"],
      [beta, betaRepo, "beta"],
      [other, otherRepo, "other"],
    ] as const) {
      const { run } = await createRun(db, {
        organizationId,
        linearIssueId: `${name}-issue`,
        linearIdentifier: "ENG-1",
        linearTitle: "Epic",
        linearUrl: null,
        linearAgentSessionId: `${name}-session`,
        kind: "children",
        repositoryId,
        branch: `${name}-branch`,
        baseBranch: "main",
      });
      await updateRun(db, run.id, { status: "completed" });
      const [story] = await upsertStories(db, run.id, [
        { linearIssueId: `${name}-story`, identifier: "ENG-2", title: "Story" },
      ]);
      await updateStory(db, story!.id, { status: "completed" });
      await db.insert(jobs).values({
        organizationId,
        type: "ralph.story",
        taskType: "coding",
        repositoryId,
        ralphRunId: run.id,
        status: "completed",
        result: { usage: { inputTokens: 100, outputTokens: 10 } },
        finishedAt: new Date(),
      });
    }
    // A triage attempt of Acme's, with no repository.
    const { run: triage } = await createTriageRun(db, {
      organizationId: acme,
      linearIssueId: "acme-triage-issue",
      linearAgentSessionId: "acme-triage-session",
      trigger: "mention",
    });
    await db.insert(jobs).values({
      organizationId: acme,
      type: "triage.run",
      taskType: "query",
      triageRunId: triage.id,
      status: "failed",
      result: { usage: { inputTokens: 70, outputTokens: 7 } },
      finishedAt: new Date(),
    });
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  it("answers the active organization's figures, every day of the window zero-filled", async () => {
    state.user = member;
    const { status, body } = await get({ days: "7" });
    expect(status).toBe(200);
    const analytics = runAnalyticsResponseSchema.parse(body);
    expect(analytics.bucket).toBe("day");
    expect(analytics.buckets).toHaveLength(7);
    expect(analytics.buckets.slice(0, 6).every((b) => b.stories === 0)).toBe(true);
    expect(analytics.totals).toEqual({
      stories: 1,
      reviewRuns: 0,
      attempts: { finished: 2, completed: 1, failed: 1, expired: 0, successRate: 0.5 },
      // Attempts from before usage per model: tokens unpriced, so no cost (0 without tokens).
      tokens: {
        epic: { tokensIn: 100, tokensOut: 10 },
        request: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
        review: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
        triage: { tokensIn: 70, tokensOut: 7 },
        ask: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      },
    });
    expect(analytics.byRepository).toMatchObject([
      {
        repository: { id: acmeRepo, provider: "github", fullPath: "acme/app" },
        organization: { id: acme, name: "Acme" },
        stories: 1,
      },
    ]);
    expect(analytics.byOrganization).toMatchObject([{ organization: { id: acme, name: "Acme" } }]);
    expect(analytics.repositories).toEqual([
      {
        id: acmeRepo,
        provider: "github",
        fullPath: "acme/app",
        organization: { id: acme, name: "Acme" },
      },
    ]);
    expect(analytics.params).toEqual({ days: 7, bucket: "day", repositoryId: null });
    // No priced attempt in the window: the totals carry no cost, and nothing counts as left
    // out of a sum.
    expect(analytics.totals.costUsd).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/unpricedAttempts/);

    // Defaults: 30 days by day; weeks on request.
    expect((await get()).body.buckets).toHaveLength(30);
    const weeks = await get({ days: "90", bucket: "week" });
    expect(weeks.status).toBe(200);
    expect(weeks.body.bucket).toBe("week");
    expect(weeks.body.params).toEqual({ days: 90, bucket: "week", repositoryId: null });
    expect(weeks.body.buckets.length).toBeGreaterThanOrEqual(13);
    expect(
      weeks.body.buckets.every((b) => new Date(`${b.start}T00:00:00Z`).getUTCDay() === 1),
    ).toBe(true);
  });

  it("totals per organization for all of the user's organizations", async () => {
    state.user = member;
    const { status, body } = await get({ organization: "all" });
    expect(status).toBe(200);
    expect(body.byOrganization).toMatchObject([
      { organization: { id: acme, name: "Acme" }, stories: 1 },
      { organization: { id: beta, name: "Beta" }, stories: 1 },
    ]);
    expect(body.totals.stories).toBe(2);
    expect(body.byRepository.map((r) => [r.repository.fullPath, r.organization.name])).toEqual([
      ["acme/app", "Acme"],
      ["beta/app", "Beta"],
    ]);
    // Every repository of the scope, for the filter.
    expect(body.repositories.map((r) => [r.id, r.organization.name])).toEqual([
      [acmeRepo, "Acme"],
      [betaRepo, "Beta"],
    ]);
    expect(runAnalyticsResponseSchema.safeParse(body).success).toBe(true);
    expect(JSON.stringify(body)).not.toContain(other);

    const one = await get({ organization: beta });
    expect(one.body.byOrganization).toMatchObject([{ organization: { id: beta } }]);
  });

  it("filters by one repository of the scope, and ignores any other", async () => {
    state.user = member;
    const own = await get({ repository: acmeRepo });
    expect(own.status).toBe(200);
    expect(own.body.params.repositoryId).toBe(acmeRepo);
    // The triage attempt has no repository.
    expect(own.body.totals.attempts).toMatchObject({ finished: 1, completed: 1 });
    expect(own.body.totals.tokens.triage).toEqual({ tokensIn: 0, tokensOut: 0, costUsd: 0 });
    // The filter still lists every repository of the scope.
    expect(own.body.repositories.map((r) => r.id)).toEqual([acmeRepo]);

    // Another organization's repository, one outside the scope, or not an ID: all repos.
    for (const search of [
      { repository: otherRepo },
      { repository: betaRepo },
      { repository: "not-a-uuid" },
    ]) {
      const ignored = await get(search);
      expect(ignored.status).toBe(200);
      expect(ignored.body.params.repositoryId).toBeNull();
      expect(ignored.body.totals.attempts).toMatchObject({ finished: 2 });
      expect(JSON.stringify(ignored.body)).not.toContain(other);
    }
    // Under all organizations, Beta's repository is in scope.
    const beta = await get({ organization: "all", repository: betaRepo });
    expect(beta.body.params.repositoryId).toBe(betaRepo);
    expect(beta.body.byRepository.map((r) => r.repository.id)).toEqual([betaRepo]);

    expect(await get({ organization: other })).toMatchObject({ status: 404 });
  });

  it("answers 400 for an unknown window or bucket", async () => {
    state.user = member;
    for (const search of <Record<string, string>[]>[
      { days: "14" },
      { days: "seven" },
      { bucket: "month" },
    ]) {
      const { status, body } = await get(search);
      expect(status).toBe(400);
      expect(body.error).toBeTruthy();
    }
    expect((await get({ days: "14" })).body.error).toBe("days must be 7, 30 or 90.");
    expect((await get({ bucket: "month" })).body.error).toBe("bucket must be day or week.");
  });

  it("prices the priced attempts, counting the token-bearing ones it leaves out", async () => {
    state.user = member;
    const opus = {
      model: "claude-opus-5-5",
      canonicalModel: "claude-opus-5-5",
      inputTokens: 1_000_000,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheWrite1hInputTokens: 0,
      outputTokens: 100_000,
      largestRequestInputTokens: 1_000_000,
      fastMode: false,
    };
    const [run] = await db
      .select({ id: ralphRuns.id })
      .from(ralphRuns)
      .where(eq(ralphRuns.organizationId, beta));
    const result = { usage: { inputTokens: 1_000_000, outputTokens: 100_000, byModel: [opus] } };
    const [job] = await db
      .insert(jobs)
      .values({
        organizationId: beta,
        type: "ralph.story",
        taskType: "coding",
        repositoryId: betaRepo,
        ralphRunId: run!.id,
        status: "completed",
        result,
        finishedAt: new Date(),
      })
      .returning();
    await replaceAttemptModelUsage(db, job!.id, result);
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
      const { status, body } = await get({ organization: beta, days: "7" });
      expect(status).toBe(200);
      const analytics = runAnalyticsResponseSchema.parse(body);
      // $4 input + $2 output; Beta's earlier story attempt has tokens but no list price.
      expect(analytics.totals).toMatchObject({
        costUsd: 6,
        unpricedAttempts: 1,
        tokens: { epic: { tokensIn: 1_000_100, costUsd: 6, unpricedAttempts: 1 } },
      });
      expect(analytics.byRepository[0]).toMatchObject({ costUsd: 6, unpricedAttempts: 1 });
      expect(analytics.byOrganization[0]).toMatchObject({ costUsd: 6, unpricedAttempts: 1 });
      expect(analytics.buckets.at(-1)).toMatchObject({ costUsd: 6, unpricedAttempts: 1 });
      expect(analytics.buckets[0]).toMatchObject({ costUsd: 0 });
      expect(analytics.buckets[0]!.unpricedAttempts).toBeUndefined();
    } finally {
      await db.delete(modelPrices);
      await db.delete(jobs).where(eq(jobs.id, job!.id));
    }
  });

  it("requires a signed-in user", async () => {
    state.user = null;
    expect((await get()).status).toBe(401);
  });
});
