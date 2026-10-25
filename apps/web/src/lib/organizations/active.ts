import "server-only";
import { setActiveOrganization } from "@omniralph/db";
import { cookies } from "next/headers";
import { ORGANIZATION_COOKIE, ORGANIZATION_SCOPE_COOKIE } from "@/lib/auth/routes";
import { getDb } from "@/lib/db";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/** Options for this device's organization cookies (open tabs read them: not `httpOnly`). */
function organizationCookieOptions() {
  return {
    httpOnly: false,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
  };
}

/**
 * Makes `organizationId` the user's active organization on this device (a cookie), and
 * their default on devices that haven't picked one. Returns `false` (and changes nothing)
 * unless they're a member of it. Only server actions and route handlers can set cookies.
 */
export async function activateOrganization(
  userId: string,
  organizationId: string,
): Promise<boolean> {
  if (!(await setActiveOrganization(getDb(), { userId, organizationId }))) return false;
  (await cookies()).set(ORGANIZATION_COOKIE, organizationId, organizationCookieOptions());
  return true;
}

/**
 * Sets this device's organization scope: `all` shows every organization the user belongs
 * to (callers check they have two or more), `single` the active one only.
 */
export async function setOrganizationScope(scope: "all" | "single"): Promise<void> {
  const jar = await cookies();
  if (scope === "all") jar.set(ORGANIZATION_SCOPE_COOKIE, "all", organizationCookieOptions());
  // Expired at once: the browser drops it.
  else jar.set(ORGANIZATION_SCOPE_COOKIE, "", { ...organizationCookieOptions(), maxAge: 0 });
}
