"use server";

import {
  addOrganizationDomain,
  createInvitation,
  listMembers,
  listOrganizationsForUser,
  removeMember,
  removeOrganizationDomain,
  revokeInvitation,
  updateMemberRole,
  updateOrganization,
  type CreateInvitationResult,
} from "@omniralph/db";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import { runAdminAction, runMemberAction } from "@/lib/auth/admin-action";
import { isValidEmail } from "@/lib/auth/allowlist";
import { checkUserChange, isRole, type Role } from "@/lib/auth/roles";
import type { OrgUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { activateOrganization } from "@/lib/organizations/active";
import { checkOrganizationName } from "@/lib/organizations/name";

const SETTINGS_PATH = "/settings/organization";

const LAST_ADMIN = "There must be at least one admin.";
const NOT_MEMBER = "That user is no longer a member.";

const INVITE_ERRORS: Record<Exclude<CreateInvitationResult["status"], "created">, string> = {
  already_member: "That email already belongs to a member of this organization.",
  already_invited: "That email already has a pending invitation. Revoke it to invite again.",
  email_not_allowed: "That email isn't in one of this organization's email domains.",
  unknown_organization: "This organization no longer exists.",
};

function revalidateSettings() {
  revalidatePath(SETTINGS_PATH);
}

/** The name shows in the sidebar's organization switcher too. */
function revalidateAll() {
  revalidatePath("/", "layout");
}

/** Renames the admin's active organization. */
export async function renameOrganization(name: string): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const checked = checkOrganizationName(name);
    if ("error" in checked) return { ok: false, error: checked.error };
    const result = await updateOrganization(getDb(), admin.organization.id, { name: checked.name });
    if (result === "not_found") return { ok: false, error: "This organization no longer exists." };
    revalidateAll();
  });
}

/** Invites an email to the admin's active organization with `role`; invitations expire after 14 days. */
export async function inviteMember(email: string, role: Role): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    if (typeof email !== "string" || !isValidEmail(email)) {
      return { ok: false, error: "Enter a valid email address." };
    }
    if (!isRole(role)) return { ok: false, error: "Unknown role." };
    const result = await createInvitation(getDb(), {
      organizationId: admin.organization.id,
      email,
      role,
      invitedBy: admin.id,
    });
    if (result.status !== "created") return { ok: false, error: INVITE_ERRORS[result.status] };
    revalidateSettings();
  });
}

/** Revokes a pending invitation of the admin's active organization. */
export async function revokeInvitationAction(invitationId: string): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const result = await revokeInvitation(getDb(), {
      organizationId: admin.organization.id,
      invitationId,
    });
    if (result === "not_found") return { ok: false, error: "That invitation no longer exists." };
    if (result === "not_pending") {
      return { ok: false, error: "That invitation was already accepted, revoked or expired." };
    }
    revalidateSettings();
  });
}

/** Changes (`role`) or removes (`null`) a member of the admin's active organization. */
async function applyMemberChange(
  admin: OrgUser,
  userId: string,
  newRole: Role | null,
): Promise<ActionResult | void> {
  const db = getDb();
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
  const result =
    newRole === null
      ? await removeMember(db, { organizationId, userId })
      : await updateMemberRole(db, { organizationId, userId, role: newRole });
  if (result === "last_admin") return { ok: false, error: LAST_ADMIN };
  if (result === "not_member") return { ok: false, error: NOT_MEMBER };
  // A changed own role changes the sidebar.
  if (userId === admin.id) revalidateAll();
  else revalidateSettings();
}

export async function changeMemberRole(userId: string, role: Role): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    if (!isRole(role)) return { ok: false, error: "Unknown role." };
    return applyMemberChange(admin, userId, role);
  });
}

export async function removeMemberAction(userId: string): Promise<ActionResult> {
  return runAdminAction((admin) => applyMemberChange(admin, userId, null));
}

/** Adds an email domain to the admin's active organization. */
export async function addDomain(domain: string): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    if (typeof domain !== "string") return { ok: false, error: "Enter a domain." };
    const result = await addOrganizationDomain(getDb(), admin.organization.id, domain);
    if (result === "invalid") {
      return { ok: false, error: "Enter a valid domain, like example.com." };
    }
    if (result === "already_added") return { ok: false, error: "That domain is already listed." };
    if (result === "not_found") return { ok: false, error: "This organization no longer exists." };
    revalidateSettings();
  });
}

/**
 * Removes an email domain from the admin's active organization; removing the last
 * one turns off joining by email domain. Existing members are kept.
 */
export async function removeDomain(domain: string): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    if (typeof domain !== "string") return { ok: false, error: "Unknown domain." };
    const result = await removeOrganizationDomain(getDb(), admin.organization.id, domain);
    if (result === "not_found") return { ok: false, error: "That domain is no longer listed." };
    revalidateSettings();
  });
}

/** Turns "Allow anyone with a matching email to join" on or off; on needs a domain. */
export async function setAllowDomainJoin(enabled: boolean): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const result = await updateOrganization(getDb(), admin.organization.id, {
      allowDomainJoin: enabled === true,
    });
    if (result === "no_domains") {
      return { ok: false, error: "Add an email domain before allowing people to join." };
    }
    if (result === "not_found") return { ok: false, error: "This organization no longer exists." };
    revalidateSettings();
  });
}

/**
 * Leaves the caller's active organization (any member may, except its last admin)
 * and switches to another of their organizations, if any.
 */
export async function leaveOrganization(): Promise<ActionResult> {
  return runMemberAction(async (user) => {
    const db = getDb();
    const result = await removeMember(db, {
      organizationId: user.organization.id,
      userId: user.id,
    });
    if (result === "last_admin") {
      return {
        ok: false,
        error: "You're the last admin. Make another member an admin before leaving.",
      };
    }
    const [next] = await listOrganizationsForUser(db, user.id);
    if (next) await activateOrganization(user.id, next.id);
    revalidateAll();
  });
}
