import "server-only";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { assertRole, hasRole, type Role } from "./roles";
import { ACCESS_DENIED_PATH, SIGN_IN_PATH } from "./routes";

export interface CurrentUser {
  id: string;
  role: Role;
  name: string | null;
  email: string | null;
  image: string | null;
}

/** The signed-in user, or `null`. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  const { id, role, name, email, image } = session.user;
  return { id, role, name: name ?? null, email: email ?? null, image: image ?? null };
}

/** For pages: the signed-in user with `role` (default `member`); redirects otherwise. */
export async function requirePageUser(role: Role = "member"): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect(SIGN_IN_PATH);
  if (!hasRole(user, role)) redirect(`${ACCESS_DENIED_PATH}?reason=forbidden`);
  return user;
}

/**
 * For server actions and route handlers: the signed-in user with `role`; throws
 * `AuthorizationError` otherwise. Every mutating action for settings, repos, agents and
 * users must call `requireUser("admin")` first.
 */
export async function requireUser(role: Role = "member"): Promise<CurrentUser> {
  return assertRole(await getCurrentUser(), role);
}
