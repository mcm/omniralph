import { saveIntegration } from "@omniralph/db";
import { NextResponse, type NextRequest } from "next/server";
import { AuthorizationError } from "@/lib/auth/roles";
import { ACCESS_DENIED_PATH, SIGN_IN_PATH } from "@/lib/auth/routes";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { SdkLinearGateway } from "@/lib/linear/gateway";
import {
  exchangeCode,
  LINEAR_CALLBACK_PATH,
  linearOAuthConfig,
  linearRedirectUri,
  STATE_COOKIE,
  verifyOAuthState,
} from "@/lib/linear/oauth";

/**
 * Linear's OAuth redirect: checks the signed `state` (same admin, same
 * browser, not expired), exchanges the code and stores the workspace and its
 * tokens as the Linear integration.
 */
export async function GET(request: NextRequest) {
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
  const validState = await verifyOAuthState(params.get("state"), {
    userId: admin.id,
    nonce: request.cookies.get(STATE_COOKIE)?.value,
  });
  if (!validState) return to("/settings/integrations?linear=invalid_state");
  // The admin declined on Linear's consent screen.
  if (params.get("error")) return to("/settings/integrations?linear=denied");
  const code = params.get("code");
  if (!code) return to("/settings/integrations?linear=invalid");
  const config = linearOAuthConfig();
  if (!config) return to("/settings/integrations?linear=not_configured");

  try {
    const credentials = await exchangeCode(config, { code, redirectUri: linearRedirectUri() });
    const organization = await new SdkLinearGateway(credentials.accessToken).getOrganization();
    await saveIntegration(getDb(), {
      provider: "linear",
      externalId: organization.id,
      name: organization.name,
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
  return to("/settings/integrations?linear=connected");
}
