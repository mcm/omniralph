import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { getAppUrl } from "@/lib/app-url";

/**
 * Linear OAuth for an agent app (`actor=app`): the app becomes a workspace
 * member that can be delegated issues and @mentioned (ported from cyralph).
 */
export const LINEAR_SCOPES = ["read", "write", "app:assignable", "app:mentionable"];
export const LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
export const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
export const LINEAR_REVOKE_URL = "https://api.linear.app/oauth/revoke";
export const LINEAR_CALLBACK_PATH = "/api/integrations/linear/callback";
/** Bounds token and revoke calls so a hung Linear endpoint can't stall a callback or run lock. */
export const LINEAR_OAUTH_TIMEOUT_MS = 10_000;

export interface LinearOAuthConfig {
  clientId: string;
  clientSecret: string;
}

/** `LINEAR_CLIENT_ID` / `LINEAR_CLIENT_SECRET`, or null when the Linear app isn't configured. */
export function linearOAuthConfig(env: NodeJS.ProcessEnv = process.env): LinearOAuthConfig | null {
  const clientId = env.LINEAR_CLIENT_ID?.trim();
  const clientSecret = env.LINEAR_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function linearRedirectUri(env: NodeJS.ProcessEnv = process.env): string {
  return `${getAppUrl(env)}${LINEAR_CALLBACK_PATH}`;
}

export function authorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: LINEAR_SCOPES.join(","),
    actor: "app",
    state,
    prompt: "consent",
  });
  return `${LINEAR_AUTHORIZE_URL}?${params.toString()}`;
}

/** The stored (encrypted) credentials of the Linear integration. */
export interface LinearCredentials {
  accessToken: string;
  /** Absent for legacy long-lived tokens, which are never refreshed. */
  refreshToken?: string;
  /** ISO timestamp; absent when the token doesn't expire. */
  expiresAt?: string;
  scope?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type: string;
  scope?: string;
}

export class LinearOAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "LinearOAuthError";
  }
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(LINEAR_OAUTH_TIMEOUT_MS),
  });
  if (!res.ok) {
    // The error body (`invalid_grant` etc.) never contains the secrets we sent.
    throw new LinearOAuthError(
      `Linear token endpoint returned ${res.status}: ${(await res.text()).slice(0, 500)}`,
      res.status,
    );
  }
  return (await res.json()) as TokenResponse;
}

function toCredentials(
  token: TokenResponse,
  now: number,
  previous?: LinearCredentials,
): LinearCredentials {
  const refreshToken = token.refresh_token ?? previous?.refreshToken;
  return {
    accessToken: token.access_token,
    ...(refreshToken && { refreshToken }),
    ...(token.expires_in !== undefined && {
      expiresAt: new Date(now + token.expires_in * 1000).toISOString(),
    }),
    ...(token.scope && { scope: token.scope }),
  };
}

export async function exchangeCode(
  config: LinearOAuthConfig,
  opts: { redirectUri: string; code: string; now?: number },
): Promise<LinearCredentials> {
  const token = await tokenRequest({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  return toCredentials(token, opts.now ?? Date.now());
}

/** Exchanges the refresh token; keeps the old refresh token if Linear doesn't rotate it. */
export async function refreshCredentials(
  config: LinearOAuthConfig,
  current: LinearCredentials,
  now = Date.now(),
): Promise<LinearCredentials> {
  if (!current.refreshToken) throw new Error("The Linear token has no refresh token");
  const token = await tokenRequest({
    grant_type: "refresh_token",
    refresh_token: current.refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  return toCredentials(token, now, current);
}

/** Revokes the access token (best effort, e.g. on disconnect). */
export async function revokeToken(accessToken: string): Promise<void> {
  const res = await fetch(LINEAR_REVOKE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(LINEAR_OAUTH_TIMEOUT_MS),
  });
  if (!res.ok && res.status !== 400 && res.status !== 401) {
    throw new LinearOAuthError(`Linear revoke returned ${res.status}`, res.status);
  }
}

// ── Signed state ─────────────────────────────────────────────────────────────

const STATE_AUDIENCE = "omniralph:linear-oauth";
const STATE_TTL_SECONDS = 10 * 60;
/** Cookie holding the state's nonce, binding the flow to the browser that started it. */
export const STATE_COOKIE = "omniralph_linear_oauth";

/** HS256 key for OAuth states, derived from `AUTH_SECRET` (never the secret itself). */
function stateKey(env: NodeJS.ProcessEnv = process.env): Uint8Array {
  const secret = env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  return createHmac("sha256", secret).update("omniralph linear oauth state").digest();
}

/** A signed `state` for the admin `userId`, and the nonce to put in `STATE_COOKIE`. */
export async function createOAuthState(
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ state: string; nonce: string }> {
  const nonce = randomBytes(16).toString("base64url");
  const state = await new SignJWT({ nonce })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setAudience(STATE_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${STATE_TTL_SECONDS}s`)
    .sign(stateKey(env));
  return { state, nonce };
}

/**
 * The state's nonce and expiry when `state` was signed by us within its
 * lifetime, for this `userId`, and carries the nonce from the browser's
 * cookie; otherwise null. Callers consume the nonce (`consumeOAuthState`) so
 * the state works once.
 */
export async function readOAuthState(
  state: string | null | undefined,
  expected: { userId: string; nonce: string | null | undefined },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ nonce: string; expiresAt: Date } | null> {
  if (!state || !expected.nonce) return null;
  try {
    const { payload } = await jwtVerify(state, stateKey(env), {
      algorithms: ["HS256"],
      audience: STATE_AUDIENCE,
      subject: expected.userId,
    });
    if (payload.nonce !== expected.nonce || typeof payload.exp !== "number") return null;
    return { nonce: expected.nonce, expiresAt: new Date(payload.exp * 1000) };
  } catch {
    return null;
  }
}

/** True when `readOAuthState` accepts `state`. */
export async function verifyOAuthState(
  state: string | null | undefined,
  expected: { userId: string; nonce: string | null | undefined },
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return (await readOAuthState(state, expected, env)) !== null;
}
