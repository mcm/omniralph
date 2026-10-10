import "server-only";
import { getAppUrl } from "@/lib/app-url";

/**
 * Slack OAuth v2 for the deployment's Slack app: each organization's admin
 * installs it into their workspace (or, for an org-wide install, their
 * Enterprise Grid organization) and we keep the workspace's bot token.
 */

/** Bot scopes; must match `oauth_config.scopes.bot` in docs/slack-app-manifest.yaml. */
export const SLACK_BOT_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:read",
  "chat:write",
  "files:read",
  "groups:history",
  "groups:read",
  "reactions:read",
  "reactions:write",
  "users:read",
  "users:read.email",
];
export const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
export const SLACK_TOKEN_URL = "https://slack.com/api/oauth.v2.access";
export const SLACK_REVOKE_URL = "https://slack.com/api/auth.revoke";
export const SLACK_CALLBACK_PATH = "/api/integrations/slack/callback";
/** Bounds token and revoke calls so a hung Slack endpoint can't stall a callback. */
export const SLACK_OAUTH_TIMEOUT_MS = 10_000;

export interface SlackOAuthConfig {
  clientId: string;
  clientSecret: string;
  signingSecret: string;
}

/**
 * `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` / `SLACK_SIGNING_SECRET`, or null
 * unless all are set (without the signing secret no event could be verified).
 */
export function slackOAuthConfig(env: NodeJS.ProcessEnv = process.env): SlackOAuthConfig | null {
  const clientId = env.SLACK_CLIENT_ID?.trim();
  const clientSecret = env.SLACK_CLIENT_SECRET?.trim();
  const signingSecret = env.SLACK_SIGNING_SECRET?.trim();
  return clientId && clientSecret && signingSecret
    ? { clientId, clientSecret, signingSecret }
    : null;
}

export function slackRedirectUri(env: NodeJS.ProcessEnv = process.env): string {
  return `${getAppUrl(env)}${SLACK_CALLBACK_PATH}`;
}

export function slackAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    scope: SLACK_BOT_SCOPES.join(","),
    redirect_uri: redirectUri,
    state,
  });
  return `${SLACK_AUTHORIZE_URL}?${params.toString()}`;
}

/** The stored (encrypted) credentials of a Slack connection. */
export interface SlackCredentials {
  botToken: string;
  botUserId: string;
  appId: string;
  scope: string;
  /** Absent for an org-wide (Enterprise Grid) install. */
  teamId?: string;
  enterpriseId?: string;
  isEnterpriseInstall: boolean;
}

/** A completed installation: the connection's external ID and name, and its credentials. */
export interface SlackInstallation {
  /** The team ID, or the enterprise ID for an org-wide install. */
  externalId: string;
  name: string;
  credentials: SlackCredentials;
}

interface OAuthV2AccessResponse {
  ok: boolean;
  error?: string;
  access_token?: string;
  token_type?: string;
  scope?: string;
  bot_user_id?: string;
  app_id?: string;
  team?: { id: string; name: string } | null;
  enterprise?: { id: string; name: string } | null;
  is_enterprise_install?: boolean;
}

export class SlackOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackOAuthError";
  }
}

/** Exchanges the authorization code with `oauth.v2.access`. */
export async function exchangeSlackCode(
  config: SlackOAuthConfig,
  opts: { code: string; redirectUri: string },
  fetchImpl: typeof fetch = fetch,
): Promise<SlackInstallation> {
  const res = await fetchImpl(SLACK_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code: opts.code,
      redirect_uri: opts.redirectUri,
    }),
    signal: AbortSignal.timeout(SLACK_OAUTH_TIMEOUT_MS),
  });
  if (!res.ok) throw new SlackOAuthError(`Slack oauth.v2.access returned ${res.status}`);
  // Slack reports errors (`invalid_code`, …) as `ok: false` with HTTP 200; never with our secrets.
  const body = (await res.json()) as OAuthV2AccessResponse;
  if (!body.ok) throw new SlackOAuthError(`Slack oauth.v2.access failed: ${body.error}`);
  if (body.token_type !== "bot" || !body.access_token || !body.bot_user_id || !body.app_id) {
    throw new SlackOAuthError("Slack oauth.v2.access returned no bot token");
  }
  const isEnterpriseInstall = body.is_enterprise_install === true;
  const owner = isEnterpriseInstall ? body.enterprise : body.team;
  if (!owner?.id) throw new SlackOAuthError("Slack oauth.v2.access returned no team");
  return {
    externalId: owner.id,
    name: owner.name,
    credentials: {
      botToken: body.access_token,
      botUserId: body.bot_user_id,
      appId: body.app_id,
      scope: body.scope ?? "",
      ...(body.team?.id && { teamId: body.team.id }),
      ...(body.enterprise?.id && { enterpriseId: body.enterprise.id }),
      isEnterpriseInstall,
    },
  };
}

/** Revokes a bot token with `auth.revoke` (best effort, e.g. on disconnect). */
export async function revokeSlackToken(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(SLACK_REVOKE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(SLACK_OAUTH_TIMEOUT_MS),
  });
  if (!res.ok) throw new SlackOAuthError(`Slack auth.revoke returned ${res.status}`);
  const body = (await res.json()) as { ok: boolean; error?: string };
  // A token that's already gone (app uninstalled, revoked) needs no revoking.
  if (!body.ok && body.error !== "invalid_auth" && body.error !== "token_revoked") {
    throw new SlackOAuthError(`Slack auth.revoke failed: ${body.error}`);
  }
}

// ── Signed state ─────────────────────────────────────────────────────────────

/** `lib/auth/signed-state.ts` purpose of the connect flow's `state` (user + organization). */
export const SLACK_OAUTH_STATE_PURPOSE = "slack-oauth";
/** Cookie holding the state's nonce, binding the flow to the browser that started it. */
export const SLACK_STATE_COOKIE = "omniralph_slack_oauth";
