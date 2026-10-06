import { NextResponse, type NextRequest } from "next/server";
import { AuthorizationError } from "@/lib/auth/roles";
import { ACCESS_DENIED_PATH, SIGN_IN_PATH } from "@/lib/auth/routes";
import { requireUser } from "@/lib/auth/session";
import {
  authorizeUrl,
  createOAuthState,
  LINEAR_CALLBACK_PATH,
  linearOAuthConfig,
  linearRedirectUri,
  STATE_COOKIE,
} from "@/lib/linear/oauth";

const STATE_COOKIE_MAX_AGE_SECONDS = 10 * 60;

/**
 * Settings › Integrations › Connect Linear: sends an admin to Linear's consent
 * screen (`actor=app`) with a signed `state` bound to them and to this browser.
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
  if (!config) return to("/settings/integrations?linear=not_configured");

  const { state, nonce } = await createOAuthState(admin.id);
  const response = NextResponse.redirect(authorizeUrl(config.clientId, linearRedirectUri(), state));
  response.cookies.set(STATE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    path: LINEAR_CALLBACK_PATH,
    maxAge: STATE_COOKIE_MAX_AGE_SECONDS,
  });
  return response;
}
