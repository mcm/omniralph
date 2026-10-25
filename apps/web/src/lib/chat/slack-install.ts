import "server-only";
import {
  consumeOAuthState,
  getChatConnectionByExternalId,
  saveChatConnection,
} from "@omniralph/db";
import { NextResponse, type NextRequest } from "next/server";
import {
  createSignedState,
  readSignedState,
  SIGNED_STATE_TTL_SECONDS,
} from "@/lib/auth/signed-state";
import { getDb } from "@/lib/db";
import { connectingWithHistory, settingsActor } from "@/lib/settings-history/sections";
import { INTEGRATIONS_PATH, requireInstallAdmin } from "./install-auth";
import {
  exchangeSlackCode,
  SLACK_CALLBACK_PATH,
  SLACK_OAUTH_STATE_PURPOSE,
  SLACK_STATE_COOKIE,
  slackAuthorizeUrl,
  slackOAuthConfig,
  slackRedirectUri,
  type SlackCredentials,
} from "./slack-oauth";

/**
 * Settings › Integrations › Connect Slack: sends an admin to Slack's install
 * screen with a signed `state` naming their active organization, bound to
 * them and to this browser.
 */
export async function slackConnect(request: NextRequest): Promise<NextResponse> {
  const to = (path: string) => NextResponse.redirect(new URL(path, request.url));
  const admin = await requireInstallAdmin(to);
  if (admin instanceof NextResponse) return admin;
  const config = slackOAuthConfig();
  if (!config) return to(`${INTEGRATIONS_PATH}?slack=not_configured`);

  const { state, nonce } = await createSignedState(SLACK_OAUTH_STATE_PURPOSE, {
    userId: admin.id,
    organizationId: admin.organization.id,
  });
  const response = NextResponse.redirect(
    slackAuthorizeUrl(config.clientId, slackRedirectUri(), state),
  );
  response.cookies.set(SLACK_STATE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    path: SLACK_CALLBACK_PATH,
    maxAge: SIGNED_STATE_TTL_SECONDS,
  });
  return response;
}

export interface SlackCallbackDeps {
  /** Calls Slack's `oauth.v2.access`; injected in tests. */
  fetch?: typeof fetch;
}

/**
 * Slack's OAuth redirect: checks the signed `state` (same admin, same browser,
 * the admin's active organization, not expired, not used before) and consumes
 * it, exchanges the code and stores the workspace (or Enterprise Grid
 * organization, for an org-wide install) and its bot token as a chat
 * connection of the organization. A workspace connected to another
 * organization is refused (`?slack=other_organization`).
 */
export async function slackCallback(
  request: NextRequest,
  deps: SlackCallbackDeps = {},
): Promise<NextResponse> {
  const to = (path: string) => {
    const response = NextResponse.redirect(new URL(path, request.url));
    response.cookies.delete({ name: SLACK_STATE_COOKIE, path: SLACK_CALLBACK_PATH });
    return response;
  };
  const notice = (value: string) => to(`${INTEGRATIONS_PATH}?slack=${value}`);
  const admin = await requireInstallAdmin(to);
  if (admin instanceof NextResponse) return admin;

  const params = request.nextUrl.searchParams;
  const db = getDb();
  const organizationId = admin.organization.id;
  const signed = await readSignedState(SLACK_OAUTH_STATE_PURPOSE, params.get("state"), {
    userId: admin.id,
    nonce: request.cookies.get(SLACK_STATE_COOKIE)?.value,
  });
  // A state works once (a replayed callback is rejected), and only for the
  // organization the admin is working in.
  if (
    !signed ||
    signed.organizationId !== organizationId ||
    !(await consumeOAuthState(db, signed.nonce, signed.expiresAt))
  ) {
    return notice("invalid_state");
  }
  // The admin cancelled on Slack's install screen.
  if (params.get("error")) return notice("denied");
  const code = params.get("code");
  if (!code) return notice("invalid");
  const config = slackOAuthConfig();
  if (!config) return notice("not_configured");

  let saved;
  try {
    const installation = await exchangeSlackCode(
      config,
      { code, redirectUri: slackRedirectUri() },
      deps.fetch,
    );
    const existing = await getChatConnectionByExternalId(db, "slack", installation.externalId);
    saved = await connectingWithHistory(
      db,
      settingsActor(admin),
      organizationId,
      existing?.organizationId === organizationId ? existing.id : null,
      (tx) =>
        saveChatConnection<SlackCredentials>(tx, {
          organizationId,
          platform: "slack",
          externalId: installation.externalId,
          name: installation.name,
          credentials: installation.credentials,
          installedByUserId: admin.id,
        }),
      (result) => (result === "other_organization" ? null : result.id),
    );
  } catch (error) {
    console.error("Slack OAuth callback failed", {
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    });
    return notice("error");
  }
  if (saved === "other_organization") return notice("other_organization");
  return notice("connected");
}
