import {
  addMember,
  closeDb,
  createDb,
  createInvitation,
  createOrganization,
  getActiveOrganization,
  getMembership,
  getOrganization,
  listOrganizationDomains,
  listPendingInvitationsForOrganization,
  updateOrganization,
  users,
  INVITATION_TTL_MS,
  type Database,
} from "@omniralph/db";
import { inArray } from "drizzle-orm";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { callAction } from "@/lib/api/test-call";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: null as string | null,
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
// The signed-in user with their real role in their active organization.
vi.mock("@/lib/auth/session", async () => {
  const { getActiveOrganization } = await import("@omniralph/db");
  return {
    requireUser: async (role: Role = "member") => {
      if (!state.userId) return assertRole(null, role);
      const active = await getActiveOrganization(state.db, state.userId);
      return assertRole(
        {
          id: state.userId,
          organization: active ? { id: active.id, name: active.name } : null,
          role: active?.role ?? null,
        },
        role,
      );
    },
  };
});

const organization = await import("@/app/api/ui/organization/route");
const invitations = await import("@/app/api/ui/organization/invitations/route");
const invitation = await import("@/app/api/ui/organization/invitations/[id]/route");
const memberRoute = await import("@/app/api/ui/organization/members/[userId]/route");
const domains = await import("@/app/api/ui/organization/domains/route");
const domainRoute = await import("@/app/api/ui/organization/domains/[domain]/route");
const leave = await import("@/app/api/ui/organization/leave/route");

// The settings page's requests, under the names of the server actions they replace.
const renameOrganization = (name: string) => callAction(organization.PATCH, "PATCH", {}, { name });
const setAllowDomainJoin = (allowDomainJoin: boolean) =>
  callAction(organization.PATCH, "PATCH", {}, { allowDomainJoin });
const inviteMember = (email: string, role: Role) =>
  callAction(invitations.POST, "POST", {}, { email, role });
const revokeInvitationAction = (id: string) => callAction(invitation.DELETE, "DELETE", { id });
const changeMemberRole = (userId: string, role: Role) =>
  callAction(memberRoute.PATCH, "PATCH", { userId }, { role });
const removeMemberAction = (userId: string) => callAction(memberRoute.DELETE, "DELETE", { userId });
const addDomain = (domain: string) => callAction(domains.POST, "POST", {}, { domain });
const removeDomain = (domain: string) => callAction(domainRoute.DELETE, "DELETE", { domain });
const leaveOrganization = () => callAction(leave.POST, "POST", {});

const databaseAvailable = testDatabaseAvailable();

const failure = { ok: false, error: expect.any(String) };

describe.skipIf(!databaseAvailable)("organization settings API", () => {
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
    state.userId = null;
  });

  async function user(email: string) {
    const [row] = await db.insert(users).values({ email, name: email }).returning();
    return row!;
  }

  async function activate(userIds: string[], organizationId: string) {
    await db
      .update(users)
      .set({ activeOrganizationId: organizationId })
      .where(inArray(users.id, userIds));
  }

  /** An organization with an admin and a member, both active in it. */
  async function team(domain: string) {
    const admin = await user(`admin@${domain}`);
    const member = await user(`member@${domain}`);
    const org = await createOrganization(db, { name: "Team", createdBy: admin.id });
    await addMember(db, { organizationId: org.id, userId: member.id, role: "member" });
    await activate([admin.id, member.id], org.id);
    return { admin, member, org };
  }

  const as = (id: string) => {
    state.userId = id;
  };

  it("lets admins rename the organization", async () => {
    const { admin, org } = await team("rename.io");
    as(admin.id);
    expect(await renameOrganization("  ")).toEqual(failure);
    expect(await renameOrganization("x".repeat(101))).toEqual(failure);
    expect(await renameOrganization(" Renamed ")).toEqual({ ok: true });
    expect(await getOrganization(db, org.id)).toMatchObject({ name: "Renamed" });
  });

  it("shows every member the organization, its members and domains; only admins its invitations", async () => {
    const { admin, member, org } = await team("view.io");
    as(admin.id);
    await addDomain("view.io");
    expect(await inviteMember("new@view.io", "member")).toEqual({ ok: true });

    const read = async () => {
      const response = await organization.GET(new Request("http://localhost/api/ui"), {
        params: Promise.resolve({}),
      });
      return { status: response.status, body: await response.json() };
    };
    expect(await read()).toEqual({
      status: 200,
      body: {
        organization: { id: org.id, name: "Team", allowDomainJoin: false },
        isAdmin: true,
        currentUserId: admin.id,
        domains: ["view.io"],
        members: expect.arrayContaining([
          expect.objectContaining({ id: admin.id, role: "admin", email: "admin@view.io" }),
          expect.objectContaining({ id: member.id, role: "member" }),
        ]),
        invitations: [expect.objectContaining({ email: "new@view.io", role: "member" })],
      },
    });

    as(member.id);
    expect((await read()).body).toMatchObject({
      isAdmin: false,
      currentUserId: member.id,
      domains: ["view.io"],
      invitations: [],
    });
    state.userId = null;
    expect((await read()).status).toBe(401);
  });

  it("invites emails with a role, rejects members and pending invitees, and revokes", async () => {
    const { admin, member, org } = await team("invite.io");
    as(admin.id);
    const before = Date.now();

    expect(await inviteMember("not an email", "member")).toEqual(failure);
    expect(await inviteMember("new@invite.io", "owner" as Role)).toEqual(failure);
    expect(await inviteMember(" New@Invite.io ", "admin")).toEqual({ ok: true });
    const [invitation] = await listPendingInvitationsForOrganization(db, org.id);
    expect(invitation).toMatchObject({
      email: "new@invite.io",
      role: "admin",
      invitedBy: admin.id,
    });
    // Expires 14 days after creation.
    expect(invitation!.expiresAt.getTime() - invitation!.createdAt.getTime()).toBe(
      INVITATION_TTL_MS,
    );
    expect(invitation!.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);

    expect(await inviteMember("new@invite.io", "member")).toEqual({
      ok: false,
      error: expect.stringMatching(/pending invitation/),
    });
    expect(await inviteMember(member.email!, "member")).toEqual({
      ok: false,
      error: expect.stringMatching(/already belongs to a member/),
    });

    expect(await revokeInvitationAction(invitation!.id)).toEqual({ ok: true });
    expect(await revokeInvitationAction(invitation!.id)).toEqual(failure);
    expect(await listPendingInvitationsForOrganization(db, org.id)).toEqual([]);
    // Revoked invitations can be sent again.
    expect(await inviteMember("new@invite.io", "member")).toEqual({ ok: true });
  });

  it("only revokes invitations of the admin's active organization", async () => {
    const { admin } = await team("scoped.io");
    const otherAdmin = await user("admin@other-scoped.io");
    const other = await createOrganization(db, { name: "Other", createdBy: otherAdmin.id });
    const result = await createInvitation(db, {
      organizationId: other.id,
      email: "x@other-scoped.io",
      role: "member",
      invitedBy: otherAdmin.id,
    });
    if (result.status !== "created") throw new Error(result.status);

    as(admin.id);
    expect(await revokeInvitationAction(result.invitation.id)).toEqual(failure);
    expect(await listPendingInvitationsForOrganization(db, other.id)).toHaveLength(1);
  });

  it("changes roles and removes members, keeping an admin", async () => {
    const { admin, member, org } = await team("roles.io");
    as(admin.id);

    expect(await changeMemberRole(admin.id, "member")).toEqual({
      ok: false,
      error: "There must be at least one admin.",
    });
    expect(await removeMemberAction(admin.id)).toEqual(failure);
    expect(await changeMemberRole(member.id, "admin")).toEqual({ ok: true });
    expect(await getMembership(db, org.id, member.id)).toMatchObject({ role: "admin" });
    expect(await changeMemberRole(member.id, "superuser" as Role)).toEqual(failure);

    expect(await removeMemberAction(member.id)).toEqual({ ok: true });
    expect(await getMembership(db, org.id, member.id)).toBeNull();
    expect(await removeMemberAction(member.id)).toEqual(failure);
  });

  it("adds and removes valid email domains and restricts invitations to them", async () => {
    const { admin, member, org } = await team("domains.io");
    as(admin.id);

    for (const bad of ["", "localhost", "not a domain", "a@domains.io", "-x.io"]) {
      expect(await addDomain(bad)).toEqual(failure);
    }
    expect(await addDomain("other.io")).toEqual({ ok: true });
    expect(await addDomain("OTHER.io")).toEqual({
      ok: false,
      error: "That domain is already listed.",
    });
    expect(await listOrganizationDomains(db, org.id)).toEqual(["other.io"]);

    expect(await inviteMember("someone@elsewhere.io", "member")).toEqual({
      ok: false,
      error: expect.stringMatching(/email domains/),
    });
    expect(await inviteMember("someone@other.io", "member")).toEqual({ ok: true });
    // Existing members outside the domains are kept.
    expect(await getMembership(db, org.id, member.id)).toMatchObject({ role: "member" });

    expect(await removeDomain("nope.io")).toEqual(failure);
    expect(await removeDomain("other.io")).toEqual({ ok: true });
    expect(await listOrganizationDomains(db, org.id)).toEqual([]);
    expect(await inviteMember("someone@elsewhere.io", "member")).toEqual({ ok: true });
  });

  it("allows joining by email domain only while there are domains", async () => {
    const { admin, org } = await team("join.io");
    as(admin.id);

    expect(await setAllowDomainJoin(true)).toEqual({
      ok: false,
      error: expect.stringMatching(/Add an email domain/),
    });
    expect(await getOrganization(db, org.id)).toMatchObject({ allowDomainJoin: false });

    await addDomain("join.io");
    await addDomain("also-join.io");
    expect(await setAllowDomainJoin(true)).toEqual({ ok: true });
    expect(await getOrganization(db, org.id)).toMatchObject({ allowDomainJoin: true });
    expect(await setAllowDomainJoin(false)).toEqual({ ok: true });
    expect(await getOrganization(db, org.id)).toMatchObject({ allowDomainJoin: false });

    await setAllowDomainJoin(true);
    await removeDomain("join.io");
    expect(await getOrganization(db, org.id)).toMatchObject({ allowDomainJoin: true });
    // Removing the last domain turns it off.
    await removeDomain("also-join.io");
    expect(await getOrganization(db, org.id)).toMatchObject({ allowDomainJoin: false });
  });

  it("lets any member leave, except the last admin, and switches to another organization", async () => {
    const { admin, member, org } = await team("leave.io");
    const elsewhere = await createOrganization(db, { name: "Elsewhere", createdBy: member.id });
    await activate([member.id], org.id);

    as(admin.id);
    expect(await leaveOrganization()).toEqual({
      ok: false,
      error: expect.stringMatching(/last admin/),
    });
    expect(await getMembership(db, org.id, admin.id)).toMatchObject({ role: "admin" });

    as(member.id);
    expect(await leaveOrganization()).toEqual({ ok: true });
    expect(await getMembership(db, org.id, member.id)).toBeNull();
    expect(await getActiveOrganization(db, member.id)).toMatchObject({ id: elsewhere.id });

    // Once another admin exists, an admin can leave; with no other organization they have none.
    await addMember(db, { organizationId: org.id, userId: member.id, role: "admin" });
    as(admin.id);
    expect(await leaveOrganization()).toEqual({ ok: true });
    expect(await getActiveOrganization(db, admin.id)).toBeNull();
    expect(await leaveOrganization()).toEqual(failure);
  });

  it("rejects every mutating action from members, server-side", async () => {
    const { admin, member, org } = await team("readonly.io");
    await updateOrganization(db, org.id, { name: "Read only" });
    const result = await createInvitation(db, {
      organizationId: org.id,
      email: "pending@readonly.io",
      role: "member",
      invitedBy: admin.id,
    });
    if (result.status !== "created") throw new Error(result.status);
    as(admin.id);
    await addDomain("readonly.io");

    for (const userId of [member.id, null]) {
      state.userId = userId;
      expect(await renameOrganization("Hijacked")).toEqual(failure);
      expect(await inviteMember("new@readonly.io", "admin")).toEqual(failure);
      expect(await revokeInvitationAction(result.invitation.id)).toEqual(failure);
      expect(await changeMemberRole(member.id, "admin")).toEqual(failure);
      expect(await changeMemberRole(admin.id, "member")).toEqual(failure);
      expect(await removeMemberAction(admin.id)).toEqual(failure);
      expect(await addDomain("evil.io")).toEqual(failure);
      expect(await removeDomain("readonly.io")).toEqual(failure);
      expect(await setAllowDomainJoin(true)).toEqual(failure);
    }

    expect(await getOrganization(db, org.id)).toMatchObject({
      name: "Read only",
      allowDomainJoin: false,
    });
    expect((await listPendingInvitationsForOrganization(db, org.id)).map((i) => i.email)).toEqual([
      "pending@readonly.io",
    ]);
    expect(await getMembership(db, org.id, member.id)).toMatchObject({ role: "member" });
    expect(await getMembership(db, org.id, admin.id)).toMatchObject({ role: "admin" });
    expect(await listOrganizationDomains(db, org.id)).toEqual(["readonly.io"]);
  });
});
