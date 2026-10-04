import { createPrivateKey, type KeyObject } from "node:crypto";
import { signJWT, type SignJWTOptions, type SignJWTResult } from "@vercel/kms";
import { SignJWT } from "jose";

/**
 * GitHub accepts app JWTs valid for at most 10 minutes. 540s leaves headroom
 * for clock drift between us and GitHub.
 */
export const APP_JWT_TTL_SECONDS = 540;

export interface AppJwt {
  token: string;
  expiresAt: Date;
}

/** Signs GitHub App JWTs (`iss` = app ID, RS256). */
export interface AppJwtSigner {
  sign(appId: string): Promise<AppJwt>;
}

/**
 * Signs with Vercel KMS: an external-origin issuer holds the imported GitHub
 * App private key, so the key never sits in an env var.
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
    const issuedAt = this.now();
    const { token } = await this.sign_({
      issuerId: this.issuerId,
      claims: { iss: appId },
      ttl: APP_JWT_TTL_SECONDS,
    });
    return { token, expiresAt: new Date(issuedAt + APP_JWT_TTL_SECONDS * 1000) };
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
      .setIssuedAt(nowSeconds - 60)
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
