import { createPrivateKey, type KeyObject } from "node:crypto";
import { signJWT, VercelKmsError, type SignJWTOptions, type SignJWTResult } from "@vercel/kms";
import { decodeJwt, decodeProtectedHeader, SignJWT, type JWTPayload } from "jose";

/**
 * GitHub accepts app JWTs valid for at most 10 minutes. 540s leaves headroom
 * for clock drift between us and GitHub.
 */
export const APP_JWT_TTL_SECONDS = 540;

/** `iat` is backdated by this much, per GitHub's guidance on clock drift. */
export const APP_JWT_BACKDATE_SECONDS = 60;

/** GitHub rejects app JWTs whose `exp` is more than 10 minutes out. */
const GITHUB_MAX_JWT_LIFETIME_SECONDS = 600;

export interface AppJwt {
  token: string;
  expiresAt: Date;
}

/** Signs GitHub App JWTs (`iss` = app ID, RS256). */
export interface AppJwtSigner {
  sign(appId: string): Promise<AppJwt>;
}

/**
 * Thrown when KMS returns a JWT that GitHub would reject (wrong algorithm,
 * `iss` replaced, lifetime too long). The message says how to fix the issuer.
 */
export class KmsAppJwtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KmsAppJwtError";
  }
}

/**
 * Signs with Vercel KMS: an external-origin issuer holds the imported GitHub
 * App private key, so the key never sits in an env var.
 *
 * The issuer must sign **RS256** (`vercel kms import <name> --key <pem>
 * --algorithm RS256`): KMS issuers default to RS512, which GitHub rejects.
 * KMS sets `iat`/`nbf`/`exp` itself, so we also send `iat`/`exp` backdated
 * like `PemAppJwtSigner`'s; if KMS refuses caller-set registered claims (400),
 * we retry with `iss` alone. Every token is decoded and checked before use, so
 * a misconfigured issuer fails here with an actionable error instead of as an
 * opaque 401 from GitHub.
 */
export class KmsAppJwtSigner implements AppJwtSigner {
  private readonly issuerId: string;
  private readonly sign_: (options: SignJWTOptions) => Promise<SignJWTResult>;
  private readonly now: () => number;

  constructor(options: {
    issuerId: string;
    /** Injected for tests; defaults to `signJWT` from `@vercel/kms`. */
    signJwt?: (options: SignJWTOptions) => Promise<SignJWTResult>;
    now?: () => number;
  }) {
    this.issuerId = options.issuerId;
    this.sign_ = options.signJwt ?? signJWT;
    this.now = options.now ?? Date.now;
  }

  async sign(appId: string): Promise<AppJwt> {
    const nowSeconds = Math.floor(this.now() / 1000);
    const claims = {
      iss: appId,
      iat: nowSeconds - APP_JWT_BACKDATE_SECONDS,
      exp: nowSeconds + APP_JWT_TTL_SECONDS,
    };
    let result: SignJWTResult;
    try {
      result = await this.sign_({ issuerId: this.issuerId, claims, ttl: APP_JWT_TTL_SECONDS });
    } catch (error) {
      if (!(error instanceof VercelKmsError) || error.status !== 400) throw error;
      result = await this.sign_({
        issuerId: this.issuerId,
        claims: { iss: appId },
        ttl: APP_JWT_TTL_SECONDS,
      });
    }
    const exp = this.check(result, appId, nowSeconds);
    return { token: result.token, expiresAt: new Date(exp * 1000) };
  }

  /** Validates the KMS token against GitHub's requirements; returns its `exp`. */
  private check(result: SignJWTResult, appId: string, nowSeconds: number): number {
    const fail = (problem: string) =>
      new KmsAppJwtError(`KMS issuer ${this.issuerId} produced an unusable GitHub App JWT: ${problem}`);
    let alg: unknown;
    let payload: JWTPayload;
    try {
      alg = decodeProtectedHeader(result.token).alg;
      payload = decodeJwt(result.token);
    } catch {
      throw fail("the token could not be decoded");
    }
    if (alg !== "RS256" || result.algorithm !== "RS256") {
      throw fail(
        `it is signed with ${String(alg ?? result.algorithm)}, but GitHub only accepts RS256. ` +
          "Re-import the App private key into an issuer created with " +
          "`vercel kms import <name> --key <pem> --algorithm RS256` and update GITHUB_APP_KMS_ISSUER_ID",
      );
    }
    if (payload.iss !== appId) {
      throw fail(`its iss is ${JSON.stringify(payload.iss)}, expected the GitHub App ID ${JSON.stringify(appId)}`);
    }
    const { iat, exp } = payload;
    if (typeof exp !== "number") throw fail("it has no exp claim");
    if (exp - nowSeconds > GITHUB_MAX_JWT_LIFETIME_SECONDS) {
      throw fail(`its exp is ${exp - nowSeconds}s away; GitHub allows at most ${GITHUB_MAX_JWT_LIFETIME_SECONDS}s`);
    }
    if (typeof iat === "number" && exp - iat > GITHUB_MAX_JWT_LIFETIME_SECONDS) {
      throw fail(`it is valid for ${exp - iat}s; GitHub allows at most ${GITHUB_MAX_JWT_LIFETIME_SECONDS}s`);
    }
    return exp;
  }
}

/** Signs locally with a PEM private key (PKCS#1 or PKCS#8). */
export class PemAppJwtSigner implements AppJwtSigner {
  private readonly key: KeyObject;
  private readonly now: () => number;

  constructor(privateKeyPem: string, options: { now?: () => number } = {}) {
    // Env vars often carry the PEM with literal "\n" sequences.
    this.key = createPrivateKey(privateKeyPem.replace(/\\n/g, "\n"));
    this.now = options.now ?? Date.now;
  }

  async sign(appId: string): Promise<AppJwt> {
    const nowSeconds = Math.floor(this.now() / 1000);
    const exp = nowSeconds + APP_JWT_TTL_SECONDS;
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(appId)
      // Backdated per GitHub's guidance to tolerate clock drift.
      .setIssuedAt(nowSeconds - APP_JWT_BACKDATE_SECONDS)
      .setExpirationTime(exp)
      .sign(this.key);
    return { token, expiresAt: new Date(exp * 1000) };
  }
}

/**
 * Picks the signer from the environment: KMS when `GITHUB_APP_KMS_ISSUER_ID`
 * is set, otherwise the `GITHUB_APP_PRIVATE_KEY` PEM.
 */
export function createAppJwtSigner(env: Record<string, string | undefined> = process.env): AppJwtSigner {
  const issuerId = env.GITHUB_APP_KMS_ISSUER_ID;
  if (issuerId) return new KmsAppJwtSigner({ issuerId });
  const pem = env.GITHUB_APP_PRIVATE_KEY;
  if (pem) return new PemAppJwtSigner(pem);
  throw new Error("Set GITHUB_APP_KMS_ISSUER_ID or GITHUB_APP_PRIVATE_KEY to sign GitHub App JWTs");
}
