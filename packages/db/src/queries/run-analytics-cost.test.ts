// Run analytics' cost: the list price of the same token-bearing attempts as the tokens.
import { randomBytes, randomUUID } from "node:crypto";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "../../testing/index.js";
import type { ModelTokenUsage } from "@omniralph/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attemptModelUsageRows } from "../attempt-usage.js";
import { closeDb, createDb, type Database } from "../client.js";
import { connectRepository, upsertScmConnection } from "../repositories.js";
import {
  attemptModelUsage,
  jobs,
  modelPrices,
  organizations,
  ralphRuns,
  reviewRuns,
  reviews,
} from "../schema.js";
import { getRunAnalytics } from "./run-analytics.js";

const databaseAvailable = testDatabaseAvailable();
const now = new Date("2026-10-05T12:00:00Z");

const usage = (model: string, canonicalModel: string | null): ModelTokenUsage => ({
  model,
  canonicalModel,
  inputTokens: 1_000_000,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheWrite1hInputTokens: 0,
  outputTokens: 100_000,
  largestRequestInputTokens: 50_000,
  fastMode: false,
});
// 1M input + 100k output at $4/M and $20/M; Haiku at $1/M and $5/M.
const OPUS_COST = 4 + 2;
const HAIKU_COST = 1 + 0.5;

describe.skipIf(!databaseAvailable)("run analytics cost", () => {
  let testDb: TestDatabase;
  let db: Database;
  let acme: string;
  let idle: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [acmeOrg, idleOrg] = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Idle" }])
      .returning();
    acme = acmeOrg!.id;
    idle = idleOrg!.id;
    const connection = (await upsertScmConnection(
      db,
      {
        organizationId: acme,
        provider: "github",
        name: "app",
        baseUrl: "https://api.github.com",
        externalId: "installation-1",
        credentials: {},
      },
      randomBytes(32),
    ))!;
    const repo = (
      await connectRepository(db, {
        connectionId: connection.id,
        provider: "github",
        externalId: "1",
        fullPath: "acme/api",
      })
    ).id;

    await db.insert(modelPrices).values(
      [
        ["anthropic/claude-opus-5.5", "0.000004", "0.00002"],
        ["anthropic/claude-haiku-4.5", "0.000001", "0.000005"],
      ].map(([modelId, inputUsd, outputUsd]) => ({
        modelId: modelId!,
        name: modelId!,
        inputUsd: inputUsd!,
        outputUsd: outputUsd!,
        cacheReadUsd: "0",
        cacheWriteUsd: "0",
        validFrom: new Date("2026-01-01T00:00:00Z"),
        checkedAt: now,
      })),
    );

    const runId = randomUUID();
    await db.insert(ralphRuns).values({
      id: runId,
      organizationId: acme,
      trackerIssueId: runId,
      trackerIdentifier: "ENG-1",
      trackerSessionId: runId,
      kind: "children",
      mode: "epic",
      repositoryId: repo,
      status: "completed",
      createdAt: new Date("2026-10-04T00:00:00Z"),
    });
    const [reviewRun] = await db
      .insert(reviewRuns)
      .values({
        organizationId: acme,
        repositoryId: repo,
        prNumber: 1,
        headSha: "a".repeat(40),
        baseSha: "b".repeat(40),
        trigger: "webhook",
        mode: "incremental",
        status: "completed",
        createdAt: new Date("2026-10-05T05:00:00Z"),
      })
      .returning();
    const [review] = await db
      .insert(reviews)
      .values({
        repositoryId: repo,
        reviewRunId: reviewRun!.id,
        prNumber: 1,
        headSha: "a".repeat(40),
        baseSha: "b".repeat(40),
        trigger: "webhook",
        status: "completed",
        depth: "standard",
        budget: 2_000_000,
        tokensIn: 1_000_000,
        tokensOut: 100_000,
        createdAt: new Date("2026-10-05T05:00:00Z"),
      })
      .returning();

    const job = (
      createdAt: string,
      byModel: ModelTokenUsage[] | null,
      tokens = true,
      extra: Partial<typeof jobs.$inferInsert> = {},
    ) => ({
      id: randomUUID(),
      organizationId: acme,
      repositoryId: repo,
      type: "ralph.story",
      taskType: "coding" as const,
      status: "completed" as const,
      ralphRunId: runId,
      result: tokens
        ? {
            usage: {
              inputTokens: 1_000_000,
              outputTokens: 100_000,
              ...(byModel && { byModel }),
            },
          }
        : null,
      createdAt: new Date(createdAt),
      finishedAt: new Date(createdAt),
      ...extra,
    });
    const rows = [
      // Oct 5: priced, unpriced (an alias), and one without tokens.
      job("2026-10-05T01:00:00Z", [usage("claude-opus-5-5", "claude-opus-5-5")]),
      job("2026-10-05T02:00:00Z", [usage("opus", null)]),
      job("2026-10-05T03:00:00Z", null, false),
      // Oct 4: tokens from before usage per model (no rows).
      job("2026-10-04T01:00:00Z", null),
      // The review's task, priced.
      job("2026-10-05T05:00:00Z", [usage("claude-haiku-4-5-20251001", "claude-haiku-4-5")], true, {
        type: "review.task",
        taskType: "review",
        ralphRunId: null,
        reviewRunId: reviewRun!.id,
        payload: { trigger: { context: { reviewId: review!.id } } },
      }),
    ];
    await db.insert(jobs).values(rows);
    await db
      .insert(attemptModelUsage)
      .values(rows.flatMap((row) => attemptModelUsageRows(row.id, row.result)));
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  it("sums priced attempts, counting the token-bearing ones left out", async () => {
    const analytics = await getRunAnalytics(db, {
      organizationIds: [acme],
      days: 7,
      bucket: "day",
      now,
    });
    const expected = {
      costUsd: OPUS_COST + HAIKU_COST,
      unpricedAttempts: 2,
      tokens: {
        epic: { tokensIn: 3_000_000, tokensOut: 300_000, costUsd: OPUS_COST, unpricedAttempts: 2 },
        review: { tokensIn: 1_000_000, tokensOut: 100_000, costUsd: HAIKU_COST },
        request: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
        triage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
        ask: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      },
    };
    expect(analytics.totals).toMatchObject(expected);
    expect(analytics.byRepository[0]).toMatchObject(expected);
    expect(analytics.byOrganization[0]).toMatchObject(expected);

    const day = (start: string) => analytics.buckets.find((b) => b.start === start)!;
    expect(day("2026-10-05")).toMatchObject({
      costUsd: OPUS_COST + HAIKU_COST,
      unpricedAttempts: 1,
      tokens: { epic: { costUsd: OPUS_COST, unpricedAttempts: 1 } },
    });
    // Token-bearing attempts, none priced: no figure, and nothing left out to count.
    const oct4 = day("2026-10-04");
    expect(oct4.costUsd).toBeUndefined();
    expect(oct4.unpricedAttempts).toBeUndefined();
    expect(oct4.tokens.epic).toEqual({ tokensIn: 1_000_000, tokensOut: 100_000 });
    // No token-bearing attempts: 0.
    expect(day("2026-10-03")).toMatchObject({ costUsd: 0 });
    expect(day("2026-10-03").unpricedAttempts).toBeUndefined();
  });

  it("leaves the totals without a cost when the window has no priced attempt", async () => {
    const analytics = await getRunAnalytics(db, {
      organizationIds: [idle],
      days: 7,
      bucket: "day",
      now,
    });
    expect(analytics.totals.costUsd).toBeUndefined();
    expect(analytics.buckets.every((b) => b.costUsd === 0)).toBe(true);

    const beforeCost = await getRunAnalytics(db, {
      organizationIds: [acme],
      days: 7,
      bucket: "day",
      now: new Date("2026-10-04T12:00:00Z"),
    });
    expect(beforeCost.totals.costUsd).toBeUndefined();
    expect(beforeCost.totals.unpricedAttempts).toBeUndefined();
    expect(beforeCost.totals.tokens.epic.tokensIn).toBe(1_000_000);
  });
});
