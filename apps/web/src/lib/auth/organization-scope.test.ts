// "All organizations" end to end, against a real database: the switch API sets this
// device's scope cookie, `getOrganizationScope()` resolves the user's own memberships from
// it, and pages and `/api/ui` keep acting on the single active organization.
import type React from "react";
import {
  addMember,
  closeDb,
  createDb,
  createOrganization,
  removeMember,
  users,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { callAction } from "@/lib/api/test-call";
import { ORGANIZATION_COOKIE, ORGANIZATION_SCOPE_COOKIE } from "./routes";

vi.mock("server-only", () => ({}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  // No request scope in tests: every call resolves afresh.
  cache: <T>(fn: T) => fn,
}));

const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: null as string | null,
  /** This browser's cookies, with the options they were last set with. */
  cookies: new Map<string, { value: string; options?: Record<string, unknown> }>(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const cookie = state.cookies.get(name);
      return cookie === undefined || cookie.options?.maxAge === 0
        ? undefined
        : { name, value: cookie.value };
    },
    set: (name: string, value: string, options?: Record<string, unknown>) =>
      void state.cookies.set(name, { value, options }),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect ${path}`);
  },
  unstable_rethrow: () => {},
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/auth", () => ({
  auth: async () =>
    state.userId === null
      ? null
      : { user: { id: state.userId, name: null, email: null, image: null, theme: null } },
}));

const { getOrganizationScope, requirePageUser, requireUser } = await import("./session");
const switchRoute = await import("@/app/api/ui/organizations/switch/route");
const switchTo = (body: unknown) => callAction(switchRoute.POST, "POST", {}, body);

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("organization scope", () => {
  let testDb: TestDatabase;
  let db: Database;
  /** Ada: admin of Zeta, member of Alpha. Bob: admin of Alpha and Bravo. */
  let ada: string;
  let bob: string;
  let alpha: { id: string; name: string };
  let zeta: { id: string; name: string };
  let bravo: { id: string; name: string };

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    const [adaRow] = await db
      .insert(users)
      .values({ email: "ada@scope.io", name: "Ada" })
      .returning();
    const [bobRow] = await db
      .insert(users)
      .values({ email: "bob@scope.io", name: "Bob" })
      .returning();
    ada = adaRow!.id;
    bob = bobRow!.id;
    // Created out of name order, to check the ordering.
    zeta = await createOrganization(db, { name: "Zeta", createdBy: ada });
    bravo = await createOrganization(db, { name: "Bravo", createdBy: bob });
    alpha = await createOrganization(db, { name: "Alpha", createdBy: bob });
    expect(await addMember(db, { organizationId: alpha.id, userId: ada, role: "member" })).toBe(
      "added",
    );
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(() => {
    state.cookies.clear();
    state.userId = ada;
  });

  it("is all of the user's organizations, by name with their role, under the all scope", async () => {
    expect(await switchTo({ organizationId: zeta.id })).toEqual({ ok: true });
    expect(await switchTo({ scope: "all" })).toEqual({ ok: true });
    expect(state.cookies.get(ORGANIZATION_SCOPE_COOKIE)).toEqual({
      value: "all",
      // The same options as the organization cookie.
      options: state.cookies.get(ORGANIZATION_COOKIE)!.options,
    });
    expect(await getOrganizationScope()).toEqual({
      kind: "all",
      organizations: [
        { id: alpha.id, name: "Alpha", role: "member" },
        { id: zeta.id, name: "Zeta", role: "admin" },
      ],
    });
  });

  it("never includes another user's organization", async () => {
    state.cookies.set(ORGANIZATION_SCOPE_COOKIE, { value: "all" });
    const scope = await getOrganizationScope();
    expect(scope?.kind).toBe("all");
    const ids = scope?.kind === "all" ? scope.organizations.map((o) => o.id) : [];
    expect(ids).not.toContain(bravo.id);

    state.userId = bob;
    const bobs = await getOrganizationScope();
    expect(bobs?.kind === "all" && bobs.organizations.map((o) => o.name)).toEqual([
      "Alpha",
      "Bravo",
    ]);
  });

  it("is the active organization without the scope cookie", async () => {
    expect(await switchTo({ organizationId: alpha.id })).toEqual({ ok: true });
    expect(await getOrganizationScope()).toEqual({
      kind: "single",
      organization: { id: alpha.id, name: "Alpha", role: "member" },
    });
  });

  it("leaves all organizations when one organization is picked", async () => {
    expect(await switchTo({ scope: "all" })).toEqual({ ok: true });
    expect(await switchTo({ organizationId: zeta.id })).toEqual({ ok: true });
    expect(state.cookies.get(ORGANIZATION_SCOPE_COOKIE)?.options?.maxAge).toBe(0);
    expect(await getOrganizationScope()).toEqual({
      kind: "single",
      organization: { id: zeta.id, name: "Zeta", role: "admin" },
    });
  });

  it("keeps pages and /api/ui on the single active organization under all", async () => {
    expect(await switchTo({ organizationId: zeta.id })).toEqual({ ok: true });
    expect(await switchTo({ scope: "all" })).toEqual({ ok: true });
    expect(await requirePageUser()).toMatchObject({
      organization: { id: zeta.id, name: "Zeta" },
      role: "admin",
    });
    expect(await requireUser("admin")).toMatchObject({ organization: { id: zeta.id } });
  });

  it("refuses an organization the user doesn't belong to", async () => {
    expect(await switchTo({ organizationId: bravo.id })).toEqual({
      ok: false,
      error: "You are not a member of that organization.",
    });
  });

  it("refuses all organizations to a one-organization user, and falls back to single", async () => {
    const [carol] = await db
      .insert(users)
      .values({ email: "carol@scope.io", name: "Carol" })
      .returning();
    const solo = await createOrganization(db, { name: "Solo", createdBy: carol!.id });
    expect(
      await addMember(db, { organizationId: alpha.id, userId: carol!.id, role: "member" }),
    ).toBe("added");
    state.userId = carol!.id;
    expect(await switchTo({ organizationId: solo.id })).toEqual({ ok: true });
    expect(await switchTo({ scope: "all" })).toEqual({ ok: true });

    // Removed from all but one organization: the cookie no longer applies.
    expect(await removeMember(db, { organizationId: alpha.id, userId: carol!.id })).toBe("removed");
    expect(await getOrganizationScope()).toEqual({
      kind: "single",
      organization: { id: solo.id, name: "Solo", role: "admin" },
    });

    state.cookies.clear();
    expect(await switchTo({ scope: "all" })).toEqual({
      ok: false,
      error: "You need to belong to more than one organization to see all of them.",
    });
    expect(state.cookies.has(ORGANIZATION_SCOPE_COOKIE)).toBe(false);
  });
});
