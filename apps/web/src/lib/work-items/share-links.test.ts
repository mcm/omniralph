import { createHash } from "node:crypto";
import * as crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof crypto>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const {
  createShareAccess,
  hashSharePassword,
  hashShareToken,
  isShareToken,
  newShareToken,
  SHARE_ACCESS_TTL_SECONDS,
  shareAccessCookieOptions,
  verifyShareAccess,
  verifySharePassword,
} = await import("./share-links");

const env = { AUTH_SECRET: "session-secret" } as unknown as NodeJS.ProcessEnv;

afterEach(() => vi.mocked(crypto.timingSafeEqual).mockClear());

describe("share link tokens", () => {
  it("are 32 random bytes in base64url (43 characters), stored as their SHA-256", () => {
    const token = newShareToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(isShareToken(token)).toBe(true);
    expect(newShareToken()).not.toBe(token);
    expect(hashShareToken(token)).toBe(createHash("sha256").update(token).digest("hex"));
    expect(isShareToken("abc")).toBe(false);
    expect(isShareToken(`${token.slice(0, 42)}=`)).toBe(false);
  });
});

describe("share link passwords", () => {
  it("are stored as scrypt$N$r$p$salt$hash with a random 16-byte salt", async () => {
    const stored = await hashSharePassword("hunter2");
    const [scheme, N, r, p, salt, hash] = stored.split("$");
    expect([scheme, N, r, p]).toEqual(["scrypt", "16384", "8", "1"]);
    expect(Buffer.from(salt!, "base64url")).toHaveLength(16);
    expect(Buffer.from(hash!, "base64url")).toHaveLength(32);
    expect(stored).not.toContain("hunter2");
    expect(await hashSharePassword("hunter2")).not.toBe(stored);
  });

  it("are verified with timingSafeEqual", async () => {
    const stored = await hashSharePassword("hunter2");
    expect(await verifySharePassword("hunter2", stored)).toBe(true);
    expect(crypto.timingSafeEqual).toHaveBeenCalledTimes(1);
    expect(await verifySharePassword("hunter3", stored)).toBe(false);
    expect(await verifySharePassword("", stored)).toBe(false);
    expect(crypto.timingSafeEqual).toHaveBeenCalledTimes(3);
  });

  it("refuses a malformed or unbounded stored hash", async () => {
    expect(await verifySharePassword("x", "plain")).toBe(false);
    expect(await verifySharePassword("x", "bcrypt$1$2$3$4$5")).toBe(false);
    expect(await verifySharePassword("x", "scrypt$9999999999$8$1$c2FsdA$aGFzaA")).toBe(false);
  });
});

describe("share access cookies", () => {
  const now = new Date("2026-10-26T12:00:00Z");

  it("open the link they were signed for, for 12 hours", () => {
    const value = createShareAccess("link-1", now, env);
    expect(verifyShareAccess("link-1", value, now, env)).toBe(true);
    const later = new Date(now.getTime() + SHARE_ACCESS_TTL_SECONDS * 1000 - 1);
    expect(verifyShareAccess("link-1", value, later, env)).toBe(true);
    const expired = new Date(now.getTime() + SHARE_ACCESS_TTL_SECONDS * 1000);
    expect(verifyShareAccess("link-1", value, expired, env)).toBe(false);
  });

  it("don't open another link, nor survive tampering or another secret", () => {
    const value = createShareAccess("link-1", now, env);
    expect(verifyShareAccess("link-2", value, now, env)).toBe(false);
    const [expiresAt, signature] = value.split(".");
    expect(verifyShareAccess("link-1", `${Number(expiresAt) + 1}.${signature}`, now, env)).toBe(
      false,
    );
    expect(verifyShareAccess("link-1", `${expiresAt}.x${signature}`, now, env)).toBe(false);
    const other = { AUTH_SECRET: "another" } as unknown as NodeJS.ProcessEnv;
    expect(verifyShareAccess("link-1", value, now, other)).toBe(false);
    expect(verifyShareAccess("link-1", undefined, now, env)).toBe(false);
    expect(verifyShareAccess("link-1", "garbage", now, env)).toBe(false);
  });

  it("are HTTP-only and scoped to the link's path", () => {
    expect(
      shareAccessCookieOptions("tok", { NODE_ENV: "production" } as NodeJS.ProcessEnv),
    ).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/share/tok",
      maxAge: 12 * 60 * 60,
    });
  });
});
