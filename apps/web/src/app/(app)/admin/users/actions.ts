"use server";

import { listMembers, removeMember, updateMemberRole } from "@omniralph/db";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import { runAdminAction } from "@/lib/auth/admin-action";
import { checkUserChange, isRole, type Role } from "@/lib/auth/roles";
import type { OrgUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";

const USERS_PATH = "/admin/users";

const LAST_ADMIN = "There must be at least one admin.";

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
  if (!target) return { ok: false, error: "That user is no longer a member." };
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
  if (result === "not_member") return { ok: false, error: "That user is no longer a member." };
  revalidatePath(USERS_PATH);
}

export async function changeUserRole(userId: string, role: Role): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    if (!isRole(role)) return { ok: false, error: "Unknown role." };
    return applyMemberChange(admin, userId, role);
  });
}

export async function removeUser(userId: string): Promise<ActionResult> {
  return runAdminAction((admin) => applyMemberChange(admin, userId, null));
}
