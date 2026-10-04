import type { UserRole } from "@omniralph/db";

/** Control panel roles. `admin` manages repos, agents and users; `member` has read access. */
export type Role = UserRole;
export const ROLES = ["admin", "member"] as const satisfies readonly Role[];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** Minimal view of the signed-in user that guards need. */
export interface RoleSubject {
  id: string;
  role: Role;
}

/** Thrown by guards when there is no signed-in user, or the user lacks the required role. */
export class AuthorizationError extends Error {
  constructor(
    message: string,
    readonly reason: "unauthenticated" | "forbidden",
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}

/** True when `user` has at least `required`. `admin` implies `member`. */
export function hasRole(user: { role: Role } | null | undefined, required: Role): boolean {
  if (!user) return false;
  return required === "member" || user.role === "admin";
}

/** Returns `user` if it has `required`, otherwise throws {@link AuthorizationError}. */
export function assertRole<T extends RoleSubject>(user: T | null | undefined, required: Role): T {
  if (!user) throw new AuthorizationError("You must be signed in.", "unauthenticated");
  if (!hasRole(user, required)) {
    throw new AuthorizationError(`This action requires the ${required} role.`, "forbidden");
  }
  return user;
}

/**
 * Checks an admin's change to another user (`role` set, or `null` for removal).
 * Returns an error message, or `null` when the change is allowed. Prevents admins from
 * removing themselves and from leaving the control panel without any admin.
 */
export function checkUserChange(input: {
  actorId: string;
  target: RoleSubject;
  newRole: Role | null;
  adminCount: number;
}): string | null {
  const { actorId, target, newRole, adminCount } = input;
  if (newRole === null && target.id === actorId) return "You can't remove yourself.";
  const losesAdmin = target.role === "admin" && newRole !== "admin";
  if (losesAdmin && adminCount <= 1) return "There must be at least one admin.";
  return null;
}
