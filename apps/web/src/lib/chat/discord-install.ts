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
import {
  DISCORD_CALLBACK_PATH,
  DISCORD_OAUTH_STATE_PURPOSE,
  DISCORD_STATE_COOKIE,
  DiscordOAuthError,
  discordAuthorizeUrl,
  discordOAuthConfig,
  discordRedirectUri,
  exchangeDiscordCode,
} from "./discord-oauth";
import {
  connectedPath,
  connectNoticePath,
  type ConnectNotice,
} from "@/lib/connections/connect-notices";
import { requireInstallAdmin } from "./install-auth";

/**
 * Settings › Add connection › Discord › Connect: sends an admin to Discord's
 * add-bot screen with a signed `state` naming their active organization,
 * bound to them and to this browser.
 */
export async function discordConnect(request: NextRequest): Promise<NextResponse> {
  const to = (path: string) => NextResponse.redirect(new URL(path, request.url));
  const admin = await requireInstallAdmin(to);
  if (admin instanceof NextResponse) return admin;
  const config = discordOAuthConfig();
  if (!config) return to(connectNoticePath("discord", "not_configured"));

  const { state, nonce } = await createSignedState(DISCORD_OAUTH_STATE_PURPOSE, {
    userId: admin.id,
    organizationId: admin.organization.id,
  });
  const response = NextResponse.redirect(
    discordAuthorizeUrl(config.applicationId, discordRedirectUri(), state),
  );
  response.cookies.set(DISCORD_STATE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    path: DISCORD_CALLBACK_PATH,
    maxAge: SIGNED_STATE_TTL_SECONDS,
  });
  return response;
}

export interface DiscordCallbackDeps {
  /** Calls Discord's token endpoint; injected in tests. */
  fetch?: typeof fetch;
}

/**
 * Discord's OAuth redirect: checks the signed `state` (same admin, same
 * browser, the admin's active organization, not expired, not used before) and
 * consumes it, exchanges the code and stores the server named in the token
 * response as a chat connection of the organization (no credentials: the
 * deployment's bot token serves every server). A `guild_id` in the query that
 * differs from the token response's guild is refused (`?discord=error`), and a
 * server connected to another organization too (`?discord=other_organization`).
 */
export async function discordCallback(
  request: NextRequest,
  deps: DiscordCallbackDeps = {},
): Promise<NextResponse> {
  const to = (path: string) => {
    const response = NextResponse.redirect(new URL(path, request.url));
    response.cookies.delete({ name: DISCORD_STATE_COOKIE, path: DISCORD_CALLBACK_PATH });
    return response;
  };
  const notice = (value: ConnectNotice) => to(connectNoticePath("discord", value));
  const admin = await requireInstallAdmin(to);
  if (admin instanceof NextResponse) return admin;

  const params = request.nextUrl.searchParams;
  const db = getDb();
  const organizationId = admin.organization.id;
  const signed = await readSignedState(DISCORD_OAUTH_STATE_PURPOSE, params.get("state"), {
    userId: admin.id,
    nonce: request.cookies.get(DISCORD_STATE_COOKIE)?.value,
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
  // The admin cancelled on Discord's add-bot screen.
  if (params.get("error")) return notice("denied");
  const code = params.get("code");
  if (!code) return notice("invalid");
  const config = discordOAuthConfig();
  if (!config) return notice("not_configured");

  let saved;
  try {
    // The server comes from the token response; the query's `guild_id` is
    // only cross-checked, never trusted on its own.
    const guild = await exchangeDiscordCode(
      config,
      { code, redirectUri: discordRedirectUri() },
      deps.fetch,
    );
    const queryGuildId = params.get("guild_id");
    if (queryGuildId !== null && queryGuildId !== guild.id) {
      throw new DiscordOAuthError("Discord's guild differs from the callback's guild_id");
    }
    const existing = await getChatConnectionByExternalId(db, "discord", guild.id);
    saved = await connectingWithHistory(
      db,
      settingsActor(admin),
      organizationId,
      existing?.organizationId === organizationId ? existing.id : null,
      (tx) =>
        saveChatConnection(tx, {
          organizationId,
          platform: "discord",
          externalId: guild.id,
          name: guild.name,
          credentials: null,
          installedByUserId: admin.id,
        }),
      (result) => (result === "other_organization" ? null : result.id),
    );
  } catch (error) {
    console.error("Discord OAuth callback failed", {
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    });
    return notice("error");
  }
  if (saved === "other_organization") return notice("other_organization");
  return to(connectedPath("discord", saved.id));
}
