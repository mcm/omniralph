import { createTestDatabase, testDatabaseAvailable, type TestDatabase } from "../testing/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Database } from "./client.js";
import { getActiveOrganization, listOrganizationsForUser } from "./organizations.js";
import { accounts, sessions } from "./schema.js";
import {
  createUser,
  deleteUser,
  getUserById,
  listUsers,
  normalizeEmail,
  setUserTheme,
} from "./users.js";

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

  it("remembers a user's theme, following the OS until one is chosen", async () => {
    const user = await createUser(db, { email: "theme@example.com" });
    expect(user.theme).toBeNull();
    await setUserTheme(db, user.id, "dark");
    expect((await getUserById(db, user.id))?.theme).toBe("dark");
    await setUserTheme(db, user.id, "light");
    expect((await getUserById(db, user.id))?.theme).toBe("light");
  });

  it("goes back to following the OS when the theme is cleared", async () => {
    const user = await createUser(db, { email: "system@example.com" });
    await setUserTheme(db, user.id, "dark");
    expect((await getUserById(db, user.id))?.theme).toBe("dark");
    await setUserTheme(db, user.id, null);
    expect((await getUserById(db, user.id))?.theme).toBeNull();
  });

  it("deletes users with their accounts and sessions", async () => {
    const user = await createUser(db, { email: "gone@example.com" });
    await db.insert(accounts).values({
      userId: user.id,
      type: "oauth",
      provider: "github",
      providerAccountId: "42",
    });
    await db.insert(sessions).values({ sessionToken: "t", userId: user.id, expires: new Date() });

    await deleteUser(db, user.id);
    expect((await listUsers(db)).some((u) => u.id === user.id)).toBe(false);
    expect(await db.select().from(accounts)).toEqual([]);
    expect(await db.select().from(sessions)).toEqual([]);
  });
});
