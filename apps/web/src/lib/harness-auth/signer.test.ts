import { generateKeyPairSync } from "node:crypto";
import { decodeJwt, exportJWK, jwtVerify, SignJWT } from "jose";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { HARNESS_TOKEN_AUDIENCE } from "@omniralph/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const kms = vi.hoisted(() => ({ signJWT: vi.fn() }));
vi.mock("@vercel/kms", () => kms);

const {
  getTokenSigner,
  getVerificationKey,
  KmsTokenSigner,
  kmsJwksUrl,
  LocalSignerForbiddenError,
  LocalTokenSigner,
  resetTokenKeys,
} = await import("./signer");

const AGENT_ID = "5b1c7c1e-7a51-4d33-9d0f-5b2a3a7d1e01";
const JOB_ID = "0f6f0c55-4d41-4f2b-8a8c-3d9a2b6f7e02";

describe("LocalTokenSigner", () => {
  it("signs RS256 access tokens with the harness claims and a 900s TTL", async () => {
    const now = Date.UTC(2026, 9, 4, 12);
    const signer = new LocalTokenSigner({ env: {}, now: () => now });
    const token = await signer.signAccessToken(AGENT_ID);
    const { payload, protectedHeader } = await jwtVerify(token, signer.publicKey, {
      currentDate: new Date(now),
    });
    expect(protectedHeader.alg).toBe("RS256");
    expect(payload).toEqual({
      typ: "harness",
      sub: AGENT_ID,
      aud: "omniralph-harness",
      iat: now / 1000,
      exp: now / 1000 + 900,
    });
  });

  it("signs job tokens with the job, harness and scopes", async () => {
    const signer = new LocalTokenSigner({ env: {} });
    const token = await signer.signJobToken({
      jobId: JOB_ID,
      harnessId: AGENT_ID,
      scopes: ["credentials:read"],
    });
    const { payload } = await jwtVerify(token, signer.publicKey);
    expect(payload).toMatchObject({
      typ: "job",
      sub: JOB_ID,
      harnessId: AGENT_ID,
      scopes: ["credentials:read"],
      aud: "omniralph-harness",
    });
    expect(payload.exp! - payload.iat!).toBe(900);
  });

  it("signs for the omniralph-harness audience and the old omniralph-agent one is rejected", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const signer = new LocalTokenSigner({ privateKey, env: {} });
    expect(HARNESS_TOKEN_AUDIENCE).toBe("omniralph-harness");
    const token = await signer.signAccessToken(AGENT_ID);
    expect(decodeJwt(token).aud).toBe("omniralph-harness");
    // The verifier's audience check (verify.ts passes the same constant).
    const options = { algorithms: ["RS256"], audience: HARNESS_TOKEN_AUDIENCE };
    await expect(jwtVerify(token, signer.publicKey, options)).resolves.toBeTruthy();
    const old = await new SignJWT({ typ: "agent", sub: AGENT_ID, aud: "omniralph-agent" })
      .setProtectedHeader({ alg: "RS256" })
      .setExpirationTime("15m")
      .sign(privateKey);
    await expect(jwtVerify(old, signer.publicKey, options)).rejects.toThrow(/aud/);
  });

  it("loads LOCAL_AGENT_SIGNING_KEY PEMs, including literal \\n", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const signer = new LocalTokenSigner({ privateKey: pem.replace(/\n/g, "\\n"), env: {} });
    await expect(
      jwtVerify(await signer.signAccessToken(AGENT_ID), publicKey),
    ).resolves.toBeTruthy();
  });

  it("rejects non-RSA keys", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    expect(() => new LocalTokenSigner({ privateKey, env: {} })).toThrow(/RSA/);
  });

  it("refuses to run when VERCEL_ENV=production", async () => {
    expect(() => new LocalTokenSigner({ env: { VERCEL_ENV: "production" } })).toThrow(
      LocalSignerForbiddenError,
    );
    // Also when the environment changes after construction.
    const env: Record<string, string | undefined> = { VERCEL_ENV: "preview" };
    const signer = new LocalTokenSigner({ env });
    env.VERCEL_ENV = "production";
    await expect(signer.signAccessToken(AGENT_ID)).rejects.toThrow(LocalSignerForbiddenError);
  });
});

describe("KmsTokenSigner", () => {
  it("calls signJWT with the issuer, claims and TTL", async () => {
    kms.signJWT.mockResolvedValue({
      token: "kms.jwt.token",
      keyId: "k1",
      algorithm: "RS256",
      fingerprint: "SHA256:x",
    });
    const signer = new KmsTokenSigner({ issuerId: "iss_agents" });

    await expect(signer.signAccessToken(AGENT_ID)).resolves.toBe("kms.jwt.token");
    await signer.signJobToken({ jobId: JOB_ID, harnessId: AGENT_ID, scopes: ["credentials:read"] });

    expect(kms.signJWT.mock.calls).toEqual([
      [
        {
          issuerId: "iss_agents",
          claims: { typ: "harness", sub: AGENT_ID, aud: "omniralph-harness" },
          ttl: 900,
        },
      ],
      [
        {
          issuerId: "iss_agents",
          claims: {
            typ: "job",
            sub: JOB_ID,
            harnessId: AGENT_ID,
            scopes: ["credentials:read"],
            aud: "omniralph-harness",
          },
          ttl: 900,
        },
      ],
    ]);
  });
});

describe("getTokenSigner", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const server = setupServer(
    http.get("https://kms.vercel.com/iss_test/jwks.json", async () =>
      HttpResponse.json({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] }),
    ),
  );
  beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
  afterEach(() => resetTokenKeys());
  afterAll(() => server.close());

  it("uses KMS and the issuer's JWKS when KMS_AGENT_ISSUER_ID is set", async () => {
    const env = { KMS_AGENT_ISSUER_ID: "iss_test", VERCEL_ENV: "production" };
    expect(getTokenSigner(env)).toBeInstanceOf(KmsTokenSigner);
    expect(kmsJwksUrl("iss_test").href).toBe("https://kms.vercel.com/iss_test/jwks.json");

    const verification = getVerificationKey(env);
    expect(verification.kind).toBe("jwks");
    if (verification.kind !== "jwks") return;
    const token = await new SignJWT({ typ: "harness", sub: AGENT_ID, aud: "omniralph-harness" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setExpirationTime("15m")
      .sign(privateKey);
    const { payload } = await jwtVerify(token, verification.getKey);
    expect(payload.sub).toBe(AGENT_ID);
  });

  it("falls back to the local signer outside production", async () => {
    const signer = getTokenSigner({ NODE_ENV: "test" });
    expect(signer).toBeInstanceOf(LocalTokenSigner);
    const verification = getVerificationKey({ NODE_ENV: "test" });
    expect(verification.kind).toBe("local");
    expect(decodeJwt(await signer.signAccessToken(AGENT_ID)).sub).toBe(AGENT_ID);
  });

  it("refuses the local signer in production", () => {
    expect(() => getTokenSigner({ VERCEL_ENV: "production", NODE_ENV: "production" })).toThrow();
    expect(() =>
      getTokenSigner({ VERCEL_ENV: "production", LOCAL_AGENT_SIGNING_KEY: "x" }),
    ).toThrow(LocalSignerForbiddenError);
  });
});
