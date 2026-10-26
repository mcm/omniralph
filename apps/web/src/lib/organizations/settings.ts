import "server-only";
import {
  addOrganizationDomain,
  createInvitation,
  getOrganization,
  listMembers,
  listOrganizationDomains,
  listOrganizationsForUser,
  listPendingInvitationsForOrganization,
  removeMember,
  removeOrganizationDomain,
  revokeInvitation,
  updateMemberRole,
  updateOrganization,
  withSettingsChanges,
  type CreateInvitationResult,
  type Database,
} from "@omniralph/db";
import type { ActionResult } from "@/lib/action-result";
import { ApiRouteError } from "@/lib/api/handler";
import type { OrganizationChange, OrganizationSettings } from "@/lib/api/organization";
import { isValidEmail } from "@/lib/auth/allowlist";
import { checkUserChange, hasRole, isRole, type Role } from "@/lib/auth/roles";
import type { OrgUser } from "@/lib/auth/session";
import { loadSettingsHistory } from "@/lib/settings-history/history";
import { settingsActor, trackedOrganization } from "@/lib/settings-history/sections";
import { activateOrganization } from "./active";
import { checkOrganizationName } from "./name";

const LAST_ADMIN = "There must be at least one admin.";
const NOT_MEMBER = "That user is no longer a member.";
const ORGANIZATION_GONE = "This organization no longer exists.";

const INVITE_ERRORS: Record<Exclude<CreateInvitationResult["status"], "created">, string> = {
  already_member: "That email already belongs to a member of this organization.",
  already_invited: "That email already has a pending invitation. Revoke it to invite again.",
  email_not_allowed: "That email isn't in one of this organization's email domains.",
  unknown_organization: ORGANIZATION_GONE,
};

/** Runs a save of the organization's settings, recording what it changed in its change history. */
function savingOrganization<T>(
  db: Database,
  user: OrgUser,
  save: (tx: Database) => Promise<T>,
): Promise<T> {
  return withSettingsChanges(
    db,
    settingsActor(user),
    trackedOrganization(user.organization.id),
    save,
  );
}

/**
 * Settings › Organization: the caller's active organization with its members and email
 * domains; admins also get its pending invitations.
 */
export async function loadOrganizationSettings(
  db: Database,
  user: OrgUser,
): Promise<OrganizationSettings> {
  const isAdmin = hasRole(user, "admin");
  const organizationId = user.organization.id;
  const [organization, members, domains, invitations, history] = await Promise.all([
    getOrganization(db, organizationId),
    listMembers(db, organizationId),
    listOrganizationDomains(db, organizationId),
    isAdmin ? listPendingInvitationsForOrganization(db, organizationId) : [],
    loadSettingsHistory(
      db,
      [{ id: organizationId, name: user.organization.name, role: user.role }],
      { section: "organization", limit: 1 },
    ),
  ]);
  if (!organization) throw ApiRouteError.notFound();
  return {
    organization: {
      id: organization.id,
      name: organization.name,
      allowDomainJoin: organization.allowDomainJoin,
    },
    isAdmin,
    currentUserId: user.id,
    domains,
    members: members.map((m) => ({
      id: m.userId,
      name: m.name,
      email: m.email,
      image: m.image,
      role: m.role,
      joinedAt: m.createdAt.toISOString(),
    })),
    invitations: invitations.map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      createdAt: i.createdAt.toISOString(),
      expiresAt: i.expiresAt.toISOString(),
    })),
    history: history.latest,
  };
}

/** Renames the admin's active organization. */
export async function renameOrganization(
  db: Database,
  admin: OrgUser,
  name: string,
): Promise<ActionResult> {
  const checked = checkOrganizationName(name);
  if ("error" in checked) return { ok: false, error: checked.error };
  const result = await savingOrganization(db, admin, (tx) =>
    updateOrganization(tx, admin.organization.id, { name: checked.name }),
  );
  if (result === "not_found") return { ok: false, error: ORGANIZATION_GONE };
  return { ok: true };
}

/** Turns "Allow anyone with a matching email to join" on or off; on needs a domain. */
export async function setAllowDomainJoin(
  db: Database,
  admin: OrgUser,
  enabled: boolean,
): Promise<ActionResult> {
  const result = await savingOrganization(db, admin, (tx) =>
    updateOrganization(tx, admin.organization.id, { allowDomainJoin: enabled === true }),
  );
  if (result === "no_domains") {
    return { ok: false, error: "Add an email domain before allowing people to join." };
  }
  if (result === "not_found") return { ok: false, error: ORGANIZATION_GONE };
  return { ok: true };
}

/** `PATCH /api/ui/organization`: a rename or the domain-join switch. */
export function changeOrganization(
  db: Database,
  admin: OrgUser,
  change: OrganizationChange,
): Promise<ActionResult> {
  return "name" in change
    ? renameOrganization(db, admin, change.name)
    : setAllowDomainJoin(db, admin, change.allowDomainJoin);
}

/** Invites an email to the admin's active organization with `role`; invitations expire after 14 days. */
export async function inviteMember(
  db: Database,
  admin: OrgUser,
  email: string,
  role: string,
): Promise<ActionResult> {
  if (typeof email !== "string" || !isValidEmail(email)) {
    return { ok: false, error: "Enter a valid email address." };
  }
  if (!isRole(role)) return { ok: false, error: "Unknown role." };
  const result = await savingOrganization(db, admin, (tx) =>
    createInvitation(tx, {
      organizationId: admin.organization.id,
      email,
      role,
      invitedBy: admin.id,
    }),
  );
  if (result.status !== "created") return { ok: false, error: INVITE_ERRORS[result.status] };
  return { ok: true };
}

/** Revokes a pending invitation of the admin's active organization. */
export async function revokeOrganizationInvitation(
  db: Database,
  admin: OrgUser,
  invitationId: string,
): Promise<ActionResult> {
  const result = await savingOrganization(db, admin, (tx) =>
    revokeInvitation(tx, { organizationId: admin.organization.id, invitationId }),
  );
  if (result === "not_found") return { ok: false, error: "That invitation no longer exists." };
  if (result === "not_pending") {
    return { ok: false, error: "That invitation was already accepted, revoked or expired." };
  }
  return { ok: true };
}

/** Changes (`role`) or removes (`null`) a member of the admin's active organization. */
async function applyMemberChange(
  db: Database,
  admin: OrgUser,
  userId: string,
  newRole: Role | null,
): Promise<ActionResult> {
  const organizationId = admin.organization.id;
  const members = await listMembers(db, organizationId);
  const target = members.find((m) => m.userId === userId);
  if (!target) return { ok: false, error: NOT_MEMBER };
  const error = checkUserChange({
    actorId: admin.id,
    target: { id: target.userId, role: target.role },
    newRole,
    adminCount: members.filter((m) => m.role === "admin").length,
  });
  if (error) return { ok: false, error };
  const result = await savingOrganization(db, admin, (tx) =>
    newRole === null
      ? removeMember(tx, { organizationId, userId })
      : updateMemberRole(tx, { organizationId, userId, role: newRole }),
  );
  if (result === "last_admin") return { ok: false, error: LAST_ADMIN };
  if (result === "not_member") return { ok: false, error: NOT_MEMBER };
  return { ok: true };
}

export async function changeMemberRole(
  db: Database,
  admin: OrgUser,
  userId: string,
  role: string,
): Promise<ActionResult> {
  if (!isRole(role)) return { ok: false, error: "Unknown role." };
  return applyMemberChange(db, admin, userId, role);
}

export function removeOrganizationMember(
  db: Database,
  admin: OrgUser,
  userId: string,
): Promise<ActionResult> {
  return applyMemberChange(db, admin, userId, null);
}

/** Adds an email domain to the admin's active organization. */
export async function addDomain(
  db: Database,
  admin: OrgUser,
  domain: string,
): Promise<ActionResult> {
  if (typeof domain !== "string") return { ok: false, error: "Enter a domain." };
  const result = await savingOrganization(db, admin, (tx) =>
    addOrganizationDomain(tx, admin.organization.id, domain),
  );
  if (result === "invalid") return { ok: false, error: "Enter a valid domain, like example.com." };
  if (result === "already_added") return { ok: false, error: "That domain is already listed." };
  if (result === "not_found") return { ok: false, error: ORGANIZATION_GONE };
  return { ok: true };
}

/**
 * Removes an email domain from the admin's active organization; removing the last
 * one turns off joining by email domain. Existing members are kept.
 */
export async function removeDomain(
  db: Database,
  admin: OrgUser,
  domain: string,
): Promise<ActionResult> {
  if (typeof domain !== "string") return { ok: false, error: "Unknown domain." };
  const result = await savingOrganization(db, admin, (tx) =>
    removeOrganizationDomain(tx, admin.organization.id, domain),
  );
  if (result === "not_found") return { ok: false, error: "That domain is no longer listed." };
  return { ok: true };
}

/**
 * Leaves the caller's active organization (any member may, except its last admin)
 * and switches to another of their organizations, if any.
 */
export async function leaveOrganization(db: Database, user: OrgUser): Promise<ActionResult> {
  const result = await savingOrganization(db, user, (tx) =>
    removeMember(tx, { organizationId: user.organization.id, userId: user.id }),
  );
  if (result === "last_admin") {
    return {
      ok: false,
      error: "You're the last admin. Make another member an admin before leaving.",
    };
  }
  const [next] = await listOrganizationsForUser(db, user.id);
  if (next) await activateOrganization(user.id, next.id);
  return { ok: true };
}
