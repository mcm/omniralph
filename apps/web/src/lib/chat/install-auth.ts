import "server-only";
import type { NextResponse } from "next/server";
import { AuthorizationError } from "@/lib/auth/roles";
import { ACCESS_DENIED_PATH, SIGN_IN_PATH } from "@/lib/auth/routes";
import { requireUser, type OrgUser } from "@/lib/auth/session";
import { ADD_CONNECTION_PATH } from "@/lib/connections/connect-notices";

/** Where a chat platform's connect flow lands when it didn't connect (Add connection). */
export const INTEGRATIONS_PATH = ADD_CONNECTION_PATH;

/**
 * The signed-in admin, or the redirect (`to`) to sign-in or access-denied for
 * a chat platform's connect and callback routes.
 */
export async function requireInstallAdmin(
  to: (path: string) => NextResponse,
): Promise<OrgUser | NextResponse> {
  try {
    return await requireUser("admin");
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    return to(
      error.reason === "unauthenticated" ? SIGN_IN_PATH : `${ACCESS_DENIED_PATH}?reason=forbidden`,
    );
  }
}
