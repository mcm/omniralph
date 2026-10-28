// Per-organization settings: the tracker labels and the generic get/set.
import { createTestDatabase, testDatabaseAvailable, type TestDatabase } from "../testing/index.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  getAppSetting,
  getTrackerLabels,
  setAppSetting,
  setTrackerLabels,
  TRACKER_LABELS_KEY,
} from "./app-settings.js";
import { closeDb, createDb, type Database } from "./client.js";
import { appSettings, organizations } from "./schema.js";

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("organization settings", () => {
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

  it("stores a value with who set it, per organization", async () => {
    await setAppSetting(db, orgA, "agent.desiredVersion", "2.0.4", null);
    expect(await getAppSetting(db, orgA, "agent.desiredVersion")).toMatchObject({
      value: "2.0.4",
      updatedBy: null,
    });
    expect(await getAppSetting(db, orgB, "agent.desiredVersion")).toBeNull();
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
});
