// Attempts' usage per model (stored by `completeJob`) and their list prices (`attempt_costs`).
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "../../testing/index.js";
import type { ModelTokenUsage } from "@omniralph/shared";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { attemptModelUsageRows } from "../attempt-usage.js";
import { closeDb, createDb, type Database } from "../client.js";
import { completeJob } from "../jobs.js";
import { agents, attemptModelUsage, jobs, modelPrices, organizations } from "../schema.js";
import { costForJobs, ONE_HOUR_CACHE_WRITE_MULTIPLIER } from "./attempt-costs.js";

const databaseAvailable = testDatabaseAvailable();

const opus = (overrides: Partial<ModelTokenUsage> = {}): ModelTokenUsage => ({
  model: "claude-opus-5-5",
  canonicalModel: "claude-opus-5-5",
  inputTokens: 1_000,
  cacheReadInputTokens: 100_000,
  cacheCreationInputTokens: 10_000,
  cacheWrite1hInputTokens: 2_000,
  outputTokens: 5_000,
  largestRequestInputTokens: 60_000,
  fastMode: false,
  ...overrides,
});

const haiku = (overrides: Partial<ModelTokenUsage> = {}): ModelTokenUsage => ({
  model: "claude-haiku-4-5-20251001",
  canonicalModel: "claude-haiku-4-5",
  inputTokens: 300,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheWrite1hInputTokens: 0,
  outputTokens: 40,
  largestRequestInputTokens: 300,
  fastMode: false,
  ...overrides,
});

/** Opus 5.5's list price on Oct 25 (USD per token). */
const OPUS = { input: 0.000004, output: 0.00002, read: 0.0000002, write: 0.000005 };
/** `opus()` at `OPUS`: uncached + reads + 5-minute writes + 1-hour writes at 2× input + output. */
const OPUS_COST =
  1_000 * OPUS.input +
  100_000 * OPUS.read +
  8_000 * OPUS.write +
  2_000 * OPUS.input * ONE_HOUR_CACHE_WRITE_MULTIPLIER +
  5_000 * OPUS.output;
const HAIKU = { input: 0.000001, output: 0.000005, read: 0.0000001, write: 0.00000125 };
const HAIKU_COST = 300 * HAIKU.input + 40 * HAIKU.output;

describe("attemptModelUsageRows", () => {
  it("splits cache writes into 5-minute and 1-hour, and maps the canonical model", () => {
    expect(
      attemptModelUsageRows("job", {
        usage: { inputTokens: 1, outputTokens: 1, byModel: [opus()] },
      }),
    ).toEqual([
      {
        jobId: "job",
        model: "claude-opus-5-5",
        priceModelId: "anthropic/claude-opus-5.5",
        inputTokens: 1_000,
        cacheReadTokens: 100_000,
        cacheWrite5mTokens: 8_000,
        cacheWrite1hTokens: 2_000,
        outputTokens: 5_000,
        largestRequestInputTokens: 60_000,
        fastMode: false,
      },
    ]);
  });

  it("keeps an unknown 1-hour split unknown, with every write in the 5-minute column", () => {
    const [row] = attemptModelUsageRows("job", {
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        byModel: [opus({ cacheWrite1hInputTokens: null })],
      },
    });
    expect(row).toMatchObject({ cacheWrite5mTokens: 10_000, cacheWrite1hTokens: null });
  });

  it("prices by the canonical model only, never an alias", () => {
    const rows = attemptModelUsageRows("job", {
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        byModel: [
          opus({ model: "opus", canonicalModel: null }),
          opus({ model: "opus[1m]", canonicalModel: "claude-opus-5-5" }),
          opus({ model: "claude-sonnet-5-5", canonicalModel: null }),
        ],
      },
    });
    expect(rows.map((r) => [r.model, r.priceModelId])).toEqual([
      ["opus", null],
      ["opus[1m]", "anthropic/claude-opus-5.5"],
      ["claude-sonnet-5-5", "anthropic/claude-sonnet-5.5"],
    ]);
  });

  it("stores nothing for a result without usage per model, or one that doesn't parse", () => {
    expect(attemptModelUsageRows("job", { usage: { inputTokens: 1, outputTokens: 1 } })).toEqual(
      [],
    );
    expect(attemptModelUsageRows("job", { usage: { inputTokens: -1, byModel: [opus()] } })).toEqual(
      [],
    );
    expect(attemptModelUsageRows("job", {})).toEqual([]);
    expect(attemptModelUsageRows("job", null)).toEqual([]);
  });
});

describe.skipIf(!databaseAvailable)("attempt costs", () => {
  let testDb: TestDatabase;
  let db: Database;
  let org: string;
  let agent: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [o] = await db.insert(organizations).values({ name: "Acme" }).returning();
    org = o!.id;
    const [a] = await db.insert(agents).values({ organizationId: org, name: "a-1" }).returning();
    agent = a!.id;
  }, 180_000);

  beforeEach(async () => {
    await db.delete(jobs);
    await db.delete(modelPrices);
  });

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  /** A running job of `type`, completed at `finishedAt` with `byModel` in its usage. */
  const finish = async (
    byModel: ModelTokenUsage[] | undefined,
    finishedAt = new Date("2026-10-26T12:00:00Z"),
    type = "ralph.story",
  ) => {
    const [job] = await db
      .insert(jobs)
      .values({ organizationId: org, type, taskType: "coding", status: "running", agentId: agent })
      .returning();
    const outcome = await completeJob(db, {
      jobId: job!.id,
      agentId: agent,
      result: { usage: { inputTokens: 1, outputTokens: 1, ...(byModel && { byModel }) } },
      now: finishedAt,
    });
    expect(outcome.status).toBe("completed");
    return job!.id;
  };

  const price = (
    modelId: string,
    p: { input: number; output: number; read: number | null; write: number | null },
    range: { from?: string; to?: string | null; tierMax?: number | null } = {},
  ) =>
    db.insert(modelPrices).values({
      modelId,
      name: modelId,
      inputUsd: String(p.input),
      outputUsd: String(p.output),
      cacheReadUsd: p.read === null ? null : String(p.read),
      cacheWriteUsd: p.write === null ? null : String(p.write),
      baseTierMaxTokens: range.tierMax ?? null,
      validFrom: new Date(range.from ?? "2026-10-01T00:00:00Z"),
      validTo: range.to ? new Date(range.to) : null,
      checkedAt: new Date("2026-10-26T00:00:00Z"),
    });

  const costOf = async (jobId: string) => (await costForJobs(db, [jobId])).get(jobId);

  it("stores a row per model with the result, for every session job type", async () => {
    for (const type of [
      "ralph.story",
      "ralph.request",
      "ralph.describe-pr",
      "review.task",
      "triage.run",
      "chat.ask",
    ]) {
      const jobId = await finish([opus(), haiku()], undefined, type);
      const rows = await db
        .select()
        .from(attemptModelUsage)
        .where(eq(attemptModelUsage.jobId, jobId));
      expect(rows.map((r) => [r.model, r.priceModelId]).sort()).toEqual([
        ["claude-haiku-4-5-20251001", "anthropic/claude-haiku-4.5"],
        ["claude-opus-5-5", "anthropic/claude-opus-5.5"],
      ]);
    }
  });

  it("stores no rows for a result without usage per model, and still completes it", async () => {
    const jobId = await finish(undefined);
    expect(await db.select().from(attemptModelUsage)).toEqual([]);
    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(job!.status).toBe("completed");
    expect(job!.result).toEqual({ usage: { inputTokens: 1, outputTokens: 1 } });
    expect(await costOf(jobId)).toBeNull();
  });

  it("keeps the raw usage in the result and replaces the rows when a result is stored again", async () => {
    const jobId = await finish([opus()]);
    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect((job!.result as { usage: unknown }).usage).toEqual({
      inputTokens: 1,
      outputTokens: 1,
      byModel: [opus()],
    });
    // The job is retried and its next delivery reports other models.
    await db.update(jobs).set({ status: "running" }).where(eq(jobs.id, jobId));
    await completeJob(db, {
      jobId,
      agentId: agent,
      result: { usage: { inputTokens: 1, outputTokens: 1, byModel: [haiku()] } },
    });
    const rows = await db.select().from(attemptModelUsage);
    expect(rows.map((r) => r.model)).toEqual(["claude-haiku-4-5-20251001"]);
  });

  it("prices an attempt at the price in effect when it finished", async () => {
    await price("anthropic/claude-opus-5.5", OPUS);
    const jobId = await finish([opus()]);
    expect(await costOf(jobId)).toBeCloseTo(OPUS_COST, 10);
  });

  it("prices each attempt at its own price across a price change", async () => {
    const doubled = { input: 0.000008, output: 0.00004, read: 0.0000004, write: 0.00001 };
    await price("anthropic/claude-opus-5.5", OPUS, { to: "2026-10-20T00:00:00Z" });
    await price("anthropic/claude-opus-5.5", doubled, { from: "2026-10-20T00:00:00Z" });
    const before = await finish([opus()], new Date("2026-10-19T23:59:59Z"));
    const after = await finish([opus()], new Date("2026-10-20T00:00:00Z"));
    const costs = await costForJobs(db, [before, after]);
    expect(costs.get(before)).toBeCloseTo(OPUS_COST, 10);
    expect(costs.get(after)).toBeCloseTo(OPUS_COST * 2, 10);
  });

  it("prices attempts from before a model's first price at that price (-infinity)", async () => {
    await price("anthropic/claude-opus-5.5", OPUS);
    // A Date can't hold -infinity; set it in SQL.
    await db.execute(sql`update model_prices set valid_from = '-infinity'`);
    const jobId = await finish([opus()], new Date("2020-01-01T00:00:00Z"));
    expect(await costOf(jobId)).toBeCloseTo(OPUS_COST, 10);
  });

  it("adds up a two-model attempt", async () => {
    await price("anthropic/claude-opus-5.5", OPUS);
    await price("anthropic/claude-haiku-4.5", HAIKU);
    const jobId = await finish([opus(), haiku()]);
    expect(await costOf(jobId)).toBeCloseTo(OPUS_COST + HAIKU_COST, 10);
  });

  it("has no figure when one of its models is unpriced", async () => {
    await price("anthropic/claude-opus-5.5", OPUS);
    expect(await costOf(await finish([opus(), haiku()]))).toBeNull();
  });

  describe("leaves an attempt unpriced", () => {
    it("without a matching price, or for an alias", async () => {
      await price("anthropic/claude-opus-5.5", OPUS, { from: "2026-11-01T00:00:00Z" });
      expect(await costOf(await finish([opus()]))).toBeNull();
      await db.delete(modelPrices);
      await price("anthropic/claude-opus-5.5", OPUS);
      expect(
        await costOf(await finish([opus({ model: "opus", canonicalModel: null })])),
      ).toBeNull();
    });

    it("when a component with tokens has no price", async () => {
      await price("anthropic/claude-opus-5.5", { ...OPUS, read: null });
      expect(await costOf(await finish([opus()]))).toBeNull();
      // Without cache reads, the missing read price doesn't matter.
      const noReads = await finish([opus({ cacheReadInputTokens: 0 })]);
      expect(await costOf(noReads)).toBeCloseTo(OPUS_COST - 100_000 * OPUS.read, 10);
      await db.delete(modelPrices);
      await price("anthropic/claude-opus-5.5", { ...OPUS, write: null });
      expect(await costOf(await finish([opus()]))).toBeNull();
    });

    it("when its 1-hour cache writes are unknown", async () => {
      await price("anthropic/claude-opus-5.5", OPUS);
      expect(await costOf(await finish([opus({ cacheWrite1hInputTokens: null })]))).toBeNull();
      // Unknown, but without any cache writes: priced.
      const noWrites = await finish([
        opus({ cacheCreationInputTokens: 0, cacheWrite1hInputTokens: null }),
      ]);
      expect(await costOf(noWrites)).not.toBeNull();
    });

    it("in fast mode", async () => {
      await price("anthropic/claude-opus-5.5", OPUS);
      expect(await costOf(await finish([opus({ fastMode: true })]))).toBeNull();
    });

    it("when a tiered price's tier can't be decided", async () => {
      await price("anthropic/claude-opus-5.5", OPUS, { tierMax: 100_000 });
      expect(await costOf(await finish([opus()]))).toBeCloseTo(OPUS_COST, 10);
      expect(await costOf(await finish([opus({ largestRequestInputTokens: 100_000 })]))).toBeNull();
      expect(await costOf(await finish([opus({ largestRequestInputTokens: null })]))).toBeNull();
    });
  });

  it("answers null for jobs with no rows, and for none at all", async () => {
    expect(await costForJobs(db, [])).toEqual(new Map());
    const jobId = await finish(undefined);
    expect(await costForJobs(db, [jobId])).toEqual(new Map([[jobId, null]]));
  });
});
