import "server-only";
import { isJobRunningOnAgent, type Database } from "@omniralph/db";
import {
  AGENT_TOKEN_AUDIENCE,
  JobTokenScope,
  RunTokenKind,
  type JobTokenKind,
} from "@omniralph/shared";
import { jwtVerify, type JWTPayload } from "jose";
import { getDb } from "@/lib/db";
import { authLockoutRemaining, tooManyRequests } from "@/lib/rate-limit";
import { readAgentAuthState } from "./auth-state";
import { authFailure, clientIp } from "./request";
import { getVerificationKey } from "./signer";

export interface AgentPrincipal {
  agentId: string;
}

export interface JobPrincipal {
  jobId: string;
  agentId: string;
  scopes: JobTokenScope[];
  /** The token's `kind` claim; `legacy` when it has none (a legacy job's single token). */
  kind: JobTokenKind;
}

type TokenType = "agent" | "job";

class AuthError extends Error {
  constructor(
    readonly reason: string,
    /** Set once the token's signature is verified (the claim can be trusted). */
    readonly agentId: string | null = null,
    /**
     * The token carries our signature: it was issued by us, so the failure (expired, job no
     * longer running, revoked agent, ...) isn't a guessing attempt and doesn't count towards
     * the IP's lockout.
     */
    readonly signed = agentId !== null,
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
    audience: AGENT_TOKEN_AUDIENCE,
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

async function checkAgent(db: Database, agentId: string): Promise<void> {
  const state = await readAgentAuthState(db, agentId);
  if (state === "unknown") throw new AuthError("unknown_agent", null, true);
  if (state === "revoked") throw new AuthError("agent_revoked", agentId);
}

/**
 * Runs `authenticate` for an agent API request. Locked-out IPs get 429; any
 * failure gets 401 plus a (sampled) `auth_failed` audit row. Only tokens we
 * didn't sign count towards the IP's lockout: an expired token, or a job token
 * used after its job was canceled, is a stale client, not a guessing attempt,
 * and must not lock out every agent behind the same IP.
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
      { agentId: error.agentId, reason: error.reason, lockout: !error.signed },
      now,
    );
  }
}

/**
 * Authenticates an agent access token (`Authorization: Bearer`). Returns the
 * principal, or a 401/429 `Response` to return as is:
 *
 * ```ts
 * const agent = await requireAgent(req);
 * if (agent instanceof Response) return agent;
 * ```
 *
 * Revocation takes effect immediately: the agent's auth state is checked on every
 * request (in Redis, which revocation updates; see `readAgentAuthState`).
 */
export async function requireAgent(req: Request): Promise<AgentPrincipal | Response> {
  return guard(req, async (db, token) => {
    const payload = await verifyToken(token, "agent");
    const agentId = uuidClaim(payload.sub);
    await checkAgent(db, agentId);
    return { agentId };
  });
}

/**
 * Authenticates a job token and checks that it carries `scope`, that its agent
 * isn't revoked and that the job is still `running` on that agent.
 */
export async function requireJob(
  req: Request,
  scope: JobTokenScope,
): Promise<JobPrincipal | Response> {
  return guard(req, async (db, token) => {
    const payload = await verifyToken(token, "job");
    const jobId = uuidClaim(payload.sub);
    const agentId = uuidClaim(payload.agentId);
    const scopes = Array.isArray(payload.scopes)
      ? payload.scopes.filter((s): s is JobTokenScope => JobTokenScope.safeParse(s).success)
      : [];
    const kind = jobTokenKind(payload.kind);
    await checkAgent(db, agentId);
    if (!scopes.includes(scope)) throw new AuthError("scope_mismatch", agentId);
    if (!(await isJobRunningOnAgent(db, jobId, agentId))) {
      throw new AuthError("job_not_running", agentId);
    }
    return { jobId, agentId, scopes, kind };
  });
}
