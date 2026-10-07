import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";

/**
 * Signed `state` for flows that leave the control panel and come back (e.g. the
 * GitHub App installation): bound to the admin who started it, the organization
 * the result belongs to and, through a nonce cookie, the browser. Callbacks take
 * the organization from here, never from a query parameter alone, and consume
 * the nonce (`consumeOAuthState`) so a state works once.
 */
export const SIGNED_STATE_TTL_SECONDS = 10 * 60;

/** HS256 key for `purpose`, derived from `AUTH_SECRET` (never the secret itself). */
function stateKey(purpose: string, env: NodeJS.ProcessEnv): Uint8Array {
  const secret = env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  return createHmac("sha256", secret).update(`omniralph ${purpose} state`).digest();
}

/** A signed state for `userId` and `organizationId`, and the nonce to put in the flow's cookie. */
export async function createSignedState(
  purpose: string,
  input: { userId: string; organizationId: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ state: string; nonce: string }> {
  const nonce = randomBytes(16).toString("base64url");
  const state = await new SignJWT({ nonce, org: input.organizationId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(input.userId)
    .setAudience(`omniralph:${purpose}`)
    .setIssuedAt()
    .setExpirationTime(`${SIGNED_STATE_TTL_SECONDS}s`)
    .sign(stateKey(purpose, env));
  return { state, nonce };
}

/**
 * The organization, nonce and expiry of `state` when it was signed by us for
 * `purpose` within its lifetime, for this `userId`, and carries the nonce from the
 * browser's cookie; otherwise null.
 */
export async function readSignedState(
  purpose: string,
  state: string | null | undefined,
  expected: { userId: string; nonce: string | null | undefined },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ organizationId: string; nonce: string; expiresAt: Date } | null> {
  if (!state || !expected.nonce) return null;
  try {
    const { payload } = await jwtVerify(state, stateKey(purpose, env), {
      algorithms: ["HS256"],
      audience: `omniralph:${purpose}`,
      subject: expected.userId,
    });
    if (payload.nonce !== expected.nonce || typeof payload.exp !== "number") return null;
    if (typeof payload.org !== "string" || payload.org === "") return null;
    return {
      organizationId: payload.org,
      nonce: expected.nonce,
      expiresAt: new Date(payload.exp * 1000),
    };
  } catch {
    return null;
  }
}
