import "server-only";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import {
  AGENT_ACCESS_TOKEN_TTL_SECONDS,
  AGENT_TOKEN_AUDIENCE,
  JOB_TOKEN_TTL_SECONDS,
  type JobTokenScope,
  type RunTokenKind,
} from "@omniralph/shared";
import { signJWT, type SignJWTOptions, type SignJWTResult } from "@vercel/kms";
import { createRemoteJWKSet, SignJWT, type JWTVerifyGetKey } from "jose";

type Env = Record<string, string | undefined>;

export interface JobTokenInput {
  jobId: string;
  agentId: string;
  scopes: JobTokenScope[];
  /** A run-spec job's `lifecycle` or `session` token; omitted for a legacy job's single token. */
  kind?: RunTokenKind;
}

/**
 * Signs agent access tokens (RS256, `AGENT_ACCESS_TOKEN_TTL_SECONDS`) and job tokens
 * (`JOB_TOKEN_TTL_SECONDS`). See `docs/adr/0002-agent-auth.md`.
 */
export interface TokenSigner {
  /** `{ typ: "agent", sub: agentId, aud: "omniralph-agent" }` */
  signAccessToken(agentId: string): Promise<string>;
  /** `{ typ: "job", sub: jobId, agentId, scopes, kind?, aud: "omniralph-agent" }` */
  signJobToken(input: JobTokenInput): Promise<string>;
}

function accessClaims(agentId: string) {
  return { typ: "agent", sub: agentId, aud: AGENT_TOKEN_AUDIENCE };
}

function jobClaims({ jobId, agentId, scopes, kind }: JobTokenInput) {
  return {
    typ: "job",
    sub: jobId,
    agentId,
    scopes,
    ...(kind ? { kind } : {}),
    aud: AGENT_TOKEN_AUDIENCE,
  };
}

/**
 * Signs with Vercel KMS (`KMS_AGENT_ISSUER_ID`, one issuer per Vercel
 * environment), so no signing key ever sits in an env var. `signJWT`
 * authenticates with the function's Vercel OIDC token, which only exists
 * while a request is handled: call this only inside request handlers.
 */
export class KmsTokenSigner implements TokenSigner {
  readonly issuerId: string;
  private readonly signJwt: (options: SignJWTOptions) => Promise<SignJWTResult>;

  constructor(options: {
    issuerId: string;
    /** Injected for tests; defaults to `signJWT` from `@vercel/kms`. */
    signJwt?: (options: SignJWTOptions) => Promise<SignJWTResult>;
  }) {
    this.issuerId = options.issuerId;
    this.signJwt = options.signJwt ?? signJWT;
  }

  signAccessToken(agentId: string): Promise<string> {
    return this.sign(accessClaims(agentId), AGENT_ACCESS_TOKEN_TTL_SECONDS);
  }

  signJobToken(input: JobTokenInput): Promise<string> {
    return this.sign(jobClaims(input), JOB_TOKEN_TTL_SECONDS);
  }

  private async sign(claims: Record<string, unknown>, ttl: number): Promise<string> {
    const { token } = await this.signJwt({ issuerId: this.issuerId, claims, ttl });
    return token;
  }
}

/** Thrown when the local signer is used where only KMS is allowed. */
export class LocalSignerForbiddenError extends Error {
  constructor() {
    super(
      "LocalTokenSigner refuses to run with VERCEL_ENV=production; set KMS_AGENT_ISSUER_ID instead",
    );
    this.name = "LocalSignerForbiddenError";
  }
}

function assertNotProduction(env: Env): void {
  if (env.VERCEL_ENV === "production") throw new LocalSignerForbiddenError();
}

/**
 * Signs with `jose` and a local RS256 key pair: `LOCAL_AGENT_SIGNING_KEY` (PEM,
 * PKCS#8 or PKCS#1; literal `\n` accepted) or, in tests and local dev, a key
 * generated in memory. For local development and tests only: it refuses to
 * run when `VERCEL_ENV=production`.
 */
export class LocalTokenSigner implements TokenSigner {
  readonly publicKey: KeyObject;
  private readonly privateKey: KeyObject;
  private readonly env: Env;
  private readonly now: () => number;

  constructor(options: { privateKey?: KeyObject | string; env?: Env; now?: () => number } = {}) {
    this.env = options.env ?? process.env;
    assertNotProduction(this.env);
    const key = options.privateKey;
    this.privateKey =
      key === undefined
        ? generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
        : typeof key === "string"
          ? createPrivateKey(key.replace(/\\n/g, "\n"))
          : key;
    if (this.privateKey.asymmetricKeyType !== "rsa") {
      throw new Error("LOCAL_AGENT_SIGNING_KEY must be an RSA private key (RS256)");
    }
    this.publicKey = createPublicKey(this.privateKey);
    this.now = options.now ?? Date.now;
  }

  signAccessToken(agentId: string): Promise<string> {
    return this.sign(accessClaims(agentId), AGENT_ACCESS_TOKEN_TTL_SECONDS);
  }

  signJobToken(input: JobTokenInput): Promise<string> {
    return this.sign(jobClaims(input), JOB_TOKEN_TTL_SECONDS);
  }

  private async sign(claims: Record<string, unknown>, ttl: number): Promise<string> {
    assertNotProduction(this.env);
    const iat = Math.floor(this.now() / 1000);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuedAt(iat)
      .setExpirationTime(iat + ttl)
      .sign(this.privateKey);
  }
}

export function kmsJwksUrl(issuerId: string): URL {
  return new URL(`https://kms.vercel.com/${encodeURIComponent(issuerId)}/jwks.json`);
}

/** How tokens are verified: the KMS issuer's JWKS, or the local signer's public key. */
export type VerificationKey =
  | { kind: "jwks"; getKey: JWTVerifyGetKey }
  | { kind: "local"; key: KeyObject };

interface AgentTokenKeys {
  issuerId: string | undefined;
  signer: TokenSigner;
  verification: VerificationKey;
}

let cached: AgentTokenKeys | undefined;

function createKeys(env: Env): AgentTokenKeys {
  const issuerId = env.KMS_AGENT_ISSUER_ID;
  if (issuerId) {
    return {
      issuerId,
      signer: new KmsTokenSigner({ issuerId }),
      // `createRemoteJWKSet` caches the key set and refetches on unknown `kid`s.
      verification: { kind: "jwks", getKey: createRemoteJWKSet(kmsJwksUrl(issuerId)) },
    };
  }
  const pem = env.LOCAL_AGENT_SIGNING_KEY || undefined;
  if (!pem && env.NODE_ENV !== "test" && env.NODE_ENV !== "development") {
    throw new Error("Set KMS_AGENT_ISSUER_ID (or LOCAL_AGENT_SIGNING_KEY outside production)");
  }
  const signer = new LocalTokenSigner({ privateKey: pem, env });
  return { issuerId, signer, verification: { kind: "local", key: signer.publicKey } };
}

function keys(env: Env = process.env): AgentTokenKeys {
  if (!cached || cached.issuerId !== env.KMS_AGENT_ISSUER_ID) cached = createKeys(env);
  return cached;
}

/**
 * The signer for this environment: `KmsTokenSigner` when `KMS_AGENT_ISSUER_ID`
 * is set, otherwise `LocalTokenSigner`. Created lazily (first request).
 */
export function getTokenSigner(env: Env = process.env): TokenSigner {
  return keys(env).signer;
}

export function getVerificationKey(env: Env = process.env): VerificationKey {
  return keys(env).verification;
}

/** Drops the cached signer and keys (tests). */
export function resetTokenKeys(): void {
  cached = undefined;
}
