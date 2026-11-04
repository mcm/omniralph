import "server-only";
import { randomBytes } from "node:crypto";
import { authenticateApiToken, hashToken, type Database } from "@omniralph/db";
import { parseSoundPreference } from "@/lib/sound/preference";
import { parseTheme } from "@/lib/theme";
import { AuthorizationError } from "./roles";
import type { OrgUser } from "./session";

/**
 * Personal API tokens (You › API tokens): `omr_` and 32 random bytes, base64url. Tools send
 * one as `Authorization: Bearer <token>` to the `/api/ui` routes that accept tokens
 * (`apiHandler({ apiTokens: true })`), acting as the token's member in its organization.
 */
export const API_TOKEN_PREFIX = "omr_";
const API_TOKEN_PATTERN = /^omr_[A-Za-z0-9_-]{43}$/;
/** How much of a token the list shows: the prefix and four more characters. */
const DISPLAY_PREFIX_LENGTH = API_TOKEN_PREFIX.length + 4;

export const INVALID_API_TOKEN_MESSAGE =
  "That API token isn't valid. Create a new one in Settings.";

/** A new token, its hash to store and the prefix to show. */
export function generateApiToken(): { token: string; tokenHash: string; prefix: string } {
  const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { token, tokenHash: hashToken(token), prefix: token.slice(0, DISPLAY_PREFIX_LENGTH) };
}

/** True when the request carries an `Authorization` header (of any scheme). */
export function hasAuthorizationHeader(request: Request): boolean {
  return request.headers.has("authorization");
}

/**
 * The member an `Authorization: Bearer <token>` header acts as, in the token's organization.
 * Throws `AuthorizationError("unauthenticated")` for another scheme, a malformed token, or a
 * token that is unknown, revoked or whose member left the organization.
 */
export async function requireApiTokenUser(db: Database, request: Request): Promise<OrgUser> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer[ ]+(\S+)[ ]*$/i.exec(header);
  const token = match?.[1];
  if (!token || !API_TOKEN_PATTERN.test(token)) {
    throw new AuthorizationError(INVALID_API_TOKEN_MESSAGE, "unauthenticated");
  }
  const identity = await authenticateApiToken(db, hashToken(token));
  if (!identity) throw new AuthorizationError(INVALID_API_TOKEN_MESSAGE, "unauthenticated");
  const { user, organization, role } = identity;
  return {
    id: user.id,
    organization,
    role,
    name: user.name,
    email: user.email,
    image: user.image,
    theme: parseTheme(user.theme),
    showAdvanced: user.showAdvanced,
    sound: parseSoundPreference(user.soundEnabled, user.soundVolume),
  };
}
