import "server-only";
import { setActiveOrganization } from "@omniralph/db";
import { cookies } from "next/headers";
import { ORGANIZATION_COOKIE } from "@/lib/auth/routes";
import { getDb } from "@/lib/db";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

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
  (await cookies()).set(ORGANIZATION_COOKIE, organizationId, {
    httpOnly: false,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
  });
  return true;
}
