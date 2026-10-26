import "server-only";
import { isJobRunningOnAgent, type Database } from "@omniralph/db";
import {
  HARNESS_TOKEN_AUDIENCE,
  JobTokenScope,
  RunTokenKind,
  type JobTokenKind,
} from "@omniralph/shared";
import { jwtVerify, type JWTPayload } from "jose";
import { getDb } from "@/lib/db";
import { authLockoutRemaining, tooManyRequests } from "@/lib/rate-limit";
import { readHarnessAuthState } from "./auth-state";
import { authFailure, clientIp } from "./request";
import { getVerificationKey } from "./signer";

export interface HarnessPrincipal {
  harnessId: string;
}

export interface JobPrincipal {
  jobId: string;
  harnessId: string;
  scopes: JobTokenScope[];
  /** The token's `kind` claim; `legacy` when it has none (a legacy job's single token). */
  kind: JobTokenKind;
}

type TokenType = "harness" | "job";

class AuthError extends Error {
  constructor(
    readonly reason: string,
    /** Set once the token's signature is verified (the claim can be trusted). */
    readonly harnessId: string | null = null,
    /**
     * The token carries our signature: it was issued by us, so the failure (expired, job no
     * longer running, revoked harness, ...) isn't a guessing attempt and doesn't count towards
     * the IP's lockout.
     */
    readonly signed = harnessId !== null,
  ) {
    super(reason);
  }
}

/** jose errors thrown only after the signature has been verified (claim checks). */
const SIGNED_TOKEN_ERRORS = new Set(["ERR_JWT_EXPIRED", "ERR_JWT_CLAIM_VALIDATION_FAILED"]);

function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

/** Verifies signature (RS256 only), `aud`, `exp` and `typ`; returns the payload. */
async function verifyToken(token: string, typ: TokenType): Promise<JWTPayload> {
  const options = {
    algorithms: ["RS256"],
    audience: HARNESS_TOKEN_AUDIENCE,
    requiredClaims: ["exp", "sub"],
  };
  const verification = getVerificationKey();
  let payload: JWTPayload;
  try {
    ({ payload } =
      verification.kind === "jwks"
        ? await jwtVerify(token, verification.getKey, options)
        : await jwtVerify(token, verification.key, options));
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code !== "string") throw new AuthError("invalid_token");
    throw new AuthError(code, null, SIGNED_TOKEN_ERRORS.has(code));
  }
  if (payload.typ !== typ) throw new AuthError("wrong_typ", null, true);
  return payload;
}

/** A job token's kind: no `kind` claim is a legacy single token; an unknown one is rejected. */
function jobTokenKind(value: unknown): JobTokenKind {
  if (value === undefined) return "legacy";
  const kind = RunTokenKind.safeParse(value);
  if (!kind.success) throw new AuthError("invalid_claims", null, true);
  return kind.data;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidClaim(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new AuthError("invalid_claims", null, true);
  }
  return value;
}

async function checkHarness(db: Database, harnessId: string): Promise<void> {
  const state = await readHarnessAuthState(db, harnessId);
  if (state === "unknown") throw new AuthError("unknown_agent", null, true);
  if (state === "revoked") throw new AuthError("agent_revoked", harnessId);
}

/**
 * Runs `authenticate` for a harness API request. Locked-out IPs get 429; any
 * failure gets 401 plus a (sampled) `auth_failed` audit row. Only tokens we
 * didn't sign count towards the IP's lockout: an expired token, or a job token
 * used after its job was canceled, is a stale client, not a guessing attempt,
 * and must not lock out every harness behind the same IP.
 */
async function guard<T>(
  req: Request,
  authenticate: (db: Database, token: string) => Promise<T>,
): Promise<T | Response> {
  const db = getDb();
  const now = new Date();
  const lockout = await authLockoutRemaining(db, clientIp(req), now);
  if (lockout > 0) return tooManyRequests(lockout);
  const token = bearerToken(req);
  try {
    if (!token) throw new AuthError("missing_token");
    return await authenticate(db, token);
  } catch (error) {
    if (!(error instanceof AuthError)) throw error;
    return authFailure(
      db,
      req,
      { harnessId: error.harnessId, reason: error.reason, lockout: !error.signed },
      now,
    );
  }
}

/**
 * Authenticates a harness access token (`Authorization: Bearer`). Returns the
 * principal, or a 401/429 `Response` to return as is:
 *
 * ```ts
 * const harness = await requireHarness(req);
 * if (harness instanceof Response) return harness;
 * ```
 *
 * Revocation takes effect immediately: the harness's auth state is checked on every
 * request (in Redis, which revocation updates; see `readHarnessAuthState`).
 */
export async function requireHarness(req: Request): Promise<HarnessPrincipal | Response> {
  return guard(req, async (db, token) => {
    const payload = await verifyToken(token, "harness");
    const harnessId = uuidClaim(payload.sub);
    await checkHarness(db, harnessId);
    return { harnessId };
  });
}

/**
 * Authenticates a job token and checks that it carries `scope`, that its harness
 * isn't revoked and that the job is still `running` on that harness.
 */
export async function requireJob(
  req: Request,
  scope: JobTokenScope,
): Promise<JobPrincipal | Response> {
  return guard(req, async (db, token) => {
    const payload = await verifyToken(token, "job");
    const jobId = uuidClaim(payload.sub);
    const harnessId = uuidClaim(payload.harnessId);
    const scopes = Array.isArray(payload.scopes)
      ? payload.scopes.filter((s): s is JobTokenScope => JobTokenScope.safeParse(s).success)
      : [];
    const kind = jobTokenKind(payload.kind);
    await checkHarness(db, harnessId);
    if (!scopes.includes(scope)) throw new AuthError("scope_mismatch", harnessId);
    if (!(await isJobRunningOnAgent(db, jobId, harnessId))) {
      throw new AuthError("job_not_running", harnessId);
    }
    return { jobId, harnessId, scopes, kind };
  });
}
