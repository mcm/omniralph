import { createTestDatabase, testDatabaseAvailable, type TestDatabase } from "../testing/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Database } from "./client.js";
import { getActiveOrganization, listOrganizationsForUser } from "./organizations.js";
import { createUser, normalizeEmail } from "./users.js";

describe("normalizeEmail", () => {
  it("trims and lower-cases", () => {
    expect(normalizeEmail("  Steve@McMaster.IO ")).toBe("steve@mcmaster.io");
  });
});

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("user queries", () => {
  let testDb: TestDatabase;
  let db: Database;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  it("creates users, the first one included, without any organization or admin role", async () => {
    const first = await createUser(db, { email: "First@X.io", name: "First" });
    const second = await createUser(db, { email: "second@x.io" });
    for (const user of [first, second]) {
      expect(user).not.toHaveProperty("role");
      expect(user.activeOrganizationId).toBeNull();
      expect(await getActiveOrganization(db, user.id)).toBeNull();
      expect(await listOrganizationsForUser(db, user.id)).toEqual([]);
    }
    expect(first.email).toBe("first@x.io");
  });
});
