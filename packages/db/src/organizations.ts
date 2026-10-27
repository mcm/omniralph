/**
 * Typed queries for organizations, their members, invitations and email domains.
 *
 * Rules enforced here:
 * - an organization always keeps at least one `admin` (the last one can't be removed or demoted);
 * - with any email domains set, invitations, added members and accepted invitations must have an
 *   email in one of them (existing members are kept when the domains change);
 * - invitations are pending until accepted, revoked or {@link INVITATION_TTL_MS} after creation.
 */
import { and, asc, count, eq, exists, gt, inArray, isNull, notExists, sql } from "drizzle-orm";
import { recordChange } from "./changes.js";
import type { Database } from "./client.js";
import {
  organizationEmailDomains,
  organizationInvitations,
  organizationMembers,
  organizations,
  users,
} from "./schema.js";
import { normalizeEmail } from "./users.js";
import { isValidDomain, normalizeDomain } from "./domains.js";

export { isValidDomain, normalizeDomain };

export type Organization = typeof organizations.$inferSelect;
export type OrganizationRole = (typeof organizationMembers.$inferSelect)["role"];
export type OrganizationMembership = typeof organizationMembers.$inferSelect;
export type OrganizationInvitation = typeof organizationInvitations.$inferSelect;

/** Invitations expire 14 days after creation. */
export const INVITATION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Queryable = Database | Tx;

/** The lower-cased domain of an email address (`""` if it has none). */
export function emailDomain(email: string): string {
  const normalized = normalizeEmail(email);
  const at = normalized.lastIndexOf("@");
  return at === -1 ? "" : normalized.slice(at + 1);
}

/** Whether the organization's domains allow `email`; any email is allowed when it has none. */
async function isEmailAllowedIn(db: Queryable, organizationId: string, email: string | null) {
  const domains = await listOrganizationDomains(db, organizationId);
  if (domains.length === 0) return true;
  return email !== null && domains.includes(emailDomain(email));
}

/** Locks the organization row so membership changes of one organization are serialized. */
async function lockOrganization(tx: Tx, organizationId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for("update");
  return row !== undefined;
}

async function countOrgAdmins(tx: Tx, organizationId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.role, "admin"),
      ),
    );
  return row?.n ?? 0;
}

// ── Organizations ────────────────────────────────────────────────────────────

/**
 * Creates an organization with its creator as its first `admin`, and makes it
 * the creator's active organization.
 */
export async function createOrganization(
  db: Database,
  input: { name: string; createdBy: string },
): Promise<Organization> {
  return db.transaction(async (tx) => {
    const [organization] = await tx
      .insert(organizations)
      .values({ name: input.name.trim(), createdBy: input.createdBy })
      .returning();
    if (!organization) throw new Error("Failed to create organization");
    await tx
      .insert(organizationMembers)
      .values({ organizationId: organization.id, userId: input.createdBy, role: "admin" });
    await tx
      .update(users)
      .set({ activeOrganizationId: organization.id })
      .where(eq(users.id, input.createdBy));
    return organization;
  });
}

/**
 * Records a live `organization` change. A membership change (`userId`) is also told to
 * that user on their own channel: their organizations, and so their live token, changed.
 */
function recordOrganizationChange(db: unknown, organizationId: string, userId?: string): void {
  recordChange(db, { resource: "organization", ids: [organizationId], organizationId });
  if (userId) {
    recordChange(db, { resource: "organization", ids: [organizationId], organizationId, userId });
  }
}

export async function getOrganization(db: Database, id: string): Promise<Organization | null> {
  const [row] = await db.select().from(organizations).where(eq(organizations.id, id));
  return row ?? null;
}

/** The organizations a user is a member of, with their role in each, by name. */
export async function listOrganizationsForUser(
  db: Database,
  userId: string,
): Promise<(Organization & { role: OrganizationRole })[]> {
  const rows = await db
    .select({ organization: organizations, role: organizationMembers.role })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(eq(organizationMembers.userId, userId))
    .orderBy(asc(organizations.name), asc(organizations.createdAt));
  return rows.map((r) => ({ ...r.organization, role: r.role }));
}

export interface ActiveOrganization {
  id: string;
  name: string;
  /** The user's role in it. */
  role: OrganizationRole;
}

/**
 * The user's active organization with their role in it, or `null` when they have
 * none (or are no longer a member of the one they last chose).
 */
export async function getActiveOrganization(
  db: Database,
  userId: string,
): Promise<ActiveOrganization | null> {
  const [row] = await db
    .select({ id: organizations.id, name: organizations.name, role: organizationMembers.role })
    .from(users)
    .innerJoin(organizations, eq(organizations.id, users.activeOrganizationId))
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.organizationId, organizations.id),
        eq(organizationMembers.userId, users.id),
      ),
    )
    .where(eq(users.id, userId));
  return row ?? null;
}

/**
 * `organizationId` with the user's role in it, or `null` unless they're a member of it
 * (an organization picked on one device, which may be stale).
 */
export async function getMemberOrganization(
  db: Database,
  input: { userId: string; organizationId: string },
): Promise<ActiveOrganization | null> {
  const [row] = await db
    .select({ id: organizations.id, name: organizations.name, role: organizationMembers.role })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(
      and(
        eq(organizationMembers.organizationId, input.organizationId),
        eq(organizationMembers.userId, input.userId),
      ),
    );
  return row ?? null;
}

/**
 * Switches the user's active organization. Returns `false` (and changes nothing)
 * unless the user is a member of it.
 */
export async function setActiveOrganization(
  db: Database,
  input: { userId: string; organizationId: string },
): Promise<boolean> {
  const updated = await db
    .update(users)
    .set({ activeOrganizationId: input.organizationId })
    .where(
      and(
        eq(users.id, input.userId),
        exists(
          db
            .select({ one: sql`1` })
            .from(organizationMembers)
            .where(
              and(
                eq(organizationMembers.organizationId, input.organizationId),
                eq(organizationMembers.userId, input.userId),
              ),
            ),
        ),
      ),
    )
    .returning({ id: users.id });
  return updated.length > 0;
}

export type UpdateOrganizationResult = "updated" | "not_found" | "no_domains";

/**
 * Renames an organization and/or toggles "Allow anyone with a matching email to
 * join", which needs at least one email domain.
 */
export async function updateOrganization(
  db: Database,
  id: string,
  input: { name?: string; allowDomainJoin?: boolean },
): Promise<UpdateOrganizationResult> {
  return db.transaction(async (tx) => {
    if (!(await lockOrganization(tx, id))) return "not_found";
    if (input.allowDomainJoin && (await listOrganizationDomains(tx, id)).length === 0) {
      return "no_domains";
    }
    await tx
      .update(organizations)
      .set({
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.allowDomainJoin !== undefined ? { allowDomainJoin: input.allowDomainJoin } : {}),
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, id));
    recordOrganizationChange(tx, id);
    return "updated";
  });
}

// ── Email domains ────────────────────────────────────────────────────────────

/** The organization's email domains, sorted. */
export async function listOrganizationDomains(
  db: Queryable,
  organizationId: string,
): Promise<string[]> {
  const rows = await db
    .select({ domain: organizationEmailDomains.domain })
    .from(organizationEmailDomains)
    .where(eq(organizationEmailDomains.organizationId, organizationId))
    .orderBy(asc(organizationEmailDomains.domain));
  return rows.map((r) => r.domain);
}

/**
 * Replaces the organization's email domains (lower-cased, de-duplicated). Clearing
 * them also turns off joining by email domain. Existing members are kept.
 */
export async function setOrganizationDomains(
  db: Database,
  organizationId: string,
  domains: string[],
): Promise<string[]> {
  const unique = [...new Set(domains.map(normalizeDomain).filter(Boolean))].sort();
  return db.transaction(async (tx) => {
    await tx
      .delete(organizationEmailDomains)
      .where(eq(organizationEmailDomains.organizationId, organizationId));
    if (unique.length > 0) {
      await tx
        .insert(organizationEmailDomains)
        .values(unique.map((domain) => ({ organizationId, domain })));
    } else {
      await tx
        .update(organizations)
        .set({ allowDomainJoin: false, updatedAt: new Date() })
        .where(eq(organizations.id, organizationId));
    }
    recordOrganizationChange(tx, organizationId);
    return unique;
  });
}

export type AddOrganizationDomainResult = "added" | "already_added" | "invalid" | "not_found";

/** Adds an email domain to the organization; it must be a valid domain name. */
export async function addOrganizationDomain(
  db: Database,
  organizationId: string,
  domain: string,
): Promise<AddOrganizationDomainResult> {
  const normalized = normalizeDomain(domain);
  if (!isValidDomain(normalized)) return "invalid";
  return db.transaction(async (tx) => {
    if (!(await lockOrganization(tx, organizationId))) return "not_found";
    const inserted = await tx
      .insert(organizationEmailDomains)
      .values({ organizationId, domain: normalized })
      .onConflictDoNothing()
      .returning({ domain: organizationEmailDomains.domain });
    if (inserted.length > 0) recordOrganizationChange(tx, organizationId);
    return inserted.length > 0 ? "added" : "already_added";
  });
}

export type RemoveOrganizationDomainResult = "removed" | "not_found";

/**
 * Removes an email domain from the organization. Removing the last one also turns
 * off joining by email domain. Existing members are kept.
 */
export async function removeOrganizationDomain(
  db: Database,
  organizationId: string,
  domain: string,
): Promise<RemoveOrganizationDomainResult> {
  return db.transaction(async (tx) => {
    if (!(await lockOrganization(tx, organizationId))) return "not_found";
    const removed = await tx
      .delete(organizationEmailDomains)
      .where(
        and(
          eq(organizationEmailDomains.organizationId, organizationId),
          eq(organizationEmailDomains.domain, normalizeDomain(domain)),
        ),
      )
      .returning({ domain: organizationEmailDomains.domain });
    if (removed.length === 0) return "not_found";
    if ((await listOrganizationDomains(tx, organizationId)).length === 0) {
      await tx
        .update(organizations)
        .set({ allowDomainJoin: false, updatedAt: new Date() })
        .where(eq(organizations.id, organizationId));
    }
    recordOrganizationChange(tx, organizationId);
    return "removed";
  });
}

// ── Members ──────────────────────────────────────────────────────────────────

export async function getMembership(
  db: Database,
  organizationId: string,
  userId: string,
): Promise<OrganizationMembership | null> {
  const [row] = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
      ),
    );
  return row ?? null;
}

/**
 * The member of the organization whose sign-in email is `email`
 * (case-insensitive), with their name, or null.
 */
export async function getMemberByEmail(
  db: Database,
  organizationId: string,
  email: string,
): Promise<(OrganizationMembership & { name: string | null; email: string }) | null> {
  const [row] = await db
    .select({ membership: organizationMembers, name: users.name, email: users.email })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        sql`lower(${users.email}) = ${normalizeEmail(email)}`,
      ),
    )
    .orderBy(asc(organizationMembers.createdAt))
    .limit(1);
  return row?.email ? { ...row.membership, name: row.name, email: row.email } : null;
}

export interface OrganizationMember extends OrganizationMembership {
  name: string | null;
  email: string | null;
  image: string | null;
}

/** The organization's members with their profile, oldest first. */
export async function listMembers(
  db: Database,
  organizationId: string,
): Promise<OrganizationMember[]> {
  const rows = await db
    .select({
      membership: organizationMembers,
      name: users.name,
      email: users.email,
      image: users.image,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(eq(organizationMembers.organizationId, organizationId))
    .orderBy(asc(organizationMembers.createdAt));
  return rows.map((r) => ({ ...r.membership, name: r.name, email: r.email, image: r.image }));
}

export type AddMemberResult =
  "added" | "already_member" | "email_not_allowed" | "unknown_organization" | "unknown_user";

/** Adds a user to an organization; their email must match its domains when it has any. */
export async function addMember(
  db: Database,
  input: { organizationId: string; userId: string; role: OrganizationRole },
): Promise<AddMemberResult> {
  return db.transaction(async (tx) => {
    if (!(await lockOrganization(tx, input.organizationId))) return "unknown_organization";
    const [user] = await tx
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, input.userId));
    if (!user) return "unknown_user";
    if (!(await isEmailAllowedIn(tx, input.organizationId, user.email))) return "email_not_allowed";
    const inserted = await tx
      .insert(organizationMembers)
      .values(input)
      .onConflictDoNothing()
      .returning({ userId: organizationMembers.userId });
    if (inserted.length > 0) recordOrganizationChange(tx, input.organizationId, input.userId);
    return inserted.length > 0 ? "added" : "already_member";
  });
}

export type UpdateMemberRoleResult = "updated" | "not_member" | "last_admin";

/** Changes a member's role; the organization's last admin can't be demoted. */
export async function updateMemberRole(
  db: Database,
  input: { organizationId: string; userId: string; role: OrganizationRole },
): Promise<UpdateMemberRoleResult> {
  return db.transaction(async (tx) => {
    await lockOrganization(tx, input.organizationId);
    const where = and(
      eq(organizationMembers.organizationId, input.organizationId),
      eq(organizationMembers.userId, input.userId),
    );
    const [member] = await tx.select().from(organizationMembers).where(where);
    if (!member) return "not_member";
    if (member.role === input.role) return "updated";
    if (member.role === "admin" && (await countOrgAdmins(tx, input.organizationId)) <= 1) {
      return "last_admin";
    }
    await tx.update(organizationMembers).set({ role: input.role }).where(where);
    recordOrganizationChange(tx, input.organizationId, input.userId);
    return "updated";
  });
}

export type RemoveMemberResult = "removed" | "not_member" | "last_admin";

/** Removes a member; the organization's last admin can't be removed. */
export async function removeMember(
  db: Database,
  input: { organizationId: string; userId: string },
): Promise<RemoveMemberResult> {
  return db.transaction(async (tx) => {
    await lockOrganization(tx, input.organizationId);
    const where = and(
      eq(organizationMembers.organizationId, input.organizationId),
      eq(organizationMembers.userId, input.userId),
    );
    const [member] = await tx.select().from(organizationMembers).where(where);
    if (!member) return "not_member";
    if (member.role === "admin" && (await countOrgAdmins(tx, input.organizationId)) <= 1) {
      return "last_admin";
    }
    await tx.delete(organizationMembers).where(where);
    recordOrganizationChange(tx, input.organizationId, input.userId);
    return "removed";
  });
}

// ── Invitations ──────────────────────────────────────────────────────────────

const pendingInvitation = (now: Date) =>
  and(
    isNull(organizationInvitations.acceptedAt),
    isNull(organizationInvitations.revokedAt),
    gt(organizationInvitations.expiresAt, now),
  );

export type CreateInvitationResult =
  | { status: "created"; invitation: OrganizationInvitation }
  | { status: "email_not_allowed" | "already_member" | "already_invited" | "unknown_organization" };

/**
 * Invites an email to an organization. Members and emails with a pending
 * invitation to it can't be invited (revoke the pending one first). The email
 * must match the organization's domains when it has any.
 */
export async function createInvitation(
  db: Database,
  input: {
    organizationId: string;
    email: string;
    role: OrganizationRole;
    invitedBy: string | null;
    now?: Date;
  },
): Promise<CreateInvitationResult> {
  const email = normalizeEmail(input.email);
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    if (!(await lockOrganization(tx, input.organizationId))) {
      return { status: "unknown_organization" };
    }
    if (!(await isEmailAllowedIn(tx, input.organizationId, email))) {
      return { status: "email_not_allowed" };
    }
    const [member] = await tx
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(
        and(eq(organizationMembers.organizationId, input.organizationId), eq(users.email, email)),
      );
    if (member) return { status: "already_member" };
    const [pending] = await tx
      .select({ id: organizationInvitations.id })
      .from(organizationInvitations)
      .where(
        and(
          eq(organizationInvitations.organizationId, input.organizationId),
          eq(organizationInvitations.email, email),
          pendingInvitation(now),
        ),
      );
    if (pending) return { status: "already_invited" };
    const [invitation] = await tx
      .insert(organizationInvitations)
      .values({
        organizationId: input.organizationId,
        email,
        role: input.role,
        invitedBy: input.invitedBy,
        expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
        createdAt: now,
      })
      .returning();
    if (!invitation) throw new Error("Failed to create invitation");
    recordOrganizationChange(tx, input.organizationId);
    return { status: "created", invitation };
  });
}

export interface PendingInvitation extends OrganizationInvitation {
  organizationName: string;
}

/** Pending (not accepted, revoked or expired) invitations for an email, newest first. */
export async function listPendingInvitationsForEmail(
  db: Database,
  email: string,
  now: Date = new Date(),
): Promise<PendingInvitation[]> {
  const rows = await db
    .select({ invitation: organizationInvitations, organizationName: organizations.name })
    .from(organizationInvitations)
    .innerJoin(organizations, eq(organizations.id, organizationInvitations.organizationId))
    .where(and(eq(organizationInvitations.email, normalizeEmail(email)), pendingInvitation(now)))
    .orderBy(sql`${organizationInvitations.createdAt} desc`);
  return rows.map((r) => ({ ...r.invitation, organizationName: r.organizationName }));
}

/** An organization's pending invitations, newest first. */
export async function listPendingInvitationsForOrganization(
  db: Database,
  organizationId: string,
  now: Date = new Date(),
): Promise<OrganizationInvitation[]> {
  return db
    .select()
    .from(organizationInvitations)
    .where(and(eq(organizationInvitations.organizationId, organizationId), pendingInvitation(now)))
    .orderBy(sql`${organizationInvitations.createdAt} desc`);
}

/** Whether `email` has a pending invitation to any organization (the sign-in gate). */
export async function hasPendingInvitation(
  db: Database,
  email: string,
  now: Date = new Date(),
): Promise<boolean> {
  const [row] = await db
    .select({ id: organizationInvitations.id })
    .from(organizationInvitations)
    .where(and(eq(organizationInvitations.email, normalizeEmail(email)), pendingInvitation(now)))
    .limit(1);
  return row !== undefined;
}

export type AcceptInvitationResult =
  | "accepted"
  | "not_found"
  | "expired"
  | "revoked"
  | "already_accepted"
  | "email_mismatch"
  | "email_not_allowed";

/**
 * Accepts an invitation on behalf of a user whose email is the invited one,
 * making them a member with the invited role (an existing membership is kept
 * as is). The email must still match the organization's domains.
 */
export async function acceptInvitation(
  db: Database,
  input: { invitationId: string; userId: string; now?: Date },
): Promise<AcceptInvitationResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [invitation] = await tx
      .select()
      .from(organizationInvitations)
      .where(eq(organizationInvitations.id, input.invitationId))
      .for("update");
    if (!invitation) return "not_found";
    if (invitation.acceptedAt) return "already_accepted";
    if (invitation.revokedAt) return "revoked";
    if (invitation.expiresAt <= now) return "expired";
    const [user] = await tx
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, input.userId));
    if (!user?.email || normalizeEmail(user.email) !== invitation.email) return "email_mismatch";
    await lockOrganization(tx, invitation.organizationId);
    if (!(await isEmailAllowedIn(tx, invitation.organizationId, invitation.email))) {
      return "email_not_allowed";
    }
    await tx
      .insert(organizationMembers)
      .values({
        organizationId: invitation.organizationId,
        userId: input.userId,
        role: invitation.role,
      })
      .onConflictDoNothing();
    await tx
      .update(organizationInvitations)
      .set({ acceptedAt: now, acceptedBy: input.userId })
      .where(eq(organizationInvitations.id, invitation.id));
    recordOrganizationChange(tx, invitation.organizationId, input.userId);
    return "accepted";
  });
}

export type RevokeInvitationResult = "revoked" | "not_found" | "not_pending";

/** Revokes a pending invitation of the organization. */
export async function revokeInvitation(
  db: Database,
  input: { organizationId: string; invitationId: string; now?: Date },
): Promise<RevokeInvitationResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const byId = and(
      eq(organizationInvitations.id, input.invitationId),
      eq(organizationInvitations.organizationId, input.organizationId),
    );
    const [invitation] = await tx.select().from(organizationInvitations).where(byId).for("update");
    if (!invitation) return "not_found";
    const revoked = await tx
      .update(organizationInvitations)
      .set({ revokedAt: now })
      .where(and(byId, pendingInvitation(now)))
      .returning({ id: organizationInvitations.id });
    if (revoked.length > 0) recordOrganizationChange(tx, input.organizationId);
    return revoked.length > 0 ? "revoked" : "not_pending";
  });
}

export type DeclineInvitationResult = "declined" | "not_found";

/** Declines (revokes) a pending invitation addressed to the user's email. */
export async function declineInvitation(
  db: Database,
  input: { invitationId: string; userId: string; now?: Date },
): Promise<DeclineInvitationResult> {
  const now = input.now ?? new Date();
  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, input.userId));
  if (!user?.email) return "not_found";
  const declined = await db
    .update(organizationInvitations)
    .set({ revokedAt: now })
    .where(
      and(
        eq(organizationInvitations.id, input.invitationId),
        eq(organizationInvitations.email, normalizeEmail(user.email)),
        pendingInvitation(now),
      ),
    )
    .returning({
      id: organizationInvitations.id,
      organizationId: organizationInvitations.organizationId,
    });
  for (const row of declined) recordOrganizationChange(db, row.organizationId);
  return declined.length > 0 ? "declined" : "not_found";
}

// ── Joining by email domain ──────────────────────────────────────────────────

/**
 * Organizations a signed-in user with `email` can join without an invitation:
 * "Allow anyone with a matching email to join" is on, one of its domains matches
 * the email, and the user isn't already a member. Sorted by name.
 */
export async function listJoinableOrganizations(
  db: Database,
  email: string,
): Promise<Organization[]> {
  const normalized = normalizeEmail(email);
  const domain = emailDomain(normalized);
  if (!domain) return [];
  const domainOrgIds = db
    .select({ id: organizationEmailDomains.organizationId })
    .from(organizationEmailDomains)
    .where(eq(organizationEmailDomains.domain, domain));
  return db
    .select()
    .from(organizations)
    .where(
      and(
        eq(organizations.allowDomainJoin, true),
        inArray(organizations.id, domainOrgIds),
        notExists(
          db
            .select({ one: sql`1` })
            .from(organizationMembers)
            .innerJoin(users, eq(users.id, organizationMembers.userId))
            .where(
              and(
                eq(organizationMembers.organizationId, organizations.id),
                eq(users.email, normalized),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(organizations.name), asc(organizations.createdAt));
}

export type JoinOrganizationResult = "joined" | "already_member" | "not_joinable";

/** Joins an organization listed by {@link listJoinableOrganizations} as `member`. */
export async function joinOrganization(
  db: Database,
  input: { organizationId: string; userId: string },
): Promise<JoinOrganizationResult> {
  return db.transaction(async (tx) => {
    if (!(await lockOrganization(tx, input.organizationId))) return "not_joinable";
    const [organization] = await tx
      .select({ allowDomainJoin: organizations.allowDomainJoin })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId));
    const [user] = await tx
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, input.userId));
    if (!organization?.allowDomainJoin || !user?.email) return "not_joinable";
    const domains = await listOrganizationDomains(tx, input.organizationId);
    if (!domains.includes(emailDomain(user.email))) return "not_joinable";
    const inserted = await tx
      .insert(organizationMembers)
      .values({ organizationId: input.organizationId, userId: input.userId, role: "member" })
      .onConflictDoNothing()
      .returning({ userId: organizationMembers.userId });
    if (inserted.length > 0) recordOrganizationChange(tx, input.organizationId, input.userId);
    return inserted.length > 0 ? "joined" : "already_member";
  });
}
