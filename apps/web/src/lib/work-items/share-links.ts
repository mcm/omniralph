import "server-only";
import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

/**
 * Public review links of a work item's PRD ("Share review link", `/share/{token}`): the
 * token (32 random bytes, base64url, shown once and stored as its SHA-256), the optional
 * password (`scrypt$N$r$p$salt$hash`, compared in constant time) and the cookie a correct
 * password sets (scoped to the link's path, signed with the session secret).
 */

/** How long a link works. */
export const SHARE_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Active links per work item. */
export const MAX_ACTIVE_SHARE_LINKS = 10;
/** How long a correct password opens the link in that browser. */
export const SHARE_ACCESS_TTL_SECONDS = 12 * 60 * 60;
/** Password attempts per link and IP in a minute. */
export const SHARE_PASSWORD_ATTEMPTS_PER_MINUTE = 10;
export const SHARE_PATH = "/share";
/** The cookie a correct password sets, scoped to `/share/{token}`. */
export const SHARE_ACCESS_COOKIE = "omniralph-share-access";

export const SHARE_LINK_LIMIT_MESSAGE = `This work item already has ${MAX_ACTIVE_SHARE_LINKS} active review links. Revoke one first.`;
export const SHARE_LINK_NOT_FOUND_MESSAGE = "That review link doesn't exist.";
export const SHARE_LINK_GONE_MESSAGE = "This review link has expired or doesn't exist.";
export const SHARE_WRONG_PASSWORD_MESSAGE = "That password isn't right.";
export const SHARE_TOO_MANY_ATTEMPTS_MESSAGE = "Too many attempts. Try again in a minute.";

/** Headers on every share page and share route response. */
export const SHARE_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "X-Robots-Tag": "noindex",
  "Referrer-Policy": "no-referrer",
};

/** A new link token: 32 random bytes in base64url (43 characters). */
export function newShareToken(): string {
  return randomBytes(32).toString("base64url");
}

/** What a token is stored as: its SHA-256, hex. */
export function hashShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Whether `value` looks like a token (so lookups skip anything else). */
export function isShareToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

/** The link's path, which the access cookie is scoped to. */
export function sharePath(token: string): string {
  return `${SHARE_PATH}/${token}`;
}

const SCRYPT = { N: 16384, r: 8, p: 1 } as const;
const SCRYPT_KEY_LENGTH = 32;

function scrypt(password: string, salt: Buffer, keyLength: number, options: ScryptOptions) {
  return new Promise<Buffer>((resolve, reject) =>
    scryptCallback(
      password,
      salt,
      keyLength,
      { ...options, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
}

/** A password as stored: `scrypt$N$r$p$salt$hash` (salt: 16 random bytes; base64url parts). */
export async function hashSharePassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT_KEY_LENGTH, SCRYPT);
  return [
    "scrypt",
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

/** Whether `password` matches `stored` (`hashSharePassword`), compared in constant time. */
export async function verifySharePassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  const salt = Buffer.from(parts[4]!, "base64url");
  const expected = Buffer.from(parts[5]!, "base64url");
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0) || expected.length === 0) {
    return false;
  }
  // Stored parameters are our own, but never let one ask for an unbounded amount of work.
  if (N > 1 << 20 || r > 32 || p > 16) return false;
  const actual = await scrypt(password, salt, expected.length, { N, r, p });
  return timingSafeEqual(actual, expected);
}

/** HMAC key for access cookies, derived from `AUTH_SECRET` (the session secret). */
function accessKey(env: NodeJS.ProcessEnv): Buffer {
  const secret = env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  return createHmac("sha256", secret).update("omniralph share access").digest();
}

function accessSignature(linkId: string, expiresAt: number, env: NodeJS.ProcessEnv): Buffer {
  return createHmac("sha256", accessKey(env)).update(`${linkId}.${expiresAt}`).digest();
}

/** The access cookie's value for the link: its expiry and a signature over both. */
export function createShareAccess(
  linkId: string,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const expiresAt = now.getTime() + SHARE_ACCESS_TTL_SECONDS * 1000;
  return `${expiresAt}.${accessSignature(linkId, expiresAt, env).toString("base64url")}`;
}

/** Whether `value` is an unexpired access cookie we signed for the link. */
export function verifyShareAccess(
  linkId: string,
  value: string | undefined,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!value) return false;
  const match = /^(\d{1,15})\.([A-Za-z0-9_-]+)$/.exec(value);
  if (!match) return false;
  const expiresAt = Number(match[1]);
  if (expiresAt <= now.getTime()) return false;
  const given = Buffer.from(match[2]!, "base64url");
  const expected = accessSignature(linkId, expiresAt, env);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The `Set-Cookie` options of the access cookie for `token`'s path. */
export function shareAccessCookieOptions(token: string, env: NodeJS.ProcessEnv = process.env) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env.NODE_ENV === "production",
    path: sharePath(token),
    maxAge: SHARE_ACCESS_TTL_SECONDS,
  };
}
