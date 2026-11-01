import { randomBytes, randomUUID } from "node:crypto";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "../../testing/index.js";
import { legacyJobRouting } from "@omniralph/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Database } from "../client.js";
import { connectRepository, upsertScmConnection } from "../repositories.js";
import {
  chatConnections,
  chatThreadRuns,
  chatThreads,
  jobs,
  organizations,
  ralphRuns,
  ralphStories,
  reviewRuns,
  reviews,
  triageRuns,
} from "../schema.js";
import {
  analyticsWindow,
  getRunAnalytics,
  listAnalyticsRepositories,
  runAnalyticsBucketStarts,
} from "./run-analytics.js";

const databaseAvailable = testDatabaseAvailable();

const key = randomBytes(32);
// A Monday: the 7-day window is Tue 2026-09-29 to Mon 2026-10-05.
const now = new Date("2026-10-05T12:00:00Z");

// No token-bearing attempts: their cost is 0.
const zeroTokens = { tokensIn: 0, tokensOut: 0, costUsd: 0 };
const noTokens = {
  epic: zeroTokens,
  request: zeroTokens,
  review: zeroTokens,
  triage: zeroTokens,
  ask: zeroTokens,
};

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

describe("runAnalyticsBucketStarts", () => {
  it("lists every day, or every Monday-started week overlapping the window", () => {
    const from = new Date("2026-09-29T00:00:00Z");
    const to = new Date("2026-10-06T00:00:00Z");
    expect(runAnalyticsBucketStarts(from, to, "day")).toEqual([
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
      "2026-10-05",
    ]);
    expect(runAnalyticsBucketStarts(from, to, "week")).toEqual(["2026-09-28", "2026-10-05"]);
    // A window starting on a Monday doesn't reach back a week.
    expect(runAnalyticsBucketStarts(new Date("2026-09-28T00:00:00Z"), to, "week")).toEqual([
      "2026-09-28",
      "2026-10-05",
    ]);
  });
});

describe.skipIf(!databaseAvailable)("run analytics queries", () => {
  let testDb: TestDatabase;
  let db: Database;
  let acme: string;
  let beta: string;
  let repoA: string;
  let repoB: string;
  let repoC: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [acmeOrg, betaOrg] = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Beta" }])
      .returning();
    acme = acmeOrg!.id;
    beta = betaOrg!.id;

    const connect = async (organizationId: string, externalId: string, fullPath: string) => {
      const connection = (await upsertScmConnection(
        db,
        {
          organizationId,
          provider: "github",
          name: `app-${externalId}`,
          baseUrl: "https://api.github.com",
          externalId: `installation-${externalId}`,
          credentials: {},
        },
        key,
      ))!;
      return (
        await connectRepository(db, {
          connectionId: connection.id,
          provider: "github",
          externalId,
          fullPath,
        })
      ).id;
    };
    repoA = await connect(acme, "1", "acme/api");
    repoB = await connect(acme, "2", "acme/web");
    repoC = await connect(beta, "3", "beta/app");

    const run = (
      organizationId: string,
      repositoryId: string,
      mode: "epic" | "request",
      createdAt: string,
      status: (typeof ralphRuns.$inferInsert)["status"],
    ) => {
      const id = randomUUID();
      return {
        id,
        organizationId,
        trackerIssueId: id,
        trackerIdentifier: "ENG-1",
        trackerSessionId: id,
        kind: "children" as const,
        mode,
        repositoryId,
        status,
        createdAt: new Date(createdAt),
      };
    };
    const e1 = run(acme, repoA, "epic", "2026-10-05T01:00:00Z", "completed");
    const q1 = run(acme, repoA, "request", "2026-10-04T10:00:00Z", "failed");
    const e2 = run(acme, repoB, "epic", "2026-10-02T12:00:00Z", "running");
    // Before the 7-day window.
    const e0 = run(acme, repoA, "epic", "2026-09-28T23:59:59Z", "completed");
    const c1 = run(beta, repoC, "epic", "2026-10-04T08:00:00Z", "completed");
    await db.insert(ralphRuns).values([e1, q1, e2, e0, c1]);

    const story = (runId: string, status: (typeof ralphStories.$inferInsert)["status"]) => {
      const id = randomUUID();
      return { runId, trackerIssueId: id, identifier: "ENG-2", title: "S", status, attempts: 1 };
    };
    await db
      .insert(ralphStories)
      .values([
        story(e1.id, "completed"),
        story(e1.id, "completed"),
        story(e1.id, "exhausted"),
        story(e2.id, "completed"),
        story(e2.id, "pending"),
        story(e0.id, "completed"),
        story(c1.id, "completed"),
      ]);

    const [rr1, rr2] = await db
      .insert(reviewRuns)
      .values([
        {
          organizationId: acme,
          repositoryId: repoA,
          prNumber: 1,
          headSha: "a".repeat(40),
          baseSha: "b".repeat(40),
          trigger: "webhook" as const,
          mode: "incremental" as const,
          status: "completed" as const,
          createdAt: new Date("2026-10-05T05:00:00Z"),
        },
        {
          organizationId: acme,
          repositoryId: repoB,
          prNumber: 2,
          headSha: "c".repeat(40),
          baseSha: "d".repeat(40),
          trigger: "webhook" as const,
          mode: "incremental" as const,
          status: "completed" as const,
          createdAt: new Date("2026-10-01T05:00:00Z"),
        },
      ])
      .returning();
    const review = (
      repositoryId: string,
      reviewRunId: string,
      createdAt: string,
      tokensIn: number,
      tokensOut: number,
    ) => ({
      repositoryId,
      reviewRunId,
      prNumber: 1,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      trigger: "webhook" as const,
      status: "completed" as const,
      depth: "standard" as const,
      budget: 200_000,
      tokensIn,
      tokensOut,
      createdAt: new Date(createdAt),
    });
    await db
      .insert(reviews)
      .values([
        review(repoA, rr1!.id, "2026-10-05T05:00:00Z", 1000, 200),
        review(repoB, rr2!.id, "2026-10-01T05:00:00Z", 300, 30),
      ]);

    const [t1] = await db
      .insert(triageRuns)
      .values({
        organizationId: acme,
        trackerIssueId: "triage-issue",
        trackerSessionId: "triage-session",
        trigger: "mention",
        status: "completed",
        createdAt: new Date("2026-10-03T09:00:00Z"),
      })
      .returning();

    // Coding runs' jobs are coding and query tasks, not legacy job types.
    const CODING_RUN_TASK_TYPES: Record<string, { taskType: "coding" | "query" }> = {
      "ralph.story": { taskType: "coding" },
      "ralph.request": { taskType: "coding" },
      "ralph.describe-pr": { taskType: "query" },
    };
    const job = (
      organizationId: string,
      repositoryId: string | null,
      type: string,
      status: NonNullable<(typeof jobs.$inferInsert)["status"]>,
      createdAt: string,
      link: Partial<Pick<typeof jobs.$inferInsert, "ralphRunId" | "reviewRunId" | "triageRunId">>,
      usage?: [number, number],
      finishedAt: string = createdAt,
    ) => ({
      id: randomUUID(),
      organizationId,
      type,
      ...(type.startsWith("review.")
        ? { taskType: "review" as const }
        : (CODING_RUN_TASK_TYPES[type] ?? legacyJobRouting(type))),
      repositoryId,
      status,
      ...link,
      result: usage ? { usage: { inputTokens: usage[0], outputTokens: usage[1] } } : null,
      createdAt: new Date(createdAt),
      finishedAt: ["queued", "running"].includes(status) ? null : new Date(finishedAt),
    });
    const ask = job(acme, null, "chat.ask", "completed", "2026-10-05T06:00:00Z", {}, [500, 50]);
    await db.insert(jobs).values([
      job(
        acme,
        repoA,
        "ralph.story",
        "completed",
        "2026-10-05T02:00:00Z",
        { ralphRunId: e1.id },
        [100, 10],
      ),
      job(
        acme,
        repoA,
        "ralph.story",
        "failed",
        "2026-10-05T03:00:00Z",
        { ralphRunId: e1.id },
        [200, 20],
      ),
      job(
        acme,
        repoA,
        "ralph.describe-pr",
        "completed",
        "2026-10-05T04:00:00Z",
        { ralphRunId: e1.id },
        [1000, 100],
      ),
      job(
        acme,
        repoA,
        "ralph.request",
        "expired",
        "2026-10-04T10:00:00Z",
        { ralphRunId: q1.id },
        [400, 40],
        "2026-10-04T11:00:00Z",
      ),
      job(acme, repoA, "ralph.request", "canceled", "2026-10-04T12:00:00Z", { ralphRunId: q1.id }),
      job(
        acme,
        repoB,
        "ralph.story",
        "completed",
        "2026-10-02T12:00:00Z",
        { ralphRunId: e2.id },
        [3000, 300],
      ),
      job(acme, repoB, "ralph.story", "running", "2026-10-05T07:00:00Z", { ralphRunId: e2.id }),
      // Outside the window.
      job(
        acme,
        repoA,
        "ralph.story",
        "completed",
        "2026-09-28T23:59:59Z",
        { ralphRunId: e0.id },
        [9000, 900],
      ),
      // A ralph job with no run: its tokens count (as epic), it isn't an attempt.
      job(acme, repoA, "ralph.prepare", "completed", "2026-10-03T00:00:00Z", {}, [50, 5]),
      // Review attempts: their tokens are the reviews'.
      job(
        acme,
        repoA,
        "review.task",
        "completed",
        "2026-10-05T05:00:00Z",
        { reviewRunId: rr1!.id },
        [7777, 777],
      ),
      job(acme, repoA, "review.correlate", "failed", "2026-10-05T05:30:00Z", {
        reviewRunId: rr1!.id,
      }),
      job(acme, repoB, "review.task", "skipped", "2026-10-01T05:00:00Z", { reviewRunId: rr2!.id }),
      // Triage attempts, without a repository; the failed one finished the next day.
      job(
        acme,
        null,
        "triage.run",
        "completed",
        "2026-10-03T09:00:00Z",
        { triageRunId: t1!.id },
        [700, 70],
      ),
      job(
        acme,
        null,
        "triage.run",
        "failed",
        "2026-10-03T23:00:00Z",
        { triageRunId: t1!.id },
        [10, 1],
        "2026-10-04T01:00:00Z",
      ),
      ask,
      // System work isn't a run's attempt.
      job(acme, repoA, "repo.sync", "failed", "2026-10-05T08:00:00Z", {}),
      job(
        beta,
        repoC,
        "ralph.story",
        "completed",
        "2026-10-04T09:00:00Z",
        { ralphRunId: c1.id },
        [5, 1],
      ),
    ]);

    const [connection] = await db
      .insert(chatConnections)
      .values({ organizationId: acme, platform: "slack", externalId: "T1", name: "Acme" })
      .returning();
    const [thread] = await db
      .insert(chatThreads)
      .values({
        organizationId: acme,
        connectionId: connection!.id,
        platform: "slack",
        externalThreadId: "thread-1",
        channelId: "C1",
        startedByExternalUserId: "U1",
      })
      .returning();
    const [threadRun] = await db
      .insert(chatThreadRuns)
      .values({
        organizationId: acme,
        chatThreadId: thread!.id,
        kind: "query",
        jobId: ask.id,
      })
      .returning();
    await db.update(jobs).set({ chatThreadRunId: threadRun!.id }).where(eq(jobs.id, ask.id));
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  it("totals stories, review runs, attempts and tokens by run kind, triage and asks included", async () => {
    const analytics = await getRunAnalytics(db, {
      organizationIds: [acme],
      days: 7,
      bucket: "day",
      now,
    });
    expect(analytics.from.toISOString()).toBe("2026-09-29T00:00:00.000Z");
    expect(analytics.to.toISOString()).toBe("2026-10-06T00:00:00.000Z");
    expect(analytics.totals).toEqual({
      stories: 3,
      reviewRuns: 2,
      // Ralph: 3 + 2 + 1, review: 2 + 1, triage: 2, ask: 1.
      attempts: { finished: 12, completed: 6, failed: 3, expired: 1, successRate: 0.6 },
      tokens: {
        epic: { tokensIn: 4350, tokensOut: 435 },
        request: { tokensIn: 400, tokensOut: 40 },
        review: { tokensIn: 1300, tokensOut: 230 },
        triage: { tokensIn: 710, tokensOut: 71 },
        ask: { tokensIn: 500, tokensOut: 50 },
      },
    });
  });

  it("returns every day of the window, zero-filled", async () => {
    const { buckets } = await getRunAnalytics(db, {
      organizationIds: [acme],
      days: 7,
      bucket: "day",
      now,
    });
    expect(buckets.map((b) => b.start)).toEqual([
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
      "2026-10-05",
    ]);
    const empty = {
      stories: 0,
      reviewRuns: 0,
      attempts: { finished: 0, completed: 0, failed: 0, expired: 0, successRate: null },
      tokens: noTokens,
      costUsd: 0,
    };
    expect(buckets[0]).toEqual({ start: "2026-09-29", ...empty });
    expect(buckets[1]).toEqual({ start: "2026-09-30", ...empty });
    // Triage: tokens on the day each job was created, attempts on the day it finished.
    expect(buckets[4]).toMatchObject({
      start: "2026-10-03",
      attempts: { finished: 1, completed: 1, successRate: 1 },
      tokens: { triage: { tokensIn: 710, tokensOut: 71 }, epic: { tokensIn: 50, tokensOut: 5 } },
    });
    expect(buckets[5]).toMatchObject({
      start: "2026-10-04",
      // Expired request, canceled request, failed triage.
      attempts: { finished: 3, completed: 0, failed: 1, expired: 1, successRate: 0 },
      tokens: { request: { tokensIn: 400, tokensOut: 40 }, triage: zeroTokens },
    });
    expect(buckets[6]).toMatchObject({
      start: "2026-10-05",
      stories: 2,
      reviewRuns: 1,
      tokens: { ask: { tokensIn: 500, tokensOut: 50 }, review: { tokensIn: 1000, tokensOut: 200 } },
    });
  });

  it("groups by Monday-started UTC weeks, counting only the window", async () => {
    const { buckets, totals } = await getRunAnalytics(db, {
      organizationIds: [acme],
      days: 7,
      bucket: "week",
      now,
    });
    expect(buckets.map((b) => b.start)).toEqual(["2026-09-28", "2026-10-05"]);
    // The run of 2026-09-28 is in the first week but not in the window.
    expect(buckets[0]).toMatchObject({ stories: 1, reviewRuns: 1 });
    expect(buckets[1]).toMatchObject({ stories: 2, reviewRuns: 1 });
    expect(buckets[0]!.stories + buckets[1]!.stories).toBe(totals.stories);
  });

  /**
   * The story and token figures the old Analytics queries (`getRalphAnalytics`,
   * `getAnalytics`) returned for this seed, captured before they were deleted, so the
   * definitions stay pinned: stories = completed stories of epic and request runs started in
   * the window; epic + request tokens = `ralph.*` jobs' usage by the job's creation; review
   * tokens = the reviews' tokens by the review's creation. 30 and 90 days add the run and
   * job of 2026-09-28. Each day lists `[stories, epic + request tokens in, review tokens in]`;
   * every other day of the window is zero.
   */
  const LEGACY_FIGURES: Record<
    "all" | "repoA" | "repoB",
    Record<
      "week" | "month",
      {
        stories: number;
        ralph: { tokensIn: number; tokensOut: number };
        review: { tokensIn: number; tokensOut: number };
        daily: Record<string, [number, number, number]>;
      }
    >
  > = {
    all: {
      week: {
        stories: 3,
        ralph: { tokensIn: 4750, tokensOut: 475 },
        review: { tokensIn: 1300, tokensOut: 230 },
        daily: {
          "2026-10-01": [0, 0, 300],
          "2026-10-02": [1, 3000, 0],
          "2026-10-03": [0, 50, 0],
          "2026-10-04": [0, 400, 0],
          "2026-10-05": [2, 1300, 1000],
        },
      },
      month: {
        stories: 4,
        ralph: { tokensIn: 13750, tokensOut: 1375 },
        review: { tokensIn: 1300, tokensOut: 230 },
        daily: {
          "2026-09-28": [1, 9000, 0],
          "2026-10-01": [0, 0, 300],
          "2026-10-02": [1, 3000, 0],
          "2026-10-03": [0, 50, 0],
          "2026-10-04": [0, 400, 0],
          "2026-10-05": [2, 1300, 1000],
        },
      },
    },
    repoA: {
      week: {
        stories: 2,
        ralph: { tokensIn: 1750, tokensOut: 175 },
        review: { tokensIn: 1000, tokensOut: 200 },
        daily: {
          "2026-10-03": [0, 50, 0],
          "2026-10-04": [0, 400, 0],
          "2026-10-05": [2, 1300, 1000],
        },
      },
      month: {
        stories: 3,
        ralph: { tokensIn: 10750, tokensOut: 1075 },
        review: { tokensIn: 1000, tokensOut: 200 },
        daily: {
          "2026-09-28": [1, 9000, 0],
          "2026-10-03": [0, 50, 0],
          "2026-10-04": [0, 400, 0],
          "2026-10-05": [2, 1300, 1000],
        },
      },
    },
    repoB: {
      week: {
        stories: 1,
        ralph: { tokensIn: 3000, tokensOut: 300 },
        review: { tokensIn: 300, tokensOut: 30 },
        daily: { "2026-10-01": [0, 0, 300], "2026-10-02": [1, 3000, 0] },
      },
      month: {
        stories: 1,
        ralph: { tokensIn: 3000, tokensOut: 300 },
        review: { tokensIn: 300, tokensOut: 30 },
        daily: { "2026-10-01": [0, 0, 300], "2026-10-02": [1, 3000, 0] },
      },
    },
  };

  it("keeps the old Analytics page's story and token figures for each window and repo", async () => {
    for (const days of [7, 30, 90] as const) {
      for (const [name, repositoryId] of [
        ["all", undefined],
        ["repoA", repoA],
        ["repoB", repoB],
      ] as const) {
        const expected = LEGACY_FIGURES[name][days === 7 ? "week" : "month"];
        const runs = await getRunAnalytics(db, {
          organizationIds: [acme],
          days,
          repositoryId,
          bucket: "day",
          now,
        });
        const { tokens, stories } = runs.totals;
        expect(stories).toBe(expected.stories);
        expect({
          tokensIn: tokens.epic.tokensIn + tokens.request.tokensIn,
          tokensOut: tokens.epic.tokensOut + tokens.request.tokensOut,
        }).toEqual(expected.ralph);
        expect(tokens.review).toEqual(expected.review);
        // Day by day too.
        expect(runs.buckets).toHaveLength(days);
        for (const bucket of runs.buckets) {
          const [dayStories, ralphIn, reviewIn] = expected.daily[bucket.start] ?? [0, 0, 0];
          expect(bucket.stories, bucket.start).toBe(dayStories);
          expect(bucket.tokens.epic.tokensIn + bucket.tokens.request.tokensIn, bucket.start).toBe(
            ralphIn,
          );
          expect(bucket.tokens.review.tokensIn, bucket.start).toBe(reviewIn);
        }
      }
    }
  });

  it("totals per repository, and filters by one", async () => {
    const analytics = await getRunAnalytics(db, {
      organizationIds: [acme],
      days: 7,
      bucket: "day",
      now,
    });
    expect(analytics.byRepository.map((r) => r.repository.fullPath)).toEqual([
      "acme/api",
      "acme/web",
    ]);
    expect(analytics.byRepository[0]).toMatchObject({
      repository: { id: repoA, provider: "github", fullPath: "acme/api" },
      organization: { id: acme, name: "Acme" },
      stories: 2,
      reviewRuns: 1,
      attempts: { finished: 7, completed: 3, failed: 2, expired: 1, successRate: 0.5 },
      tokens: { epic: { tokensIn: 1350 }, review: { tokensIn: 1000 }, triage: zeroTokens },
    });
    expect(analytics.byRepository[1]).toMatchObject({
      repository: { id: repoB },
      stories: 1,
      attempts: { finished: 2, completed: 1, successRate: 1 },
    });

    const filtered = await getRunAnalytics(db, {
      organizationIds: [acme],
      days: 7,
      bucket: "day",
      repositoryId: repoB,
      now,
    });
    expect(filtered.totals).toMatchObject({ stories: 1, reviewRuns: 1 });
    expect(filtered.totals.tokens.triage).toEqual(zeroTokens);
    expect(filtered.byRepository.map((r) => r.repository.id)).toEqual([repoB]);
  });

  it("totals per organization, and keeps organizations apart", async () => {
    const both = await getRunAnalytics(db, {
      organizationIds: [beta, acme],
      days: 7,
      bucket: "day",
      now,
    });
    expect(both.byOrganization.map((o) => o.organization)).toEqual([
      { id: acme, name: "Acme" },
      { id: beta, name: "Beta" },
    ]);
    expect(both.byOrganization[1]).toMatchObject({
      stories: 1,
      attempts: { finished: 1, completed: 1 },
      tokens: { epic: { tokensIn: 5, tokensOut: 1 } },
    });
    expect(both.totals.stories).toBe(4);
    expect(both.byRepository.map((r) => [r.repository.fullPath, r.organization.name])).toEqual([
      ["acme/api", "Acme"],
      ["acme/web", "Acme"],
      ["beta/app", "Beta"],
    ]);

    const betaOnly = await getRunAnalytics(db, {
      organizationIds: [beta],
      days: 7,
      bucket: "day",
      now,
    });
    expect(betaOnly.totals).toMatchObject({ stories: 1, reviewRuns: 0 });
    expect(betaOnly.byRepository.map((r) => r.repository.id)).toEqual([repoC]);
    // Acme's repository as the filter finds nothing of Beta's.
    const crossed = await getRunAnalytics(db, {
      organizationIds: [beta],
      days: 7,
      bucket: "day",
      repositoryId: repoA,
      now,
    });
    expect(crossed.totals).toEqual({
      stories: 0,
      reviewRuns: 0,
      attempts: { finished: 0, completed: 0, failed: 0, expired: 0, successRate: null },
      tokens: noTokens,
    });
  });

  it("lists every repository of the scope with its organization, active or not", async () => {
    const [idle] = await db
      .insert(organizations)
      .values({ name: "Idle" })
      .returning({ id: organizations.id });
    expect(await listAnalyticsRepositories(db, [beta, acme])).toEqual([
      {
        id: repoA,
        provider: "github",
        fullPath: "acme/api",
        organization: { id: acme, name: "Acme" },
      },
      {
        id: repoB,
        provider: "github",
        fullPath: "acme/web",
        organization: { id: acme, name: "Acme" },
      },
      {
        id: repoC,
        provider: "github",
        fullPath: "beta/app",
        organization: { id: beta, name: "Beta" },
      },
    ]);
    expect((await listAnalyticsRepositories(db, [beta])).map((r) => r.id)).toEqual([repoC]);
    expect(await listAnalyticsRepositories(db, [idle!.id])).toEqual([]);
    expect(await listAnalyticsRepositories(db, [])).toEqual([]);
  });
});
