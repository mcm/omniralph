import { generateKeyPairSync } from "node:crypto";
import { VercelKmsError, type SignJWTOptions, type SignJWTResult } from "@vercel/kms";
import { decodeJwt, decodeProtectedHeader, jwtVerify, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import {
  APP_JWT_TTL_SECONDS,
  createAppJwtSigner,
  KmsAppJwtError,
  KmsAppJwtSigner,
  PemAppJwtSigner,
} from "./app-jwt.js";

const kmsMock = vi.hoisted(() => ({
  signJWT: vi.fn<(options: SignJWTOptions) => Promise<SignJWTResult>>(),
}));
vi.mock("@vercel/kms", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...kmsMock,
}));

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

type KmsMode = {
  /** The issuer's algorithm (KMS defaults to RS512). */
  alg?: "RS256" | "RS512";
  /** Whether caller-supplied registered claims win over KMS's own. */
  callerClaims?: "honored" | "overridden" | "rejected";
  /** Claims KMS forces onto every token (e.g. its issuer URL as `iss`). */
  forced?: Record<string, unknown>;
  kmsNow?: number;
};

/** Mimics `signJWT`: signs locally and sets `iat`/`nbf`/`exp` from `ttl` like KMS does. */
function fakeKms({
  alg = "RS256",
  callerClaims = "honored",
  forced = {},
  kmsNow = NOW,
}: KmsMode = {}) {
  return vi.fn(async ({ claims = {}, ttl }: SignJWTOptions): Promise<SignJWTResult> => {
    if (callerClaims === "rejected" && ("iat" in claims || "exp" in claims)) {
      throw new VercelKmsError({ status: 400, code: "invalid_claims", message: "reserved claim" });
    }
    const now = Math.floor(kmsNow / 1000);
    const kmsClaims = { iat: now, nbf: now, exp: now + (ttl ?? 300) };
    const payload =
      callerClaims === "overridden"
        ? { ...claims, ...kmsClaims, ...forced }
        : { ...kmsClaims, ...claims, ...forced };
    const token = await new SignJWT(payload)
      .setProtectedHeader({ alg, typ: "JWT", kid: "k1" })
      .sign(privateKey);
    return { token, keyId: "k1", algorithm: alg, fingerprint: "SHA256:f" };
  });
}

describe("KmsAppJwtSigner", () => {
  const nowSeconds = NOW / 1000;

  it("asks KMS for iss = app ID with a backdated iat and exp ≤ 600s", async () => {
    const signJwt = fakeKms();
    const signer = new KmsAppJwtSigner({ issuerId: "iss_github", signJwt, now: () => NOW });

    const jwt = await signer.sign("12345");

    expect(signJwt).toHaveBeenCalledWith({
      issuerId: "iss_github",
      claims: { iss: "12345", iat: nowSeconds - 60, exp: nowSeconds + APP_JWT_TTL_SECONDS },
      ttl: APP_JWT_TTL_SECONDS,
    });
    expect(decodeProtectedHeader(jwt.token).alg).toBe("RS256");
    const { payload } = await jwtVerify(jwt.token, publicKey, {
      issuer: "12345",
      currentDate: new Date(NOW),
    });
    expect(payload.iat).toBeLessThan(nowSeconds);
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(600);
    expect(payload.exp! - nowSeconds).toBeLessThanOrEqual(600);
    expect(jwt.expiresAt).toEqual(new Date(NOW + APP_JWT_TTL_SECONDS * 1000));
  });

  it("accepts KMS's own iat/exp when it overrides the caller's, taking expiresAt from the token", async () => {
    const signer = new KmsAppJwtSigner({
      issuerId: "iss_github",
      signJwt: fakeKms({ callerClaims: "overridden", kmsNow: NOW + 2000 }),
      now: () => NOW,
    });

    const jwt = await signer.sign("12345");

    const payload = decodeJwt(jwt.token);
    expect(payload.iss).toBe("12345");
    expect(payload.exp! - payload.iat!).toBe(APP_JWT_TTL_SECONDS);
    expect(jwt.expiresAt).toEqual(new Date((nowSeconds + 2 + APP_JWT_TTL_SECONDS) * 1000));
  });

  it("retries with iss alone when KMS rejects caller-set iat/exp", async () => {
    const signJwt = fakeKms({ callerClaims: "rejected" });
    const signer = new KmsAppJwtSigner({ issuerId: "iss_github", signJwt, now: () => NOW });

    const jwt = await signer.sign("12345");

    expect(signJwt).toHaveBeenCalledTimes(2);
    expect(signJwt.mock.calls[1]![0]).toEqual({
      issuerId: "iss_github",
      claims: { iss: "12345" },
      ttl: 540,
    });
    expect(decodeJwt(jwt.token)).toMatchObject({ iss: "12345", exp: nowSeconds + 540 });
  });

  it("refuses an RS512 issuer (the KMS default) with instructions to re-import as RS256", async () => {
    const signer = new KmsAppJwtSigner({
      issuerId: "iss_rs512",
      signJwt: fakeKms({ alg: "RS512" }),
      now: () => NOW,
    });

    const error = await signer.sign("12345").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KmsAppJwtError);
    expect((error as Error).message).toMatch(
      /iss_rs512.*RS512.*only accepts RS256.*--algorithm RS256/,
    );
  });

  it("refuses a token whose iss KMS replaced", async () => {
    const signer = new KmsAppJwtSigner({
      issuerId: "iss_github",
      signJwt: fakeKms({ forced: { iss: "https://kms.vercel.com/iss_github" } }),
      now: () => NOW,
    });

    await expect(signer.sign("12345")).rejects.toThrow(
      /iss is "https:\/\/kms\.vercel\.com\/iss_github".*"12345"/,
    );
  });

  it("refuses a token valid for longer than GitHub allows", async () => {
    const signer = new KmsAppJwtSigner({
      issuerId: "iss_github",
      signJwt: fakeKms({ forced: { exp: nowSeconds + 3600 } }),
      now: () => NOW,
    });

    await expect(signer.sign("12345")).rejects.toThrow(KmsAppJwtError);
  });

  it("does not swallow non-400 KMS errors", async () => {
    const signJwt = vi.fn(async () => {
      throw new VercelKmsError({
        status: 403,
        code: "oidc_token_not_authorized",
        message: "No matching issuer policy",
      });
    });
    const signer = new KmsAppJwtSigner({ issuerId: "iss_github", signJwt, now: () => NOW });

    await expect(signer.sign("12345")).rejects.toThrow(/No matching issuer policy/);
    expect(signJwt).toHaveBeenCalledTimes(1);
  });

  it("uses @vercel/kms signJWT by default", async () => {
    kmsMock.signJWT.mockClear();
    kmsMock.signJWT.mockImplementationOnce(fakeKms());
    const jwt = await new KmsAppJwtSigner({ issuerId: "iss_default" }).sign("7");
    expect(decodeJwt(jwt.token).iss).toBe("7");
    expect(kmsMock.signJWT).toHaveBeenCalledWith(
      expect.objectContaining({
        issuerId: "iss_default",
        ttl: 540,
        claims: expect.objectContaining({ iss: "7" }),
      }),
    );
  });
});

describe("createAppJwtSigner", () => {
  it("prefers KMS when GITHUB_APP_KMS_ISSUER_ID is set", () => {
    const signer = createAppJwtSigner({
      GITHUB_APP_KMS_ISSUER_ID: "iss_1",
      GITHUB_APP_PRIVATE_KEY: pkcs1Pem,
    });
    expect(signer).toBeInstanceOf(KmsAppJwtSigner);
  });

  it("falls back to the PEM private key", () => {
    expect(createAppJwtSigner({ GITHUB_APP_PRIVATE_KEY: pkcs1Pem })).toBeInstanceOf(
      PemAppJwtSigner,
    );
  });

  it("throws when neither is configured", () => {
    expect(() => createAppJwtSigner({})).toThrow(/GITHUB_APP_KMS_ISSUER_ID/);
  });
});
