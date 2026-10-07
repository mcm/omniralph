import { NextResponse, type NextRequest } from "next/server";
import { AuthorizationError } from "@/lib/auth/roles";
import { ACCESS_DENIED_PATH, SIGN_IN_PATH } from "@/lib/auth/routes";
import { requireUser } from "@/lib/auth/session";
import { createSignedState, SIGNED_STATE_TTL_SECONDS } from "@/lib/auth/signed-state";
import {
  getGitHubInstallUrl,
  GITHUB_CALLBACK_PATH,
  GITHUB_INSTALL_COOKIE,
  GITHUB_INSTALL_STATE_PURPOSE,
} from "@/lib/scm/github-app";

/**
 * Repositories › Connect GitHub: sends an admin to the GitHub App's installation
 * page with a signed `state` naming their active organization, bound to them and
 * to this browser. GitHub hands it back to the Setup URL (`/repositories/github/callback`),
 * which stores the installation in that organization.
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
  const installUrl = await getGitHubInstallUrl();
  if (!installUrl) return to("/repositories?github=error");

  const { state, nonce } = await createSignedState(GITHUB_INSTALL_STATE_PURPOSE, {
    userId: admin.id,
    organizationId: admin.organization.id,
  });
  const url = new URL(installUrl);
  url.searchParams.set("state", state);
  const response = NextResponse.redirect(url);
  response.cookies.set(GITHUB_INSTALL_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    path: GITHUB_CALLBACK_PATH,
    maxAge: SIGNED_STATE_TTL_SECONDS,
  });
  return response;
}
