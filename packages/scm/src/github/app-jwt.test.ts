import { generateKeyPairSync } from "node:crypto";
import { decodeProtectedHeader, jwtVerify } from "jose";
import { describe, expect, it, vi } from "vitest";
import {
  APP_JWT_TTL_SECONDS,
  createAppJwtSigner,
  KmsAppJwtSigner,
  PemAppJwtSigner,
} from "./app-jwt.js";

const kmsMock = vi.hoisted(() => ({
  signJWT: vi.fn(async () => ({ token: "kms.jwt.token", keyId: "k1", algorithm: "RS256", fingerprint: "f" })),
}));
vi.mock("@vercel/kms", () => kmsMock);

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pkcs1Pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const pkcs8Pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);

describe("PemAppJwtSigner", () => {
  it.each([
    ["PKCS#1", pkcs1Pem],
    ["PKCS#8", pkcs8Pem],
    ["escaped newlines", pkcs1Pem.replace(/\n/g, "\\n")],
  ])("signs an RS256 app JWT from a %s key", async (_label, pem) => {
    const signer = new PemAppJwtSigner(pem, { now: () => NOW });
    const jwt = await signer.sign("12345");

    expect(decodeProtectedHeader(jwt.token)).toMatchObject({ alg: "RS256", typ: "JWT" });
    const { payload } = await jwtVerify(jwt.token, publicKey, {
      issuer: "12345",
      currentDate: new Date(NOW),
    });
    const nowSeconds = NOW / 1000;
    expect(payload.iat).toBe(nowSeconds - 60);
    expect(payload.exp).toBe(nowSeconds + APP_JWT_TTL_SECONDS);
    expect(jwt.expiresAt).toEqual(new Date(NOW + APP_JWT_TTL_SECONDS * 1000));
  });
});

describe("KmsAppJwtSigner", () => {
  it("signs with the external-origin issuer, iss = app ID, TTL 540s", async () => {
    const signJwt = vi.fn(async () => ({ token: "a.b.c", keyId: "k", algorithm: "RS256", fingerprint: "f" }));
    const signer = new KmsAppJwtSigner({ issuerId: "iss_github", signJwt, now: () => NOW });

    const jwt = await signer.sign("12345");

    expect(signJwt).toHaveBeenCalledWith({ issuerId: "iss_github", claims: { iss: "12345" }, ttl: 540 });
    expect(jwt).toEqual({ token: "a.b.c", expiresAt: new Date(NOW + 540_000) });
  });

  it("uses @vercel/kms signJWT by default", async () => {
    kmsMock.signJWT.mockClear();
    const jwt = await new KmsAppJwtSigner({ issuerId: "iss_default" }).sign("7");
    expect(jwt.token).toBe("kms.jwt.token");
    expect(kmsMock.signJWT).toHaveBeenCalledWith({ issuerId: "iss_default", claims: { iss: "7" }, ttl: 540 });
  });
});

describe("createAppJwtSigner", () => {
  it("prefers KMS when GITHUB_APP_KMS_ISSUER_ID is set", () => {
    const signer = createAppJwtSigner({ GITHUB_APP_KMS_ISSUER_ID: "iss_1", GITHUB_APP_PRIVATE_KEY: pkcs1Pem });
    expect(signer).toBeInstanceOf(KmsAppJwtSigner);
  });

  it("falls back to the PEM private key", () => {
    expect(createAppJwtSigner({ GITHUB_APP_PRIVATE_KEY: pkcs1Pem })).toBeInstanceOf(PemAppJwtSigner);
  });

  it("throws when neither is configured", () => {
    expect(() => createAppJwtSigner({})).toThrow(/GITHUB_APP_KMS_ISSUER_ID/);
  });
});
