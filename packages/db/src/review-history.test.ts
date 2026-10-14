import { randomBytes, randomUUID } from "node:crypto";
import { createTestDatabase, testDatabaseAvailable, type TestDatabase } from "../testing/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Database } from "./client.js";
import { connectRepository, upsertScmConnection } from "./repositories.js";
import { emptyFindingCounts, getReviewDetail, listReviews } from "./review-history.js";
import { harnesses, findings, reviews, organizations } from "./schema.js";
import { seedReviewProfiles } from "./settings.js";

const databaseAvailable = testDatabaseAvailable();

const key = randomBytes(32);

describe.skipIf(!databaseAvailable)("review history queries", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let repoId: string;
  let otherRepoId: string;
  let harnessId: string;
  /** Review IDs of `repoId`, newest first. */
  const newestFirst: string[] = [];

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    await seedReviewProfiles(db, org!.id);
    orgId = org!.id;

    const connection = (await upsertScmConnection(
      db,
      {
        organizationId: orgId,
        provider: "gitlab",
        name: "bot",
        baseUrl: "https://gitlab.example.com",
        externalId: "g",
        credentials: {},
      },
      key,
    ))!;
    const repo = await connectRepository(db, {
      connectionId: connection.id,
      provider: "gitlab",
      externalId: "1",
      fullPath: "acme/api",
    });
    const other = await connectRepository(db, {
      connectionId: connection.id,
      provider: "gitlab",
      externalId: "2",
      fullPath: "acme/web",
    });
    repoId = repo.id;
    otherRepoId = other.id;
    const [agent] = await db
      .insert(harnesses)
      .values({ organizationId: orgId, name: "coder-1" })
      .returning();
    harnessId = agent!.id;

    // 30 reviews of `repoId`: every third is a mention, every fifth failed.
    const base = Date.parse("2026-10-01T00:00:00Z");
    const rows = Array.from({ length: 30 }, (_, i) => ({
      id: randomUUID(),
      repositoryId: repoId,
      prNumber: i + 1,
      prTitle: `PR ${i + 1}`,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      trigger: i % 3 === 0 ? ("mention" as const) : ("webhook" as const),
      status: i % 5 === 0 ? ("failed" as const) : ("completed" as const),
      error: i % 5 === 0 ? "boom" : null,
      profileId: "standard",
      harnessId,
      budget: 200_000,
      tokensIn: 1000 + i,
      tokensOut: 100,
      durationMs: 5000,
      createdAt: new Date(base + i * 60_000),
    }));
    await db.insert(reviews).values(rows);
    newestFirst.push(...rows.map((r) => r.id).reverse());
    await db.insert(reviews).values({
      repositoryId: otherRepoId,
      prNumber: 99,
      headSha: "c".repeat(40),
      baseSha: "d".repeat(40),
      trigger: "webhook",
      budget: 1,
      createdAt: new Date(base + 3_600_000),
    });

    const finding = (reviewId: string, severity: "critical" | "low", n: number) => ({
      reviewId,
      path: `src/f${n}.ts`,
      startLine: n,
      endLine: n + 2,
      severity,
      category: "bug",
      title: `Finding ${n}`,
      body: "Body",
      confidence: 0.9,
      createdAt: new Date(base + n),
    });
    await db
      .insert(findings)
      .values([
        finding(newestFirst[0]!, "critical", 1),
        finding(newestFirst[0]!, "low", 2),
        finding(newestFirst[0]!, "low", 3),
        finding(newestFirst[1]!, "critical", 4),
      ]);
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  it("pages a repository's reviews newest first, 25 per page", async () => {
    const first = await listReviews(db, { organizationId: orgId, repositoryId: repoId });
    expect(first).toMatchObject({ total: 30, page: 1, pageSize: 25 });
    expect(first.reviews.map((r) => r.id)).toEqual(newestFirst.slice(0, 25));

    const second = await listReviews(db, { organizationId: orgId, repositoryId: repoId, page: 2 });
    expect(second).toMatchObject({ total: 30, page: 2 });
    expect(second.reviews.map((r) => r.id)).toEqual(newestFirst.slice(25));

    const past = await listReviews(db, { organizationId: orgId, repositoryId: repoId, page: 9 });
    expect(past).toMatchObject({ total: 30, page: 9, reviews: [] });

    // Invalid page numbers fall back to the first page.
    expect(
      (await listReviews(db, { organizationId: orgId, repositoryId: repoId, page: 0 })).page,
    ).toBe(1);
  });

  it("returns the row's PR, repository, profile, agent, usage and per-severity counts", async () => {
    const { reviews: rows } = await listReviews(db, {
      organizationId: orgId,
      repositoryId: repoId,
      pageSize: 2,
    });
    expect(rows[0]).toMatchObject({
      prNumber: 30,
      prTitle: "PR 30",
      trigger: "webhook",
      status: "completed",
      repository: {
        id: repoId,
        provider: "gitlab",
        fullPath: "acme/api",
        baseUrl: "https://gitlab.example.com",
      },
      profile: { id: "standard", name: "Standard" },
      agent: { id: harnessId, name: "coder-1" },
      tokensIn: 1029,
      tokensOut: 100,
      budget: 200_000,
      durationMs: 5000,
      findingCounts: { ...emptyFindingCounts(), critical: 1, low: 2 },
    });
    expect(rows[1]!.findingCounts).toEqual({ ...emptyFindingCounts(), critical: 1 });
  });

  it("filters by status and trigger, alone and combined", async () => {
    const failed = await listReviews(db, {
      organizationId: orgId,
      repositoryId: repoId,
      status: "failed",
    });
    expect(failed.total).toBe(6);
    expect(failed.reviews.every((r) => r.status === "failed" && r.error === "boom")).toBe(true);

    const mentions = await listReviews(db, {
      organizationId: orgId,
      repositoryId: repoId,
      trigger: "mention",
    });
    expect(mentions.total).toBe(10);
    expect(mentions.reviews.every((r) => r.trigger === "mention")).toBe(true);

    // i % 15 === 0: reviews 1 and 16.
    const both = await listReviews(db, {
      organizationId: orgId,
      repositoryId: repoId,
      status: "failed",
      trigger: "mention",
    });
    expect(both.reviews.map((r) => r.prNumber)).toEqual([16, 1]);

    const filteredPage = await listReviews(db, {
      organizationId: orgId,
      repositoryId: repoId,
      trigger: "webhook",
      pageSize: 15,
      page: 2,
    });
    expect(filteredPage.total).toBe(20);
    expect(filteredPage.reviews).toHaveLength(5);
  });

  it("lists every repository without a repository filter", async () => {
    const all = await listReviews(db, { organizationId: orgId });
    expect(all.total).toBe(31);
    expect(all.reviews[0]).toMatchObject({
      prNumber: 99,
      prTitle: null,
      repository: { id: otherRepoId },
      agent: null,
      status: "queued",
    });
  });

  it("loads a review's detail with its findings in order", async () => {
    const detail = await getReviewDetail(db, orgId, newestFirst[0]!);
    expect(detail).toMatchObject({
      review: { id: newestFirst[0], prNumber: 30, model: null },
      repository: { id: repoId, fullPath: "acme/api" },
      profile: { id: "standard", name: "Standard" },
      agent: { id: harnessId, name: "coder-1" },
    });
    expect(detail!.findings.map((f) => f.title)).toEqual(["Finding 1", "Finding 2", "Finding 3"]);
    expect(await getReviewDetail(db, orgId, randomUUID())).toBeNull();
  });

  it("hides the reviews from other organizations", async () => {
    const [other] = await db.insert(organizations).values({ name: "Other" }).returning();
    const otherId = other!.id;
    expect(await listReviews(db, { organizationId: otherId })).toMatchObject({
      reviews: [],
      total: 0,
    });
    expect(await listReviews(db, { organizationId: otherId, repositoryId: repoId })).toMatchObject({
      reviews: [],
      total: 0,
    });
    expect(await getReviewDetail(db, otherId, newestFirst[0]!)).toBeNull();
  });
});
