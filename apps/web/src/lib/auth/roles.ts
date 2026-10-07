import type { OrganizationRole } from "@omniralph/db";

/**
 * Organization roles. `admin` manages the organization's repos, agents, settings and
 * members; `member` has read access. A user's role depends on the organization.
 */
export type Role = OrganizationRole;
export const ROLES = ["admin", "member"] as const satisfies readonly Role[];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/**
 * Minimal view of the signed-in user that guards need: their role in their active
 * organization, `null` when they have none.
 */
export interface RoleSubject {
  id: string;
  role: Role | null;
  organization?: { id: string } | null;
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

export const NO_ORGANIZATION_MESSAGE = "Create or join an organization first.";

/** True when `user` has at least `required` in their active organization. `admin` implies `member`. */
export function hasRole(user: { role: Role | null } | null | undefined, required: Role): boolean {
  if (!user?.role) return false;
  return required === "member" || user.role === "admin";
}

/**
 * Returns `user` if it has `required` in its active organization, otherwise throws
 * {@link AuthorizationError}.
 */
export function assertRole<T extends RoleSubject>(
  user: T | null | undefined,
  required: Role,
): T & { role: Role } {
  if (!user) throw new AuthorizationError("You must be signed in.", "unauthenticated");
  if (!user.role) throw new AuthorizationError(NO_ORGANIZATION_MESSAGE, "forbidden");
  if (!hasRole(user, required)) {
    throw new AuthorizationError(`This action requires the ${required} role.`, "forbidden");
  }
  return user as T & { role: Role };
}

/**
 * Like {@link assertRole}, and also requires `organizationId` to be the user's active
 * organization: roles only count in the organization they're held in.
 */
export function assertOrgRole<T extends RoleSubject>(
  user: T | null | undefined,
  organizationId: string,
  required: Role,
): T & { role: Role } {
  const subject = assertRole(user, required);
  if (subject.organization?.id !== organizationId) {
    throw new AuthorizationError("You are not a member of this organization.", "forbidden");
  }
  return subject;
}

/**
 * Checks an organization admin's change to a member (`role` set, or `null` for removal).
 * Returns an error message, or `null` when the change is allowed. Prevents admins from
 * removing themselves and from leaving the organization without any admin.
 */
export function checkUserChange(input: {
  actorId: string;
  target: { id: string; role: Role };
  newRole: Role | null;
  /** Admins of the organization. */
  adminCount: number;
}): string | null {
  const { actorId, target, newRole, adminCount } = input;
  if (newRole === null && target.id === actorId) return "You can't remove yourself.";
  const losesAdmin = target.role === "admin" && newRole !== "admin";
  if (losesAdmin && adminCount <= 1) return "There must be at least one admin.";
  return null;
}
