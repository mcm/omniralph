import "server-only";
import type { UiTheme } from "@omniralph/db";
import { redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "@/auth";
import { assertRole, hasRole, type Role } from "./roles";
import { ACCESS_DENIED_PATH, SIGN_IN_PATH } from "./routes";

export interface CurrentUser {
  id: string;
  role: Role;
  name: string | null;
  email: string | null;
  image: string | null;
  /** Remembered control panel theme; `null` follows the OS preference. */
  theme: UiTheme | null;
}

/** The signed-in user, or `null`. Cached per request: the root and `(app)` layouts both need it. */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await auth();
  if (!session?.user?.id) return null;
  const { id, role, name, email, image, theme } = session.user;
  return { id, role, name: name ?? null, email: email ?? null, image: image ?? null, theme };
});

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
