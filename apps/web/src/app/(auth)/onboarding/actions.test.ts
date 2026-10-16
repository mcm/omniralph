import {
  closeDb,
  createDb,
  createInvitation,
  createOrganization,
  getActiveOrganization,
  getMembership,
  hasPendingInvitation,
  listOrganizationsForUser,
  setOrganizationDomains,
  updateOrganization,
  users,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthorizationError } from "@/lib/auth/roles";
import { ORGANIZATION_COOKIE } from "@/lib/auth/routes";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  user: null as { id: string } | null,
  cookies: new Map<string, string>(),
}));
// This browser's cookies.
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = state.cookies.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => void state.cookies.set(name, value),
  }),
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  requireSignedInUser: async () => {
    if (!state.user) throw new AuthorizationError("You must be signed in.", "unauthenticated");
    return state.user;
  },
}));

const {
  acceptInvitationAction,
  createOrganizationAction,
  declineInvitationAction,
  joinOrganizationAction,
  switchOrganizationAction,
} = await import("./actions");

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("organization actions", () => {
  let testDb: TestDatabase;
  let db: Database;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(() => {
    state.user = null;
    state.cookies.clear();
  });

  async function signUp(email: string) {
    const [row] = await db.insert(users).values({ email, name: email }).returning();
    state.user = { id: row!.id };
    return row!;
  }

  it("lets any signed-in user create an organization, as its admin and active organization", async () => {
    expect(await createOrganizationAction("Acme")).toMatchObject({ ok: false });

    const user = await signUp("founder@create.io");
    expect(await getActiveOrganization(db, user.id)).toBeNull();
    expect(await createOrganizationAction("   ")).toEqual({
      ok: false,
      error: "Enter a name for the organization.",
    });
    expect(await createOrganizationAction(" Acme ")).toEqual({ ok: true });
    const created = await getActiveOrganization(db, user.id);
    expect(created).toMatchObject({ name: "Acme", role: "admin" });
    expect(state.cookies.get(ORGANIZATION_COOKIE)).toBe(created!.id);
  });

  it("switches only to organizations the user is a member of", async () => {
    const alice = await signUp("alice@switch.io");
    const mine = await createOrganization(db, { name: "Mine", createdBy: alice.id });
    const other = await signUp("other@switch.io");
    const theirs = await createOrganization(db, { name: "Theirs", createdBy: other.id });
    const second = await createOrganization(db, { name: "Second", createdBy: other.id });

    state.user = { id: other.id };
    expect(await switchOrganizationAction(theirs.id)).toEqual({ ok: true });
    expect((await getActiveOrganization(db, other.id))?.id).toBe(theirs.id);
    expect((await getActiveOrganization(db, other.id))?.id).not.toBe(second.id);
    // This browser picks it, and other devices default to it.
    expect(state.cookies.get(ORGANIZATION_COOKIE)).toBe(theirs.id);

    state.user = { id: alice.id };
    expect(await switchOrganizationAction(theirs.id)).toEqual({
      ok: false,
      error: "You are not a member of that organization.",
    });
    expect(await switchOrganizationAction("00000000-0000-4000-8000-000000000000")).toMatchObject({
      ok: false,
    });
    expect((await getActiveOrganization(db, alice.id))?.id).toBe(mine.id);
    expect(state.cookies.get(ORGANIZATION_COOKIE)).toBe(theirs.id);

    state.user = null;
    expect(await switchOrganizationAction(mine.id)).toEqual({
      ok: false,
      error: "You must be signed in.",
    });
  });

  it("accepts and declines invitations of the signed-in user's email only", async () => {
    const admin = await signUp("admin@invite.io");
    const org = await createOrganization(db, { name: "Invite", createdBy: admin.id });
    const invite = async (email: string) => {
      const result = await createInvitation(db, {
        organizationId: org.id,
        email,
        role: "member",
        invitedBy: admin.id,
      });
      if (result.status !== "created") throw new Error(result.status);
      return result.invitation;
    };
    const forGuest = await invite("guest@elsewhere.io");
    const forOther = await invite("other@elsewhere.io");
    expect(await hasPendingInvitation(db, "guest@elsewhere.io")).toBe(true);

    const guest = await signUp("guest@elsewhere.io");
    expect(await acceptInvitationAction(forOther.id, org.id)).toEqual({
      ok: false,
      error: "That invitation is for another email address.",
    });
    expect(await declineInvitationAction(forOther.id)).toMatchObject({ ok: false });
    expect(await getMembership(db, org.id, guest.id)).toBeNull();

    expect(await acceptInvitationAction(forGuest.id, org.id)).toEqual({ ok: true });
    expect(await getActiveOrganization(db, guest.id)).toMatchObject({
      id: org.id,
      role: "member",
    });

    await signUp("other@elsewhere.io");
    expect(await declineInvitationAction(forOther.id)).toEqual({ ok: true });
    expect(await hasPendingInvitation(db, "other@elsewhere.io")).toBe(false);
  });

  it("joins only organizations open to the user's email domain, rechecked on the server", async () => {
    const admin = await signUp("admin@join.io");
    const open = await createOrganization(db, { name: "Open", createdBy: admin.id });
    const closed = await createOrganization(db, { name: "Closed", createdBy: admin.id });
    await setOrganizationDomains(db, open.id, ["join.io"]);
    await setOrganizationDomains(db, closed.id, ["join.io"]);
    await updateOrganization(db, open.id, { allowDomainJoin: true });

    const outsider = await signUp("x@outside.io");
    expect(await joinOrganizationAction(open.id)).toEqual({
      ok: false,
      error: "You can't join that organization.",
    });

    const colleague = await signUp("colleague@join.io");
    expect(await joinOrganizationAction(closed.id)).toMatchObject({ ok: false });
    expect(await joinOrganizationAction(open.id)).toEqual({ ok: true });
    expect(await getActiveOrganization(db, colleague.id)).toMatchObject({
      id: open.id,
      role: "member",
    });
    expect((await listOrganizationsForUser(db, outsider.id)).length).toBe(0);
  });
});
