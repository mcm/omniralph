import { randomBytes, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Database } from "../client.js";
import { runMigrations } from "../migrate.js";
import { connectRepository, upsertScmConnection } from "../repositories.js";
import { agents, feedback, findings, jobs, reviews, organizations } from "../schema.js";
import { analyticsWindow, getAnalytics, listAnalyticsRepositories } from "./analytics.js";
import { seedReviewProfiles } from "../settings.js";

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

const key = randomBytes(32);
const now = new Date("2026-10-05T12:00:00Z");

describe("analyticsWindow", () => {
  it("covers whole UTC days ending with today", () => {
    expect(analyticsWindow(7, now)).toEqual({
      from: new Date("2026-09-29T00:00:00Z"),
      to: new Date("2026-10-06T00:00:00Z"),
    });
    expect(analyticsWindow(90, new Date("2026-10-05T23:59:59Z")).from).toEqual(
      new Date("2026-07-08T00:00:00Z"),
    );
  });
});

describe.skipIf(!dockerAvailable)("analytics queries", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let orgId: string;
  let repoA: string;
  let repoB: string;
  let agent1: string;
  let agent2: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    await seedReviewProfiles(db, org!.id);
    orgId = org!.id;

    const connection = (await upsertScmConnection(
      db,
      {
        organizationId: orgId,
        provider: "github",
        name: "app",
        baseUrl: "https://api.github.com",
        externalId: "1",
        credentials: {},
      },
      key,
    ))!;
    repoA = (
      await connectRepository(db, {
        connectionId: connection.id,
        provider: "github",
        externalId: "1",
        fullPath: "acme/api",
      })
    ).id;
    repoB = (
      await connectRepository(db, {
        connectionId: connection.id,
        provider: "github",
        externalId: "2",
        fullPath: "acme/web",
      })
    ).id;
    const [a1, a2] = await db
      .insert(agents)
      .values([
        { organizationId: orgId, name: "coder-1" },
        { organizationId: orgId, name: "coder-2" },
      ])
      .returning();
    agent1 = a1!.id;
    agent2 = a2!.id;

    const review = (
      repositoryId: string,
      createdAt: string,
      profileId: string,
      status: (typeof reviews.$inferInsert)["status"],
      tokensIn: number,
      tokensOut: number,
    ) => ({
      id: randomUUID(),
      repositoryId,
      prNumber: 1,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      trigger: "webhook" as const,
      status,
      profileId,
      budget: 200_000,
      tokensIn,
      tokensOut,
      createdAt: new Date(createdAt),
    });
    const r1 = review(repoA, "2026-10-05T01:00:00Z", "standard", "completed", 1000, 200);
    const r2 = review(repoA, "2026-10-04T23:30:00Z", "quick", "completed", 400, 100);
    const r3 = review(repoA, "2026-10-04T10:00:00Z", "quick", "budget_exhausted", 600, 100);
    const r4 = review(repoA, "2026-10-03T08:00:00Z", "standard", "failed", 50, 0);
    // The first day of the 7-day window, and the last instant before it.
    const r5 = review(repoA, "2026-09-29T00:00:00Z", "standard", "completed", 2000, 300);
    const r6 = review(repoA, "2026-09-28T23:59:59Z", "deep", "completed", 5000, 500);
    // Outside every window: before the 90 days, and after today.
    const r7 = review(repoA, "2026-07-01T00:00:00Z", "deep", "completed", 9000, 900);
    const r8 = review(repoA, "2026-10-06T00:00:00Z", "deep", "completed", 9000, 900);
    const s1 = review(repoB, "2026-10-02T12:00:00Z", "standard", "completed", 3000, 300);
    const s2 = review(repoB, "2026-10-05T11:00:00Z", "standard", "queued", 0, 0);
    await db.insert(reviews).values([r1, r2, r3, r4, r5, r6, r7, r8, s1, s2]);

    const finding = (
      reviewId: string,
      severity: (typeof findings.$inferInsert)["severity"],
      status: (typeof findings.$inferInsert)["status"] = "open",
    ) => ({
      id: randomUUID(),
      reviewId,
      path: "src/a.ts",
      startLine: 1,
      endLine: 2,
      severity,
      category: "bug",
      title: "T",
      body: "B",
      confidence: 0.9,
      status,
    });
    const f = {
      r1Critical: finding(r1.id, "critical"),
      r1High: finding(r1.id, "high", "dismissed"),
      r1Medium: finding(r1.id, "medium", "superseded"),
      r2Low: finding(r2.id, "low", "dismissed"),
      r2Info: finding(r2.id, "info", "dismissed"),
      s1High: finding(s1.id, "high"),
      s1HighFp: finding(s1.id, "high", "dismissed"),
      r6Critical: finding(r6.id, "critical"),
      r7Critical: finding(r7.id, "critical", "dismissed"),
    };
    await db.insert(findings).values(Object.values(f));
    await db.insert(feedback).values([
      { findingId: f.r1High.id, source: "ui", reason: "false_positive" },
      { findingId: f.r2Low.id, source: "scm", reason: "wont_fix" },
      // A false positive that was restored, then dismissed again for another reason.
      {
        findingId: f.r2Info.id,
        source: "ui",
        reason: "false_positive",
        restoredAt: new Date("2026-10-05T02:00:00Z"),
      },
      { findingId: f.r2Info.id, source: "ui", reason: "other" },
      { findingId: f.s1HighFp.id, source: "scm", reason: "false_positive" },
      { findingId: f.r7Critical.id, source: "ui", reason: "false_positive" },
    ]);

    const job = (
      agentId: string | null,
      repositoryId: string,
      status: (typeof jobs.$inferInsert)["status"],
      createdAt: string,
    ) => ({
      organizationId: orgId,
      capability: "review",
      type: "review.run",
      agentId,
      repositoryId,
      status,
      createdAt: new Date(createdAt),
    });
    await db
      .insert(jobs)
      .values([
        job(agent1, repoA, "completed", "2026-10-05T01:00:00Z"),
        job(agent1, repoA, "completed", "2026-10-04T10:00:00Z"),
        job(agent1, repoA, "failed", "2026-10-03T08:00:00Z"),
        job(agent2, repoB, "running", "2026-10-05T11:00:00Z"),
        job(agent2, repoB, "completed", "2026-09-01T00:00:00Z"),
        job(null, repoB, "queued", "2026-10-05T11:30:00Z"),
      ]);
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await container?.stop();
  });

  it("totals reviews and tokens over the last 7 days", async () => {
    const analytics = await getAnalytics(db, { organizationId: orgId, days: 7, now });
    expect(analytics.from).toEqual(new Date("2026-09-29T00:00:00Z"));
    expect(analytics.to).toEqual(new Date("2026-10-06T00:00:00Z"));
    expect(analytics.totals).toEqual({ reviews: 7, tokensIn: 7050, tokensOut: 1000 });
  });

  it("returns a zero-filled daily series in UTC days", async () => {
    const { daily } = await getAnalytics(db, { organizationId: orgId, days: 7, now });
    expect(daily).toEqual([
      { date: "2026-09-29", reviews: 1, tokensIn: 2000, tokensOut: 300 },
      { date: "2026-09-30", reviews: 0, tokensIn: 0, tokensOut: 0 },
      { date: "2026-10-01", reviews: 0, tokensIn: 0, tokensOut: 0 },
      { date: "2026-10-02", reviews: 1, tokensIn: 3000, tokensOut: 300 },
      { date: "2026-10-03", reviews: 1, tokensIn: 50, tokensOut: 0 },
      { date: "2026-10-04", reviews: 2, tokensIn: 1000, tokensOut: 200 },
      { date: "2026-10-05", reviews: 2, tokensIn: 1000, tokensOut: 200 },
    ]);
    expect((await getAnalytics(db, { organizationId: orgId, days: 90, now })).daily).toHaveLength(
      90,
    );
  });

  it("averages tokens per review by profile over reviews that ran", async () => {
    const { byProfile } = await getAnalytics(db, { organizationId: orgId, days: 7, now });
    expect(byProfile).toEqual([
      { profileId: "quick", profileName: "Quick", reviews: 2, averageTokens: 600 },
      // r1 (1,200), r5 (2,300) and s1 (3,300); the failed and queued reviews don't count.
      { profileId: "standard", profileName: "Standard", reviews: 3, averageTokens: 2267 },
    ]);

    const month = await getAnalytics(db, { organizationId: orgId, days: 30, now });
    expect(month.byProfile.map((p) => [p.profileId, p.reviews, p.averageTokens])).toEqual([
      ["deep", 1, 5500],
      ["quick", 2, 600],
      ["standard", 3, 2267],
    ]);
  });

  it("counts reviews by status and findings by severity", async () => {
    const analytics = await getAnalytics(db, { organizationId: orgId, days: 7, now });
    expect(analytics.reviewsByStatus).toEqual({
      queued: 1,
      running: 0,
      completed: 4,
      failed: 1,
      budget_exhausted: 1,
      skipped: 0,
    });
    expect(analytics.findingsBySeverity).toEqual({
      critical: 1,
      high: 3,
      medium: 1,
      low: 1,
      info: 1,
    });
    expect(
      (await getAnalytics(db, { organizationId: orgId, days: 30, now })).findingsBySeverity
        .critical,
    ).toBe(2);
  });

  it("computes the dismissal rate per repository, highest first", async () => {
    const { dismissalsByRepository } = await getAnalytics(db, {
      organizationId: orgId,
      days: 7,
      now,
    });
    expect(dismissalsByRepository).toEqual([
      {
        repository: { id: repoA, provider: "github", fullPath: "acme/api" },
        // The superseded finding isn't counted; only r1High is still an active false positive.
        findings: 4,
        dismissed: 3,
        falsePositives: 1,
        dismissalRate: 0.75,
      },
      {
        repository: { id: repoB, provider: "github", fullPath: "acme/web" },
        findings: 2,
        dismissed: 1,
        falsePositives: 1,
        dismissalRate: 0.5,
      },
    ]);
  });

  it("counts jobs per agent, most first, ignoring unassigned jobs", async () => {
    const { jobsByAgent } = await getAnalytics(db, { organizationId: orgId, days: 7, now });
    expect(jobsByAgent).toEqual([
      { agent: { id: agent1, name: "coder-1" }, total: 3, completed: 2, failed: 1 },
      { agent: { id: agent2, name: "coder-2" }, total: 1, completed: 0, failed: 0 },
    ]);
    const quarter = await getAnalytics(db, { organizationId: orgId, days: 90, now });
    expect(quarter.jobsByAgent[1]).toMatchObject({ total: 2, completed: 1 });
  });

  it("filters everything by repository", async () => {
    const analytics = await getAnalytics(db, {
      organizationId: orgId,
      days: 7,
      now,
      repositoryId: repoB,
    });
    expect(analytics.totals).toEqual({ reviews: 2, tokensIn: 3000, tokensOut: 300 });
    expect(analytics.byProfile).toEqual([
      { profileId: "standard", profileName: "Standard", reviews: 1, averageTokens: 3300 },
    ]);
    expect(analytics.reviewsByStatus).toMatchObject({ completed: 1, queued: 1, failed: 0 });
    expect(analytics.findingsBySeverity).toMatchObject({ high: 2, critical: 0 });
    expect(analytics.dismissalsByRepository.map((d) => d.repository.id)).toEqual([repoB]);
    expect(analytics.jobsByAgent).toEqual([
      { agent: { id: agent2, name: "coder-2" }, total: 1, completed: 0, failed: 0 },
    ]);
  });

  it("returns zeros for a window without activity", async () => {
    const analytics = await getAnalytics(db, {
      organizationId: orgId,
      days: 7,
      now: new Date("2026-01-15T00:00:00Z"),
    });
    expect(analytics.totals).toEqual({ reviews: 0, tokensIn: 0, tokensOut: 0 });
    expect(analytics.daily.every((d) => d.reviews === 0)).toBe(true);
    expect(analytics.byProfile).toEqual([]);
    expect(analytics.dismissalsByRepository).toEqual([]);
    expect(analytics.jobsByAgent).toEqual([]);
    expect(Object.values(analytics.findingsBySeverity).every((n) => n === 0)).toBe(true);
  });

  it("lists repositories for the filter by path", async () => {
    expect(await listAnalyticsRepositories(db, orgId)).toEqual([
      { id: repoA, provider: "github", fullPath: "acme/api" },
      { id: repoB, provider: "github", fullPath: "acme/web" },
    ]);
  });

  it("leaves out other organizations' reviews, findings, jobs and repositories", async () => {
    const [other] = await db.insert(organizations).values({ name: "Other" }).returning();
    const analytics = await getAnalytics(db, { organizationId: other!.id, days: 90, now });
    expect(analytics.totals).toEqual({ reviews: 0, tokensIn: 0, tokensOut: 0 });
    expect(analytics.byProfile).toEqual([]);
    expect(Object.values(analytics.reviewsByStatus).every((n) => n === 0)).toBe(true);
    expect(Object.values(analytics.findingsBySeverity).every((n) => n === 0)).toBe(true);
    expect(analytics.dismissalsByRepository).toEqual([]);
    expect(analytics.jobsByAgent).toEqual([]);
    // Another organization's repository as the filter doesn't widen it either.
    expect(
      (await getAnalytics(db, { organizationId: other!.id, days: 90, now, repositoryId: repoA }))
        .totals.reviews,
    ).toBe(0);
    expect(await listAnalyticsRepositories(db, other!.id)).toEqual([]);
  });
});
