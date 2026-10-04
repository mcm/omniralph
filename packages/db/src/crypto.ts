/**
 * Secrets at rest. SCM credentials are encrypted with AES-256-GCM under
 * `ENCRYPTION_KEY`; enrollment and refresh tokens are stored only as SHA-256
 * hashes.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = "v1";

/**
 * Parses a 32-byte key given as 64 hex characters or base64. Generate one
 * with `openssl rand -base64 32`.
 */
export function parseEncryptionKey(raw: string): Buffer {
  const value = raw.trim();
  const key = /^[0-9a-f]{64}$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (hex or base64), got ${key.length}`,
    );
  }
  return key;
}

function resolveKey(key: string | Buffer | undefined): Buffer {
  if (Buffer.isBuffer(key)) {
    if (key.length !== KEY_BYTES) throw new Error(`Encryption key must be ${KEY_BYTES} bytes`);
    return key;
  }
  const raw = key ?? process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error("ENCRYPTION_KEY is not set");
  return parseEncryptionKey(raw);
}

/**
 * Encrypts `plaintext` with AES-256-GCM. Returns `v1:<iv>:<tag>:<ciphertext>`
 * (base64url parts). A fresh random IV is used per call.
 */
export function encrypt(plaintext: string, key?: string | Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, resolveKey(key), iv, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, ciphertext]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(":");
}

/** Decrypts a value produced by `encrypt()`. Throws if it was tampered with or the key is wrong. */
export function decrypt(payload: string, key?: string | Buffer): string {
  const parts = payload.split(":");
  const [version, iv, tag, ciphertext] = parts;
  if (
    parts.length !== 4 ||
    version !== VERSION ||
    iv === undefined ||
    tag === undefined ||
    ciphertext === undefined
  ) {
    throw new Error("Malformed encrypted payload");
  }
  const ivBytes = Buffer.from(iv, "base64url");
  const tagBytes = Buffer.from(tag, "base64url");
  if (ivBytes.length !== IV_BYTES || tagBytes.length !== TAG_BYTES) {
    throw new Error("Malformed encrypted payload");
  }
  const decipher = createDecipheriv(ALGORITHM, resolveKey(key), ivBytes, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAuthTag(tagBytes);
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/** SHA-256 hex digest of a token, for storing enrollment and refresh tokens. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
