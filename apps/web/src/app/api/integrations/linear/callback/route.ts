import { consumeOAuthState, saveIntegration } from "@omniralph/db";
import { NextResponse, type NextRequest } from "next/server";
import { AuthorizationError } from "@/lib/auth/roles";
import { ACCESS_DENIED_PATH, SIGN_IN_PATH } from "@/lib/auth/routes";
import { requireUser } from "@/lib/auth/session";
import { readSignedState } from "@/lib/auth/signed-state";
import { getDb } from "@/lib/db";
import { SdkLinearGateway } from "@/lib/linear/gateway";
import {
  exchangeCode,
  LINEAR_CALLBACK_PATH,
  LINEAR_OAUTH_STATE_PURPOSE,
  linearOAuthConfig,
  linearRedirectUri,
  STATE_COOKIE,
} from "@/lib/linear/oauth";
import { liveRoute } from "@/lib/live/request";

/**
 * Linear's OAuth redirect: checks the signed `state` (same admin, same
 * browser, the admin's active organization, not expired, not used before) and
 * consumes it, exchanges the code and stores the workspace and its tokens as
 * the organization's Linear integration. A workspace already connected to
 * another organization is refused (`?linear=other_organization`).
 */
async function get(request: NextRequest) {
  const to = (path: string) => {
    const response = NextResponse.redirect(new URL(path, request.url));
    response.cookies.delete({ name: STATE_COOKIE, path: LINEAR_CALLBACK_PATH });
    return response;
  };
  let admin;
  try {
    admin = await requireUser("admin");
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    return to(
      error.reason === "unauthenticated" ? SIGN_IN_PATH : `${ACCESS_DENIED_PATH}?reason=forbidden`,
    );
  }

  const params = request.nextUrl.searchParams;
  const db = getDb();
  const organizationId = admin.organization.id;
  const signed = await readSignedState(LINEAR_OAUTH_STATE_PURPOSE, params.get("state"), {
    userId: admin.id,
    nonce: request.cookies.get(STATE_COOKIE)?.value,
  });
  // A state works once (a replayed callback is rejected), and only for the
  // organization the admin is working in.
  if (
    !signed ||
    signed.organizationId !== organizationId ||
    !(await consumeOAuthState(db, signed.nonce, signed.expiresAt))
  ) {
    return to("/settings/integrations?linear=invalid_state");
  }
  // The admin declined on Linear's consent screen.
  if (params.get("error")) return to("/settings/integrations?linear=denied");
  const code = params.get("code");
  if (!code) return to("/settings/integrations?linear=invalid");
  const config = linearOAuthConfig();
  if (!config) return to("/settings/integrations?linear=not_configured");

  let saved;
  try {
    const credentials = await exchangeCode(config, { code, redirectUri: linearRedirectUri() });
    const workspace = await new SdkLinearGateway(credentials.accessToken).getOrganization();
    saved = await saveIntegration(db, {
      organizationId,
      provider: "linear",
      externalId: workspace.id,
      name: workspace.name,
      credentials,
      installedByUserId: admin.id,
    });
  } catch (error) {
    console.error("Linear OAuth callback failed", {
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    });
    return to("/settings/integrations?linear=error");
  }
  if (saved === "other_organization") return to("/settings/integrations?linear=other_organization");
  return to("/settings/integrations?linear=connected");
}

export const GET = liveRoute(get);
