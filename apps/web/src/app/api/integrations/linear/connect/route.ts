import { NextResponse, type NextRequest } from "next/server";
import { AuthorizationError } from "@/lib/auth/roles";
import { ACCESS_DENIED_PATH, SIGN_IN_PATH } from "@/lib/auth/routes";
import { requireUser } from "@/lib/auth/session";
import { connectNoticePath } from "@/lib/connections/connect-notices";
import { createSignedState, SIGNED_STATE_TTL_SECONDS } from "@/lib/auth/signed-state";
import {
  authorizeUrl,
  LINEAR_CALLBACK_PATH,
  LINEAR_OAUTH_STATE_PURPOSE,
  linearOAuthConfig,
  linearRedirectUri,
  STATE_COOKIE,
} from "@/lib/linear/oauth";

/**
 * Settings › Add connection › Linear › Connect: sends an admin to Linear's consent
 * screen (`actor=app`) with a signed `state` naming their active organization,
 * bound to them and to this browser.
 */
export async function GET(request: NextRequest) {
  const to = (path: string) => NextResponse.redirect(new URL(path, request.url));
  let admin;
  try {
    admin = await requireUser("admin");
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    return to(
      error.reason === "unauthenticated" ? SIGN_IN_PATH : `${ACCESS_DENIED_PATH}?reason=forbidden`,
    );
  }
  const config = linearOAuthConfig();
  if (!config) return to(connectNoticePath("linear", "not_configured"));

  const { state, nonce } = await createSignedState(LINEAR_OAUTH_STATE_PURPOSE, {
    userId: admin.id,
    organizationId: admin.organization.id,
  });
  const response = NextResponse.redirect(authorizeUrl(config.clientId, linearRedirectUri(), state));
  response.cookies.set(STATE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    path: LINEAR_CALLBACK_PATH,
    maxAge: SIGNED_STATE_TTL_SECONDS,
  });
  return response;
}
