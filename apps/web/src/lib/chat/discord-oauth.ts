import "server-only";
import { getAppUrl } from "@/lib/app-url";

/**
 * Discord OAuth2 for the deployment's Discord application: each organization's
 * admin adds its bot to their server. The deployment-wide bot token serves
 * every server, so a connection stores no credentials.
 */

export const DISCORD_SCOPES = ["bot", "applications.commands"];
/**
 * Bot permissions requested when it's added to a server: View Channels, Send
 * Messages, Send Messages in Threads, Create Public Threads, Read Message
 * History and Add Reactions.
 */
export const DISCORD_BOT_PERMISSIONS = [
  1n << 10n, // VIEW_CHANNEL
  1n << 11n, // SEND_MESSAGES
  1n << 38n, // SEND_MESSAGES_IN_THREADS
  1n << 35n, // CREATE_PUBLIC_THREADS
  1n << 16n, // READ_MESSAGE_HISTORY
  1n << 6n, // ADD_REACTIONS
].reduce((all, bit) => all | bit, 0n);
export const DISCORD_AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
export const DISCORD_TOKEN_URL = "https://discord.com/api/oauth2/token";
export const DISCORD_API_URL = "https://discord.com/api/v10";
export const DISCORD_CALLBACK_PATH = "/api/integrations/discord/callback";
/** Bounds token and leave calls so a hung Discord endpoint can't stall a request. */
export const DISCORD_OAUTH_TIMEOUT_MS = 10_000;

export interface DiscordOAuthConfig {
  /** The application ID, which is also the OAuth2 client ID. */
  applicationId: string;
  clientSecret: string;
  botToken: string;
  publicKey: string;
}

/**
 * `DISCORD_APPLICATION_ID` / `DISCORD_CLIENT_SECRET` / `DISCORD_BOT_TOKEN` /
 * `DISCORD_PUBLIC_KEY`, or null unless all are set (without the bot token
 * nothing could be posted, without the public key no interaction verified).
 */
export function discordOAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): DiscordOAuthConfig | null {
  const applicationId = env.DISCORD_APPLICATION_ID?.trim();
  const clientSecret = env.DISCORD_CLIENT_SECRET?.trim();
  const botToken = env.DISCORD_BOT_TOKEN?.trim();
  const publicKey = env.DISCORD_PUBLIC_KEY?.trim();
  return applicationId && clientSecret && botToken && publicKey
    ? { applicationId, clientSecret, botToken, publicKey }
    : null;
}

export function discordRedirectUri(env: NodeJS.ProcessEnv = process.env): string {
  return `${getAppUrl(env)}${DISCORD_CALLBACK_PATH}`;
}

export function discordAuthorizeUrl(
  applicationId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: applicationId,
    scope: DISCORD_SCOPES.join(" "),
    permissions: DISCORD_BOT_PERMISSIONS.toString(),
    response_type: "code",
    redirect_uri: redirectUri,
    state,
  });
  return `${DISCORD_AUTHORIZE_URL}?${params.toString()}`;
}

/** The server the bot was added to. */
export interface DiscordGuild {
  id: string;
  name: string;
}

interface TokenResponse {
  access_token?: string;
  guild?: { id?: string; name?: string } | null;
}

export class DiscordOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscordOAuthError";
  }
}

/**
 * Exchanges the authorization code at Discord's token endpoint and returns the
 * server the bot was added to, as Discord reports it in the token response.
 */
export async function exchangeDiscordCode(
  config: DiscordOAuthConfig,
  opts: { code: string; redirectUri: string },
  fetchImpl: typeof fetch = fetch,
): Promise<DiscordGuild> {
  const res = await fetchImpl(DISCORD_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.applicationId,
      client_secret: config.clientSecret,
      grant_type: "authorization_code",
      code: opts.code,
      redirect_uri: opts.redirectUri,
    }),
    signal: AbortSignal.timeout(DISCORD_OAUTH_TIMEOUT_MS),
  });
  // Error bodies (`invalid_grant`, …) never contain our secrets, but aren't needed either.
  if (!res.ok) throw new DiscordOAuthError(`Discord token endpoint returned ${res.status}`);
  const body = (await res.json()) as TokenResponse;
  if (!body.access_token) throw new DiscordOAuthError("Discord returned no access token");
  const { id, name } = body.guild ?? {};
  if (!id || !name) throw new DiscordOAuthError("Discord returned no guild");
  return { id, name };
}

/**
 * Makes the bot leave a server (best effort, e.g. on disconnect). A server the
 * bot isn't in any more counts as left.
 */
export async function leaveDiscordGuild(
  config: Pick<DiscordOAuthConfig, "botToken">,
  guildId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(
    `${DISCORD_API_URL}/users/@me/guilds/${encodeURIComponent(guildId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bot ${config.botToken}` },
      signal: AbortSignal.timeout(DISCORD_OAUTH_TIMEOUT_MS),
    },
  );
  if (!res.ok && res.status !== 404) {
    throw new DiscordOAuthError(`Discord leave guild returned ${res.status}`);
  }
}

// ── Signed state ─────────────────────────────────────────────────────────────

/** `lib/auth/signed-state.ts` purpose of the connect flow's `state` (user + organization). */
export const DISCORD_OAUTH_STATE_PURPOSE = "discord-oauth";
/** Cookie holding the state's nonce, binding the flow to the browser that started it. */
export const DISCORD_STATE_COOKIE = "omniralph_discord_oauth";
