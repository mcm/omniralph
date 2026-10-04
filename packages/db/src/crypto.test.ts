import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decrypt, encrypt, hashToken, parseEncryptionKey } from "./crypto.js";

const key = randomBytes(32).toString("base64");

describe("encrypt/decrypt", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("round-trips plaintext", () => {
    const secret = JSON.stringify({ token: "glpat-abc123", note: "ünïcødé ✓" });
    expect(decrypt(encrypt(secret, key), key)).toBe(secret);
  });

  it("uses ENCRYPTION_KEY when no key is passed", () => {
    vi.stubEnv("ENCRYPTION_KEY", key);
    expect(decrypt(encrypt("hello"))).toBe("hello");
  });

  it("accepts hex keys and Buffers", () => {
    const raw = randomBytes(32);
    const ciphertext = encrypt("hello", raw.toString("hex"));
    expect(decrypt(ciphertext, raw)).toBe("hello");
  });

  it("uses a fresh IV per call and never contains the plaintext", () => {
    const a = encrypt("same plaintext", key);
    const b = encrypt("same plaintext", key);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^v1:/);
    expect(a).not.toContain("same plaintext");
  });

  it("rejects tampered ciphertext", () => {
    const [version, iv, tag, ciphertext] = encrypt("hello world", key).split(":");
    const bytes = Buffer.from(ciphertext!, "base64url");
    bytes[0] = bytes[0]! ^ 0xff;
    const tampered = [version, iv, tag, bytes.toString("base64url")].join(":");
    expect(() => decrypt(tampered, key)).toThrow();
  });

  it("rejects a wrong key", () => {
    const ciphertext = encrypt("hello", key);
    expect(() => decrypt(ciphertext, randomBytes(32))).toThrow();
  });

  it("rejects malformed payloads", () => {
    expect(() => decrypt("not-encrypted", key)).toThrow("Malformed");
    expect(() => decrypt("v2:a:b:c", key)).toThrow("Malformed");
  });

  it("requires a key", () => {
    vi.stubEnv("ENCRYPTION_KEY", "");
    expect(() => encrypt("hello")).toThrow("ENCRYPTION_KEY is not set");
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => parseEncryptionKey(randomBytes(16).toString("base64"))).toThrow("32 bytes");
    expect(() => encrypt("hello", randomBytes(31))).toThrow("32 bytes");
  });
});

describe("hashToken", () => {
  it("returns the SHA-256 hex digest", () => {
    expect(hashToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is deterministic and distinguishes tokens", () => {
    expect(hashToken("token-1")).toBe(hashToken("token-1"));
    expect(hashToken("token-1")).not.toBe(hashToken("token-2"));
    expect(hashToken("token-1")).toMatch(/^[0-9a-f]{64}$/);
  });
});
