import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Database } from "./client.js";
import { runMigrations } from "./migrate.js";
import { listPoolNames } from "./pools.js";
import {
  acceptInvitation,
  addMember,
  addOrganizationDomain,
  createInvitation,
  createOrganization,
  declineInvitation,
  emailDomain,
  getActiveOrganization,
  getMemberByEmail,
  getMemberOrganization,
  getMembership,
  getOrganization,
  hasPendingInvitation,
  INVITATION_TTL_MS,
  isValidDomain,
  joinOrganization,
  listJoinableOrganizations,
  listMembers,
  listOrganizationDomains,
  listOrganizationsForUser,
  listPendingInvitationsForEmail,
  listPendingInvitationsForOrganization,
  normalizeDomain,
  removeMember,
  removeOrganizationDomain,
  revokeInvitation,
  setActiveOrganization,
  setOrganizationDomains,
  updateMemberRole,
  updateOrganization,
} from "./organizations.js";
import { organizationInvitations, users } from "./schema.js";
import { listReviewProfiles } from "./settings.js";

describe("emailDomain / normalizeDomain", () => {
  it("lower-cases and strips", () => {
    expect(emailDomain(" Steve@McMaster.IO ")).toBe("mcmaster.io");
    expect(emailDomain("nodomain")).toBe("");
    expect(normalizeDomain(" @Example.COM ")).toBe("example.com");
  });

  it("validates domain names", () => {
    for (const ok of ["example.com", "sub.acme.io", "xn--bcher-kva.de", "a-b.c0.co"]) {
      expect(isValidDomain(ok)).toBe(true);
    }
    for (const bad of [
      "",
      "localhost",
      "example",
      "-acme.io",
      "acme-.io",
      "acme..io",
      ".acme.io",
      "acme.io.",
      "ac me.io",
      "acme_io.com",
      "user@acme.io",
      "10.0.0.1",
      "Acme.io",
      `${"a".repeat(64)}.io`,
    ]) {
      expect(isValidDomain(bad)).toBe(false);
    }
  });
});

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

describe.skipIf(!dockerAvailable)("organization queries", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await container?.stop();
  });

  async function user(email: string | null) {
    const [row] = await db.insert(users).values({ email, name: email }).returning();
    return row!;
  }

  async function invite(organizationId: string, email: string, now?: Date) {
    const result = await createInvitation(db, {
      organizationId,
      email,
      role: "member",
      invitedBy: null,
      now,
    });
    if (result.status !== "created") throw new Error(result.status);
    return result.invitation;
  }

  it("creates an organization with its creator as admin and lists it for them", async () => {
    const alice = await user("alice@create.io");
    const other = await user("other@create.io");
    const org = await createOrganization(db, { name: " Zeta ", createdBy: alice.id });
    const second = await createOrganization(db, { name: "Alpha", createdBy: alice.id });
    await createOrganization(db, { name: "Not mine", createdBy: other.id });

    expect(org).toMatchObject({ name: "Zeta", allowDomainJoin: false, createdBy: alice.id });
    expect(await getOrganization(db, org.id)).toMatchObject({ id: org.id });
    expect(await getMembership(db, org.id, alice.id)).toMatchObject({ role: "admin" });
    expect(await getMembership(db, org.id, other.id)).toBeNull();
    expect(
      (await listOrganizationsForUser(db, alice.id)).map((o) => [o.id, o.name, o.role]),
    ).toEqual([
      [second.id, "Alpha", "admin"],
      [org.id, "Zeta", "admin"],
    ]);
    // Each organization gets its own copy of the built-in review profiles.
    for (const id of [org.id, second.id]) {
      expect((await listReviewProfiles(db, id)).map((p) => [p.id, p.builtIn])).toEqual([
        ["quick", true],
        ["standard", true],
        ["deep", true],
      ]);
      // …and the short and long pools.
      expect((await listPoolNames(db, id)).toSorted()).toEqual(["long", "short"]);
    }
  });

  it("adds members, changes roles and removes members", async () => {
    const admin = await user("admin@members.io");
    const bob = await user("bob@members.io");
    const org = await createOrganization(db, { name: "Members", createdBy: admin.id });

    expect(await addMember(db, { organizationId: org.id, userId: bob.id, role: "member" })).toBe(
      "added",
    );
    expect(await addMember(db, { organizationId: org.id, userId: bob.id, role: "admin" })).toBe(
      "already_member",
    );
    expect(await getMembership(db, org.id, bob.id)).toMatchObject({ role: "member" });
    expect(await addMember(db, { organizationId: org.id, userId: "nobody", role: "member" })).toBe(
      "unknown_user",
    );
    expect(
      await addMember(db, {
        organizationId: "00000000-0000-0000-0000-000000000000",
        userId: bob.id,
        role: "member",
      }),
    ).toBe("unknown_organization");
    expect((await listMembers(db, org.id)).map((m) => [m.email, m.role])).toEqual([
      ["admin@members.io", "admin"],
      ["bob@members.io", "member"],
    ]);

    expect(
      await updateMemberRole(db, { organizationId: org.id, userId: bob.id, role: "admin" }),
    ).toBe("updated");
    expect(await getMembership(db, org.id, bob.id)).toMatchObject({ role: "admin" });
    expect(
      await updateMemberRole(db, { organizationId: org.id, userId: "nobody", role: "admin" }),
    ).toBe("not_member");

    expect(await removeMember(db, { organizationId: org.id, userId: admin.id })).toBe("removed");
    expect(await getMembership(db, org.id, admin.id)).toBeNull();
    expect(await removeMember(db, { organizationId: org.id, userId: admin.id })).toBe("not_member");
  });

  it("finds a member by sign-in email, case-insensitively", async () => {
    const admin = await user("admin@byemail.io");
    const carol = await user("carol@byemail.io");
    const outsider = await user("outsider@byemail.io");
    const org = await createOrganization(db, { name: "By email", createdBy: admin.id });
    await addMember(db, { organizationId: org.id, userId: carol.id, role: "member" });

    expect(await getMemberByEmail(db, org.id, " Carol@ByEmail.IO ")).toMatchObject({
      userId: carol.id,
      role: "member",
      name: "carol@byemail.io",
      email: "carol@byemail.io",
    });
    expect(await getMemberByEmail(db, org.id, outsider.email!)).toBeNull();
    expect(await getMemberByEmail(db, org.id, "nobody@byemail.io")).toBeNull();
  });

  it("never removes or demotes the last admin", async () => {
    const admin = await user("admin@last.io");
    const member = await user("member@last.io");
    const org = await createOrganization(db, { name: "Last", createdBy: admin.id });
    await addMember(db, { organizationId: org.id, userId: member.id, role: "member" });

    expect(
      await updateMemberRole(db, { organizationId: org.id, userId: admin.id, role: "member" }),
    ).toBe("last_admin");
    expect(await removeMember(db, { organizationId: org.id, userId: admin.id })).toBe("last_admin");
    expect(await getMembership(db, org.id, admin.id)).toMatchObject({ role: "admin" });
    // Members can still be removed.
    expect(await removeMember(db, { organizationId: org.id, userId: member.id })).toBe("removed");

    // Two admins demoting each other concurrently: one of them stays admin.
    const second = await user("second@last.io");
    await addMember(db, { organizationId: org.id, userId: second.id, role: "admin" });
    const results = await Promise.all(
      [admin.id, second.id].map((userId) =>
        updateMemberRole(db, { organizationId: org.id, userId, role: "member" }),
      ),
    );
    expect(results.sort()).toEqual(["last_admin", "updated"]);
    expect((await listMembers(db, org.id)).filter((m) => m.role === "admin")).toHaveLength(1);
  });

  it("restricts invitations, added members and accepted invitations to the org's domains", async () => {
    const admin = await user("admin@acme.io");
    const outsider = await user("outsider@other.io");
    const org = await createOrganization(db, { name: "Acme", createdBy: admin.id });
    // No domains: anyone can be invited.
    const early = await invite(org.id, "Outsider@Other.io");
    expect(early.email).toBe("outsider@other.io");

    expect(
      await setOrganizationDomains(db, org.id, ["ACME.io", "@acme.io", " sub.acme.io "]),
    ).toEqual(["acme.io", "sub.acme.io"]);
    expect(await listOrganizationDomains(db, org.id)).toEqual(["acme.io", "sub.acme.io"]);

    expect(
      await createInvitation(db, {
        organizationId: org.id,
        email: "someone@other.io",
        role: "member",
        invitedBy: admin.id,
      }),
    ).toEqual({ status: "email_not_allowed" });
    expect(
      await addMember(db, { organizationId: org.id, userId: outsider.id, role: "member" }),
    ).toBe("email_not_allowed");
    expect(await acceptInvitation(db, { invitationId: early.id, userId: outsider.id })).toBe(
      "email_not_allowed",
    );
    expect(await getMembership(db, org.id, outsider.id)).toBeNull();

    const insider = await user("insider@sub.acme.io");
    expect(
      await addMember(db, { organizationId: org.id, userId: insider.id, role: "member" }),
    ).toBe("added");
    const noEmail = await user(null);
    expect(
      await addMember(db, { organizationId: org.id, userId: noEmail.id, role: "member" }),
    ).toBe("email_not_allowed");

    // Changing the domains keeps existing members.
    await setOrganizationDomains(db, org.id, ["elsewhere.io"]);
    expect(await getMembership(db, org.id, insider.id)).toMatchObject({ role: "member" });
  });

  it("creates, lists, accepts and revokes invitations", async () => {
    const admin = await user("admin@invites.io");
    const org = await createOrganization(db, { name: "Invites", createdBy: admin.id });
    const now = new Date("2026-10-01T00:00:00Z");

    const created = await createInvitation(db, {
      organizationId: org.id,
      email: "New@Invites.io",
      role: "admin",
      invitedBy: admin.id,
      now,
    });
    expect(created).toMatchObject({
      status: "created",
      invitation: {
        email: "new@invites.io",
        role: "admin",
        invitedBy: admin.id,
        expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
      },
    });
    if (created.status !== "created") throw new Error();
    expect(INVITATION_TTL_MS).toBe(14 * 24 * 60 * 60 * 1000);

    // An email with a pending invitation can't be invited again until it's revoked.
    expect(
      await createInvitation(db, {
        organizationId: org.id,
        email: "NEW@invites.io",
        role: "member",
        invitedBy: admin.id,
        now,
      }),
    ).toEqual({ status: "already_invited" });
    expect(
      await revokeInvitation(db, {
        organizationId: org.id,
        invitationId: created.invitation.id,
        now,
      }),
    ).toBe("revoked");
    const replacement = await invite(org.id, "new@invites.io", now);
    expect(
      (await listPendingInvitationsForEmail(db, "NEW@invites.io", now)).map((i) => [
        i.id,
        i.organizationName,
      ]),
    ).toEqual([[replacement.id, "Invites"]]);
    expect((await listPendingInvitationsForOrganization(db, org.id, now)).map((i) => i.id)).toEqual(
      [replacement.id],
    );
    expect(
      await acceptInvitation(db, { invitationId: created.invitation.id, userId: admin.id }),
    ).toBe("revoked");

    const invitee = await user("new@invites.io");
    const stranger = await user("stranger@invites.io");
    expect(
      await acceptInvitation(db, { invitationId: replacement.id, userId: stranger.id, now }),
    ).toBe("email_mismatch");
    expect(
      await acceptInvitation(db, { invitationId: replacement.id, userId: invitee.id, now }),
    ).toBe("accepted");
    expect(await getMembership(db, org.id, invitee.id)).toMatchObject({ role: "member" });
    expect(
      await acceptInvitation(db, { invitationId: replacement.id, userId: invitee.id, now }),
    ).toBe("already_accepted");
    const [row] = await db
      .select()
      .from(organizationInvitations)
      .where(eq(organizationInvitations.id, replacement.id));
    expect(row).toMatchObject({ acceptedAt: now, acceptedBy: invitee.id });
    expect(await listPendingInvitationsForEmail(db, "new@invites.io", now)).toEqual([]);

    // Members can't be invited again.
    expect(
      await createInvitation(db, {
        organizationId: org.id,
        email: "new@invites.io",
        role: "member",
        invitedBy: admin.id,
      }),
    ).toEqual({ status: "already_member" });

    expect(
      await acceptInvitation(db, {
        invitationId: "00000000-0000-0000-0000-000000000000",
        userId: invitee.id,
      }),
    ).toBe("not_found");
  });

  it("rejects expired invitations", async () => {
    const admin = await user("admin@expiry.io");
    const org = await createOrganization(db, { name: "Expiry", createdBy: admin.id });
    const late = await user("late@expiry.io");
    const created = new Date("2026-09-01T00:00:00Z");
    const invitation = await invite(org.id, "late@expiry.io", created);
    const expired = new Date(created.getTime() + INVITATION_TTL_MS);

    expect(await listPendingInvitationsForEmail(db, "late@expiry.io", expired)).toEqual([]);
    expect(
      await acceptInvitation(db, { invitationId: invitation.id, userId: late.id, now: expired }),
    ).toBe("expired");
    expect(
      await revokeInvitation(db, {
        organizationId: org.id,
        invitationId: invitation.id,
        now: expired,
      }),
    ).toBe("not_pending");
    expect(await getMembership(db, org.id, late.id)).toBeNull();
  });

  it("revokes pending invitations of the organization only", async () => {
    const admin = await user("admin@revoke.io");
    const org = await createOrganization(db, { name: "Revoke", createdBy: admin.id });
    const other = await createOrganization(db, { name: "Other", createdBy: admin.id });
    const target = await user("target@revoke.io");
    const invitation = await invite(org.id, "target@revoke.io");

    expect(
      await revokeInvitation(db, { organizationId: other.id, invitationId: invitation.id }),
    ).toBe("not_found");
    expect(
      await revokeInvitation(db, { organizationId: org.id, invitationId: invitation.id }),
    ).toBe("revoked");
    expect(
      await revokeInvitation(db, { organizationId: org.id, invitationId: invitation.id }),
    ).toBe("not_pending");
    expect(await listPendingInvitationsForEmail(db, "target@revoke.io")).toEqual([]);
    expect(await acceptInvitation(db, { invitationId: invitation.id, userId: target.id })).toBe(
      "revoked",
    );
  });

  it("lists and joins organizations open to the user's email domain", async () => {
    const admin = await user("admin@join.io");
    const open = await createOrganization(db, { name: "Open", createdBy: admin.id });
    const closed = await createOrganization(db, { name: "Closed", createdBy: admin.id });
    const elsewhere = await createOrganization(db, { name: "Elsewhere", createdBy: admin.id });
    const noDomains = await createOrganization(db, { name: "No domains", createdBy: admin.id });

    expect(await updateOrganization(db, noDomains.id, { allowDomainJoin: true })).toBe(
      "no_domains",
    );
    expect(
      await updateOrganization(db, "00000000-0000-0000-0000-000000000000", { name: "x" }),
    ).toBe("not_found");
    await setOrganizationDomains(db, open.id, ["join.io"]);
    await setOrganizationDomains(db, closed.id, ["join.io"]);
    await setOrganizationDomains(db, elsewhere.id, ["other.io"]);
    expect(await updateOrganization(db, open.id, { allowDomainJoin: true, name: "Open org" })).toBe(
      "updated",
    );
    expect(await updateOrganization(db, elsewhere.id, { allowDomainJoin: true })).toBe("updated");
    expect(await getOrganization(db, open.id)).toMatchObject({
      name: "Open org",
      allowDomainJoin: true,
    });

    const carol = await user("carol@join.io");
    expect((await listJoinableOrganizations(db, "Carol@JOIN.io")).map((o) => o.id)).toEqual([
      open.id,
    ]);
    // The admin is already a member of it.
    expect(await listJoinableOrganizations(db, "admin@join.io")).toEqual([]);
    expect(await listJoinableOrganizations(db, "nodomain")).toEqual([]);

    expect(await joinOrganization(db, { organizationId: closed.id, userId: carol.id })).toBe(
      "not_joinable",
    );
    expect(await joinOrganization(db, { organizationId: elsewhere.id, userId: carol.id })).toBe(
      "not_joinable",
    );
    expect(await joinOrganization(db, { organizationId: open.id, userId: carol.id })).toBe(
      "joined",
    );
    expect(await getMembership(db, open.id, carol.id)).toMatchObject({ role: "member" });
    expect(await joinOrganization(db, { organizationId: open.id, userId: carol.id })).toBe(
      "already_member",
    );
    expect(await listJoinableOrganizations(db, "carol@join.io")).toEqual([]);

    // Clearing the domains turns joining off.
    await setOrganizationDomains(db, open.id, []);
    expect(await getOrganization(db, open.id)).toMatchObject({ allowDomainJoin: false });
    expect(await listJoinableOrganizations(db, "dave@join.io")).toEqual([]);
  });

  it("adds and removes email domains; removing the last one turns joining off", async () => {
    const admin = await user("admin@domains.io");
    const org = await createOrganization(db, { name: "Domains", createdBy: admin.id });
    const member = await user("member@domains.io");
    await addMember(db, { organizationId: org.id, userId: member.id, role: "member" });

    expect(await addOrganizationDomain(db, org.id, "not a domain")).toBe("invalid");
    expect(await addOrganizationDomain(db, org.id, " @Domains.IO ")).toBe("added");
    expect(await addOrganizationDomain(db, org.id, "domains.io")).toBe("already_added");
    expect(await addOrganizationDomain(db, org.id, "other.io")).toBe("added");
    expect(await addOrganizationDomain(db, "00000000-0000-0000-0000-000000000000", "x.io")).toBe(
      "not_found",
    );
    expect(await listOrganizationDomains(db, org.id)).toEqual(["domains.io", "other.io"]);
    expect(await updateOrganization(db, org.id, { allowDomainJoin: true })).toBe("updated");

    expect(await removeOrganizationDomain(db, org.id, "nope.io")).toBe("not_found");
    expect(await removeOrganizationDomain(db, org.id, "Other.io")).toBe("removed");
    expect(await getOrganization(db, org.id)).toMatchObject({ allowDomainJoin: true });
    expect(await removeOrganizationDomain(db, org.id, "domains.io")).toBe("removed");
    expect(await listOrganizationDomains(db, org.id)).toEqual([]);
    expect(await getOrganization(db, org.id)).toMatchObject({ allowDomainJoin: false });
    // Members are kept.
    expect(await getMembership(db, org.id, member.id)).toMatchObject({ role: "member" });
  });

  it("makes a new organization its creator's active one and only switches to member organizations", async () => {
    const alice = await user("alice@active.io");
    const bob = await user("bob@active.io");
    expect(await getActiveOrganization(db, alice.id)).toBeNull();

    const first = await createOrganization(db, { name: "First", createdBy: alice.id });
    expect(await getActiveOrganization(db, alice.id)).toEqual({
      id: first.id,
      name: "First",
      role: "admin",
    });
    const second = await createOrganization(db, { name: "Second", createdBy: alice.id });
    expect((await getActiveOrganization(db, alice.id))?.id).toBe(second.id);

    expect(await setActiveOrganization(db, { userId: alice.id, organizationId: first.id })).toBe(
      true,
    );
    expect((await getActiveOrganization(db, alice.id))?.id).toBe(first.id);

    // Bob isn't a member of First: switching is refused and changes nothing.
    const bobs = await createOrganization(db, { name: "Bob's", createdBy: bob.id });
    expect(await setActiveOrganization(db, { userId: bob.id, organizationId: first.id })).toBe(
      false,
    );
    expect((await getActiveOrganization(db, bob.id))?.id).toBe(bobs.id);

    // The role follows the membership; a removed member has no active organization.
    await addMember(db, { organizationId: first.id, userId: bob.id, role: "member" });
    expect(await setActiveOrganization(db, { userId: bob.id, organizationId: first.id })).toBe(
      true,
    );
    expect(await getActiveOrganization(db, bob.id)).toMatchObject({ role: "member" });
    await removeMember(db, { organizationId: first.id, userId: bob.id });
    expect(await getActiveOrganization(db, bob.id)).toBeNull();
  });

  it("looks up an organization chosen elsewhere only while the user is a member of it", async () => {
    const carol = await user("carol@member-org.io");
    const dave = await user("dave@member-org.io");
    const org = await createOrganization(db, { name: "Chosen", createdBy: carol.id });

    expect(await getMemberOrganization(db, { userId: carol.id, organizationId: org.id })).toEqual({
      id: org.id,
      name: "Chosen",
      role: "admin",
    });
    expect(await getMemberOrganization(db, { userId: dave.id, organizationId: org.id })).toBeNull();
    await addMember(db, { organizationId: org.id, userId: dave.id, role: "member" });
    expect(
      await getMemberOrganization(db, { userId: dave.id, organizationId: org.id }),
    ).toMatchObject({ role: "member" });
    await removeMember(db, { organizationId: org.id, userId: dave.id });
    expect(await getMemberOrganization(db, { userId: dave.id, organizationId: org.id })).toBeNull();
  });

  it("finds pending invitations for the sign-in gate and lets the invitee decline them", async () => {
    const admin = await user("admin@gate.io");
    const guest = await user("guest@elsewhere.io");
    const org = await createOrganization(db, { name: "Gate", createdBy: admin.id });
    const now = new Date();
    expect(await hasPendingInvitation(db, "guest@elsewhere.io", now)).toBe(false);

    const invitation = await invite(org.id, "Guest@Elsewhere.io", now);
    expect(await hasPendingInvitation(db, " GUEST@elsewhere.io ", now)).toBe(true);
    const later = new Date(now.getTime() + INVITATION_TTL_MS + 1);
    expect(await hasPendingInvitation(db, "guest@elsewhere.io", later)).toBe(false);

    // Only the invited email can decline.
    expect(await declineInvitation(db, { invitationId: invitation.id, userId: admin.id })).toBe(
      "not_found",
    );
    expect(await declineInvitation(db, { invitationId: invitation.id, userId: guest.id })).toBe(
      "declined",
    );
    expect(await hasPendingInvitation(db, "guest@elsewhere.io")).toBe(false);
    expect(await declineInvitation(db, { invitationId: invitation.id, userId: guest.id })).toBe(
      "not_found",
    );
  });
});
