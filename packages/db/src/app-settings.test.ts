// Organization defaults for harness max concurrency and the tracker labels.
import { createTestDatabase, testDatabaseAvailable, type TestDatabase } from "../testing/index.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_CONCURRENCY_KEY,
  getAppSetting,
  getDefaultMaxConcurrency,
  getTrackerLabels,
  setAppSetting,
  setDefaultMaxConcurrency,
  setTrackerLabels,
  TRACKER_LABELS_KEY,
} from "./app-settings.js";
import { closeDb, createDb, type Database } from "./client.js";
import { appSettings, organizations } from "./schema.js";

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("organization concurrency defaults", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [a] = await db.insert(organizations).values({ name: "A" }).returning();
    const [b] = await db.insert(organizations).values({ name: "B" }).returning();
    orgA = a!.id;
    orgB = b!.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    await db.delete(appSettings);
  });

  it("allows a max concurrency of 5 when unset", async () => {
    expect(await getDefaultMaxConcurrency(db, orgA)).toBe(5);
  });

  it("returns the stored value", async () => {
    await setDefaultMaxConcurrency(db, orgA, 12, null);
    expect(await getDefaultMaxConcurrency(db, orgA)).toBe(12);
    expect((await getAppSetting(db, orgA, DEFAULT_MAX_CONCURRENCY_KEY))?.updatedBy).toBe(null);
  });

  it("keeps the tracker labels per organization, with defaults", async () => {
    const defaults = { manualLabels: ["manual"], blockedLabels: ["under-review", "blocked"] };
    expect(await getTrackerLabels(db, orgA)).toEqual(defaults);
    await setTrackerLabels(db, orgA, { manualLabels: ["by hand"], blockedLabels: [] }, null);
    expect(await getTrackerLabels(db, orgA)).toEqual({
      manualLabels: ["by hand"],
      blockedLabels: [],
    });
    expect(await getTrackerLabels(db, orgB)).toEqual(defaults);
    // Malformed lists, and an empty manual list, are the defaults.
    await setAppSetting(db, orgA, TRACKER_LABELS_KEY, { manualLabels: [], blockedLabels: 3 }, null);
    expect(await getTrackerLabels(db, orgA)).toEqual(defaults);
    await setTrackerLabels(db, orgA, null, null);
    expect(await getAppSetting(db, orgA, TRACKER_LABELS_KEY)).toBeNull();
  });

  it("accepts the concurrency bounds", async () => {
    await setDefaultMaxConcurrency(db, orgA, 1, null);
    expect(await getDefaultMaxConcurrency(db, orgA)).toBe(1);
    await setDefaultMaxConcurrency(db, orgA, 32, null);
    expect(await getDefaultMaxConcurrency(db, orgA)).toBe(32);
  });

  it("deletes the stored value on null, so the built-in default is back", async () => {
    await setDefaultMaxConcurrency(db, orgA, 2, null);
    await setDefaultMaxConcurrency(db, orgA, null, null);
    expect(await getAppSetting(db, orgA, DEFAULT_MAX_CONCURRENCY_KEY)).toBeNull();
    expect(await getDefaultMaxConcurrency(db, orgA)).toBe(5);
  });

  it("rejects out-of-range concurrency without storing it", async () => {
    await setDefaultMaxConcurrency(db, orgA, 3, null);
    for (const bad of [0, 33, -1, 2.5, Number.NaN]) {
      await expect(setDefaultMaxConcurrency(db, orgA, bad, null)).rejects.toThrow();
    }
    expect(await getDefaultMaxConcurrency(db, orgA)).toBe(3);
  });

  it("falls back to the built-in defaults when a stored value is malformed", async () => {
    await setAppSetting(db, orgA, DEFAULT_MAX_CONCURRENCY_KEY, 99, null);
    expect(await getDefaultMaxConcurrency(db, orgA)).toBe(5);
  });

  it("keeps each organization's defaults to itself", async () => {
    await setDefaultMaxConcurrency(db, orgA, 8, null);
    expect(await getDefaultMaxConcurrency(db, orgB)).toBe(5);

    await setDefaultMaxConcurrency(db, orgB, 2, null);
    expect(await getDefaultMaxConcurrency(db, orgA)).toBe(8);
  });
});
