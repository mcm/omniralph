import "server-only";
import { agentWakeChannel, orgWakeChannel, type AblyToken } from "@omniralph/shared";
import { SignJWT } from "jose";

type Env = Record<string, string | undefined>;

/** Lifetime of a harness's Ably token, in seconds. */
export const ABLY_TOKEN_TTL_SECONDS = 12 * 60 * 60;

/** A heartbeat hands out a new Ably token once the harness's expires within this. */
export const ABLY_TOKEN_RENEW_BEFORE_MS = 60 * 60 * 1000;

/** `ABLY_API_KEY` (`<keyName>:<keySecret>`) split in its two parts. */
export interface AblyConfig {
  keyName: string;
  keySecret: string;
}

/**
 * Ably's config from `ABLY_API_KEY`; null when it is unset (Ably is off and
 * harnesses long-poll their claims). A malformed key is logged and also turns
 * Ably off, so a typo can't break heartbeats or dispatch.
 */
export function getAblyConfig(env: Env = process.env): AblyConfig | null {
  const value = env.ABLY_API_KEY?.trim();
  if (!value) return null;
  const separator = value.indexOf(":");
  const keyName = value.slice(0, separator);
  const keySecret = value.slice(separator + 1);
  if (separator < 0 || !keyName || !keySecret) {
    console.error("ABLY_API_KEY must be <keyName>:<keySecret>; Ably wake-ups are off");
    return null;
  }
  return { keyName, keySecret };
}

/**
 * Signs a harness's Ably JWT locally with the key secret (HS256, `kid` = key
 * name; no Ably call): client ID = the harness, `subscribe` only on its two
 * wake channels, valid `ABLY_TOKEN_TTL_SECONDS`.
 */
export async function signAblyToken(
  config: AblyConfig,
  input: { harnessId: string; organizationId: string; now?: number },
): Promise<AblyToken> {
  return signAblyJwt(config, {
    clientId: input.harnessId,
    capability: {
      [agentWakeChannel(input.harnessId)]: ["subscribe"],
      [orgWakeChannel(input.organizationId)]: ["subscribe"],
    },
    ttlSeconds: ABLY_TOKEN_TTL_SECONDS,
    now: input.now,
  });
}

/**
 * Signs an Ably JWT locally with the key secret (HS256, `kid` = key name; no Ably
 * call) for `clientId` with `capability` (channel → operations), valid `ttlSeconds`.
 */
export async function signAblyJwt(
  config: AblyConfig,
  input: {
    clientId: string;
    capability: Record<string, string[]>;
    ttlSeconds: number;
    now?: number;
  },
): Promise<AblyToken> {
  const iat = Math.floor((input.now ?? Date.now()) / 1000);
  const exp = iat + input.ttlSeconds;
  const token = await new SignJWT({
    "x-ably-clientId": input.clientId,
    "x-ably-capability": JSON.stringify(input.capability),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT", kid: config.keyName })
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(config.keySecret));
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

/**
 * The heartbeat response's `ably`: null when Ably is off, a new token when the
 * harness has none (`tokenExpiresAt` absent) or its token expires within
 * `ABLY_TOKEN_RENEW_BEFORE_MS`, otherwise undefined (the field is omitted).
 */
export async function heartbeatAblyToken(
  config: AblyConfig | null,
  input: {
    harnessId: string;
    organizationId: string;
    tokenExpiresAt: string | undefined;
    now?: number;
  },
): Promise<AblyToken | null | undefined> {
  if (!config) return null;
  const now = input.now ?? Date.now();
  if (
    input.tokenExpiresAt !== undefined &&
    Date.parse(input.tokenExpiresAt) - now >= ABLY_TOKEN_RENEW_BEFORE_MS
  ) {
    return undefined;
  }
  return signAblyToken(config, { ...input, now });
}
