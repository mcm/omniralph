"use server";

import {
  addAllowedEmail,
  countAdmins,
  deleteAllowedEmail,
  deleteUser,
  getUserById,
  setUserRole,
} from "@omniralph/db";
import { revalidatePath } from "next/cache";
import { isValidEmail } from "@/lib/auth/allowlist";
import type { ActionResult } from "@/lib/action-result";
import { runAdminAction } from "@/lib/auth/admin-action";
import { checkUserChange, isRole, type Role } from "@/lib/auth/roles";
import { getDb } from "@/lib/db";

const USERS_PATH = "/admin/users";

async function applyUserChange(actorId: string, userId: string, newRole: Role | null) {
  const db = getDb();
  const target = await getUserById(db, userId);
  if (!target) return { ok: false as const, error: "That user no longer exists." };
  const error = checkUserChange({
    actorId,
    target,
    newRole,
    adminCount: await countAdmins(db),
  });
  if (error) return { ok: false as const, error };
  if (newRole === null) await deleteUser(db, userId);
  else await setUserRole(db, userId, newRole);
  revalidatePath(USERS_PATH);
}

export async function changeUserRole(userId: string, role: Role): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    if (!isRole(role)) return { ok: false, error: "Unknown role." };
    return applyUserChange(admin.id, userId, role);
  });
}

export async function removeUser(userId: string): Promise<ActionResult> {
  return runAdminAction((admin) => applyUserChange(admin.id, userId, null));
}

export async function allowEmail(email: string, role: Role): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    if (!isValidEmail(email)) return { ok: false, error: "Enter a valid email address." };
    if (!isRole(role)) return { ok: false, error: "Unknown role." };
    await addAllowedEmail(getDb(), { email, role, addedBy: admin.id });
    revalidatePath(USERS_PATH);
  });
}

export async function disallowEmail(email: string): Promise<ActionResult> {
  return runAdminAction(async () => {
    await deleteAllowedEmail(getDb(), email);
    revalidatePath(USERS_PATH);
  });
}
