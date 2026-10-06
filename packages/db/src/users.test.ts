import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Database } from "./client.js";
import { runMigrations } from "./migrate.js";
import { accounts, sessions } from "./schema.js";
import {
  addAllowedEmail,
  countAdmins,
  createUserWithInitialRole,
  deleteUser,
  getUserById,
  initialUserRole,
  isEmailAllowlisted,
  listAllowedEmails,
  listUsers,
  normalizeEmail,
  setUserRole,
  setUserTheme,
} from "./users.js";

describe("initialUserRole", () => {
  it("makes the first user an admin", () => {
    expect(initialUserRole({ isFirstUser: true })).toBe("admin");
    expect(initialUserRole({ isFirstUser: true, allowlistedRole: "member" })).toBe("admin");
  });

  it("uses the allowlisted role, defaulting to member", () => {
    expect(initialUserRole({ isFirstUser: false })).toBe("member");
    expect(initialUserRole({ isFirstUser: false, allowlistedRole: null })).toBe("member");
    expect(initialUserRole({ isFirstUser: false, allowlistedRole: "admin" })).toBe("admin");
  });
});

describe("normalizeEmail", () => {
  it("trims and lower-cases", () => {
    expect(normalizeEmail("  Steve@McMaster.IO ")).toBe("steve@mcmaster.io");
  });
});

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

describe.skipIf(!dockerAvailable)("user queries", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
  }, 180_000);

  afterAll(async () => {
    await db?.$client.end();
    await container?.stop();
  });

  it("makes only the first of several concurrent sign-ups an admin", async () => {
    const created = await Promise.all(
      ["a@x.io", "b@x.io", "c@x.io", "d@x.io"].map((email) =>
        createUserWithInitialRole(db, { email, name: email }),
      ),
    );
    expect(created.filter((u) => u.role === "admin")).toHaveLength(1);
    expect(await countAdmins(db)).toBe(1);
  });

  it("applies the allowlisted role to new users and stores emails lower-cased", async () => {
    await addAllowedEmail(db, { email: "Boss@Example.com", role: "admin", addedBy: null });
    expect(await isEmailAllowlisted(db, "boss@example.COM")).toBe(true);
    expect(await isEmailAllowlisted(db, "nobody@example.com")).toBe(false);

    const user = await createUserWithInitialRole(db, { email: "BOSS@example.com" });
    expect(user).toMatchObject({ email: "boss@example.com", role: "admin" });
  });

  it("updates an existing allowlist entry's role", async () => {
    await addAllowedEmail(db, { email: "x@y.io", role: "member", addedBy: null });
    await addAllowedEmail(db, { email: "x@y.io", role: "admin", addedBy: null });
    const entries = await listAllowedEmails(db);
    expect(entries.filter((e) => e.email === "x@y.io")).toEqual([
      expect.objectContaining({ role: "admin" }),
    ]);
  });

  it("remembers a user's theme, following the OS until one is chosen", async () => {
    const user = await createUserWithInitialRole(db, { email: "theme@example.com" });
    expect(user.theme).toBeNull();
    await setUserTheme(db, user.id, "dark");
    expect((await getUserById(db, user.id))?.theme).toBe("dark");
    await setUserTheme(db, user.id, "light");
    expect((await getUserById(db, user.id))?.theme).toBe("light");
  });

  it("changes roles and deletes users with their accounts, sessions and allowlist entry", async () => {
    await addAllowedEmail(db, { email: "gone@example.com", role: "member", addedBy: null });
    const user = await createUserWithInitialRole(db, { email: "gone@example.com" });
    await setUserRole(db, user.id, "admin");
    expect((await listUsers(db)).find((u) => u.id === user.id)?.role).toBe("admin");

    await db.insert(accounts).values({
      userId: user.id,
      type: "oauth",
      provider: "github",
      providerAccountId: "42",
    });
    await db.insert(sessions).values({ sessionToken: "t", userId: user.id, expires: new Date() });

    await deleteUser(db, user.id);
    expect((await listUsers(db)).some((u) => u.id === user.id)).toBe(false);
    expect(await isEmailAllowlisted(db, "gone@example.com")).toBe(false);
    expect(await db.select().from(accounts)).toEqual([]);
    expect(await db.select().from(sessions)).toEqual([]);
  });
});
