import { closeDb, createDb, createUser, getUserById, type Database } from "@omniralph/db";
import { captureChanges } from "@omniralph/db/changes";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthorizationError } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  user: null as { id: string; organization?: { id: string; name: string } } | null,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  requireSignedInUser: async () => {
    if (!state.user) throw new AuthorizationError("You must be signed in.", "unauthenticated");
    return state.user;
  },
}));

const { saveShowAdvancedPreference, saveThemePreference } = await import("./theme-actions");

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("preference actions", () => {
  let testDb: TestDatabase;
  let db: Database;
  let me: string;
  let other: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    me = (await createUser(db, { email: "me@example.com" })).id;
    other = (await createUser(db, { email: "other@example.com" })).id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(() => {
    state.user = { id: me };
  });

  async function showAdvanced(id: string) {
    return (await getUserById(db, id))?.showAdvanced;
  }

  it("saves showing advanced settings for the signed-in user only", async () => {
    await expect(saveShowAdvancedPreference(true)).resolves.toEqual({ ok: true });
    expect(await showAdvanced(me)).toBe(true);
    expect(await showAdvanced(other)).toBe(false);
  });

  it("publishes a profile settings change on the user's own channel", async () => {
    const organization = { id: "11111111-1111-4111-8111-111111111111", name: "Acme" };
    state.user = { id: me, organization };
    const saved = await captureChanges(() => saveShowAdvancedPreference(true));
    expect(saved.result).toEqual({ ok: true });
    expect(saved.changes).toEqual([
      expect.objectContaining({
        resource: "settings",
        section: "profile",
        ids: [me],
        organizationId: organization.id,
        userId: me,
      }),
    ]);
    // A refused value publishes nothing.
    const refused = await captureChanges(() =>
      saveShowAdvancedPreference("yes" as unknown as boolean),
    );
    expect(refused.changes).toEqual([]);
  });

  it("saves hiding advanced settings", async () => {
    await saveShowAdvancedPreference(true);
    await expect(saveShowAdvancedPreference(false)).resolves.toEqual({ ok: true });
    expect(await showAdvanced(me)).toBe(false);
  });

  it("refuses a value that isn't a boolean and saves nothing", async () => {
    await saveShowAdvancedPreference(true);
    for (const value of ["false", 0, null, undefined, {}]) {
      await expect(saveShowAdvancedPreference(value as unknown as boolean)).resolves.toEqual({
        ok: false,
        error: "Unknown setting.",
      });
    }
    expect(await showAdvanced(me)).toBe(true);
  });

  it("refuses signed-out callers, like the theme", async () => {
    state.user = null;
    await expect(saveShowAdvancedPreference(true)).resolves.toEqual({
      ok: false,
      error: "You must be signed in.",
    });
    await expect(saveThemePreference("dark")).resolves.toEqual({
      ok: false,
      error: "You must be signed in.",
    });
    expect(await getUserById(db, other)).toMatchObject({ showAdvanced: false, theme: null });
  });

  it("still saves the theme beside it", async () => {
    await expect(saveThemePreference("light")).resolves.toEqual({ ok: true });
    await expect(saveThemePreference("sepia" as never)).resolves.toEqual({
      ok: false,
      error: "Unknown theme.",
    });
    expect((await getUserById(db, me))?.theme).toBe("light");
  });
});
