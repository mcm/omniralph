import { createTestDatabase, testDatabaseAvailable, type TestDatabase } from "../testing/index.js";
import { asc, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { captureChanges } from "./changes.js";
import { closeDb, createDb, type Database } from "./client.js";
import { applyModelPrices, canonicalDecimal, type ModelPriceInput } from "./model-prices.js";
import { modelPrices, organizations } from "./schema.js";

describe("canonicalDecimal", () => {
  it.each([
    ["0.000004", "0.000004"],
    ["0.0000040", "0.000004"],
    ["4e-6", "0.000004"],
    ["4E-06", "0.000004"],
    ["1.25e1", "12.5"],
    ["00012", "12"],
    ["0", "0"],
    ["0.000", "0"],
  ])("%s is %s", (value, canonical) => {
    expect(canonicalDecimal(value)).toBe(canonical);
  });

  it("rejects anything else", () => {
    expect(() => canonicalDecimal("-1")).toThrow();
    expect(() => canonicalDecimal("abc")).toThrow();
  });
});

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("applyModelPrices", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgs: string[];

  const opus: ModelPriceInput = {
    modelId: "anthropic/claude-opus-5.5",
    name: "Claude Opus 5.5",
    inputUsd: "0.000004",
    outputUsd: "0.00002",
    cacheReadUsd: "0.0000002",
    cacheWriteUsd: "0.000005",
    baseTierMaxTokens: null,
  };
  const haiku: ModelPriceInput = {
    modelId: "anthropic/claude-haiku-5.5",
    name: "Claude Haiku 5.5",
    inputUsd: "0.000001",
    outputUsd: "0.000005",
    cacheReadUsd: "0.0000001",
    cacheWriteUsd: "0.00000125",
    baseTierMaxTokens: 100_000,
  };
  const day = (n: number) => new Date(Date.UTC(2026, 9, n, 3, 20));

  /** Every row, with `valid_from` as text (a Date can't hold -infinity). */
  const rows = async () =>
    (
      await db
        .select({
          modelId: modelPrices.modelId,
          inputUsd: modelPrices.inputUsd,
          validFrom: sql<string>`${modelPrices.validFrom}::text`,
          validTo: modelPrices.validTo,
          checkedAt: modelPrices.checkedAt,
        })
        .from(modelPrices)
        .orderBy(asc(modelPrices.modelId), asc(modelPrices.checkedAt))
    ).map((row) => ({ ...row, validFrom: row.validFrom === "-infinity" ? row.validFrom : "date" }));

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const created = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Beta" }])
      .returning();
    orgs = created.map((o) => o.id);
  }, 180_000);

  beforeEach(async () => {
    await db.delete(modelPrices);
  });

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  it("inserts first-seen models valid from -infinity, and announces it to every organization", async () => {
    const { result, changes } = await captureChanges(() =>
      applyModelPrices(db, [opus, haiku], day(25)),
    );
    expect(result).toEqual({ inserted: 2, changed: 0, unchanged: 0 });
    expect(await rows()).toEqual([
      {
        modelId: haiku.modelId,
        inputUsd: "0.000001",
        validFrom: "-infinity",
        validTo: null,
        checkedAt: day(25),
      },
      {
        modelId: opus.modelId,
        inputUsd: "0.000004",
        validFrom: "-infinity",
        validTo: null,
        checkedAt: day(25),
      },
    ]);
    expect(changes.map((c) => [c.resource, c.organizationId, c.ids]).sort()).toEqual(
      orgs.map((id) => ["model_prices", id, [id]]).sort(),
    );
  });

  it("only checks an unchanged price, and announces nothing", async () => {
    await applyModelPrices(db, [opus], day(25));
    const { result, changes } = await captureChanges(() =>
      // The same number, written differently.
      applyModelPrices(db, [{ ...opus, inputUsd: "0.0000040" }], day(26)),
    );
    expect(result).toEqual({ inserted: 0, changed: 0, unchanged: 1 });
    expect(changes).toEqual([]);
    expect(await rows()).toEqual([
      {
        modelId: opus.modelId,
        inputUsd: "0.000004",
        validFrom: "-infinity",
        validTo: null,
        checkedAt: day(26),
      },
    ]);
  });

  it("closes a changed price and opens a new one, keeping models missing from the list", async () => {
    await applyModelPrices(db, [opus, haiku], day(25));
    const { result, changes } = await captureChanges(() =>
      applyModelPrices(db, [{ ...opus, outputUsd: "0.000025" }], day(26)),
    );
    expect(result).toEqual({ inserted: 0, changed: 1, unchanged: 0 });
    expect(changes).toHaveLength(orgs.length);
    expect(await rows()).toEqual([
      // Haiku is no longer listed: its price stays open.
      {
        modelId: haiku.modelId,
        inputUsd: "0.000001",
        validFrom: "-infinity",
        validTo: null,
        checkedAt: day(25),
      },
      {
        modelId: opus.modelId,
        inputUsd: "0.000004",
        validFrom: "-infinity",
        validTo: day(26),
        checkedAt: day(25),
      },
      {
        modelId: opus.modelId,
        inputUsd: "0.000004",
        validFrom: "date",
        validTo: null,
        checkedAt: day(26),
      },
    ]);
    // A changed tier limit is a changed price too.
    const tier = await applyModelPrices(db, [{ ...haiku, baseTierMaxTokens: 200_000 }], day(27));
    expect(tier).toEqual({ inserted: 0, changed: 1, unchanged: 0 });
  });

  it("keeps one open row per model", async () => {
    await applyModelPrices(db, [opus], day(25));
    await expect(
      db.insert(modelPrices).values({
        modelId: opus.modelId,
        name: opus.name,
        inputUsd: "1",
        outputUsd: "1",
        validFrom: day(26),
        checkedAt: day(26),
      }),
    ).rejects.toThrow();
  });
});
