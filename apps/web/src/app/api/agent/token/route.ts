import {
  findRefreshTokenAgent,
  hashToken,
  isLegacyRefreshToken,
  rotateRefreshToken,
  writeAgentAudit,
  type Database,
} from "@omniralph/db";
import {
  AGENT_ACCESS_TOKEN_TTL_SECONDS,
  TokenRequest,
  type TokenResponse,
} from "@omniralph/shared";
import { decodeJwt } from "jose";
import {
  authFailure,
  badRequest,
  clientIp,
  readJson,
  unauthorized,
} from "@/lib/agent-auth/request";
import { cacheAgentRevoked } from "@/lib/agent-auth/auth-state";
import { revokeAgent } from "@/lib/agent-auth/revoke";
import {
  cacheRefreshToken,
  issueRefreshToken,
  rotateRefreshTokenState,
} from "@/lib/agent-auth/refresh";
import { getTokenSigner } from "@/lib/agent-auth/signer";
import { verifyRefreshToken } from "@/lib/agent-auth/verify";
import { getDb } from "@/lib/db";
import {
  AGENT_RATE_LIMITS,
  authLockoutRemaining,
  hitRateLimit,
  tooManyRequests,
} from "@/lib/rate-limit";
import { liveRoute } from "@/lib/live/request";

/**
 * The access token's lifetime as signed (`exp - iat`), so the agent refreshes in time
 * even if KMS signed it for less than asked; `AGENT_ACCESS_TOKEN_TTL_SECONDS` otherwise.
 */
function accessTokenLifetime(token: string): number {
  try {
    const { exp, iat } = decodeJwt(token);
    if (typeof exp === "number" && typeof iat === "number" && exp > iat) {
      return Math.min(exp - iat, AGENT_ACCESS_TOKEN_TTL_SECONDS);
    }
  } catch {
    // Not a JWT we can read: what was asked for.
  }
  return AGENT_ACCESS_TOKEN_TTL_SECONDS;
}

type FailureInput = { agentId: string | null; reason: string; lockout?: boolean };

/**
 * Reuse detected: the agent is revoked in Postgres; cache and audit it, then finish the
 * revocation as the Agents page does (`revokeAgent`: its running jobs requeued, failed or
 * canceled, the jobs targeted at it redispatched; its pins stay, ignored until it's
 * re-enrolled).
 */
async function reused(
  db: Database,
  req: Request,
  input: { agentId: string; detail: Record<string, unknown> },
  now: Date,
): Promise<Response> {
  await cacheAgentRevoked(input.agentId);
  try {
    await revokeAgent(input.agentId, { ip: clientIp(req), db });
  } catch (error) {
    // The agent is revoked: its jobs' leases expire without its heartbeats.
    console.error(`Revoking agent ${input.agentId} after refresh token reuse failed`, error);
  }
  await writeAgentAudit(db, {
    agentId: input.agentId,
    event: "refresh_reuse",
    ip: clientIp(req),
    detail: input.detail,
  });
  await authFailure(db, req, { agentId: input.agentId, reason: "refresh_reuse" }, now);
  return unauthorized("refresh_token_reused");
}

function issued(accessToken: string, refreshToken: string): Response {
  return Response.json({
    accessToken,
    expiresIn: accessTokenLifetime(accessToken),
    refreshToken,
  } satisfies TokenResponse);
}

/**
 * A signed refresh token (TOOL-856): rotated in Redis while hot state is on, so a refresh
 * writes nothing to Postgres (`rotateRefreshTokenState`).
 */
async function refreshSigned(
  db: Database,
  req: Request,
  refreshToken: string,
  now: Date,
): Promise<Response> {
  const fail = (input: FailureInput) => authFailure(db, req, input, now);
  const verified = await verifyRefreshToken(refreshToken);
  if (!verified.ok) {
    // A token we signed (expired, say) is a stale client, not a guessing attempt: its audit
    // row names its agent, so Fleet can say the agent needs re-enrollment and why.
    return fail({
      agentId: verified.agentId,
      reason: `refresh_${verified.reason}`,
      lockout: !verified.signed,
    });
  }
  const { agentId, generation, tokenId } = verified;
  const agentLimit = await hitRateLimit(db, AGENT_RATE_LIMITS.tokenPerAgent(agentId), now);
  if (agentLimit.limited) return tooManyRequests(agentLimit.retryAfterSeconds);

  // Sign before rotating: if signing (KMS) fails, the presented token stays current and the
  // agent can retry, instead of being revoked for "reusing" it.
  const next = await issueRefreshToken(agentId, generation + 1);
  const accessToken = await getTokenSigner().signAccessToken(agentId);
  const rotation = await rotateRefreshTokenState(
    db,
    {
      agentId,
      presented: { generation, tokenIdHash: hashToken(tokenId) },
      next,
      ip: clientIp(req),
    },
    now,
  );
  switch (rotation.status) {
    case "invalid":
      return fail({ agentId: rotation.agentId, reason: `refresh_${rotation.reason}` });
    case "reused":
      return reused(db, req, { agentId, detail: { generation } }, now);
    case "rotated":
    case "caught_up":
      return issued(accessToken, next.token);
  }
}

/**
 * A legacy opaque refresh token (from before TOOL-856), rotated in Postgres: redeemed once
 * for the agent's first signed refresh token.
 */
async function refreshLegacy(
  db: Database,
  req: Request,
  refreshToken: string,
  now: Date,
): Promise<Response> {
  const fail = (input: FailureInput) => authFailure(db, req, input, now);
  const owner = await findRefreshTokenAgent(db, refreshToken);
  if (!owner) return fail({ agentId: null, reason: "refresh_unknown" });
  const agentLimit = await hitRateLimit(db, AGENT_RATE_LIMITS.tokenPerAgent(owner), now);
  if (agentLimit.limited) return tooManyRequests(agentLimit.retryAfterSeconds);

  // Sign before rotating: if signing (KMS) fails, the presented token stays unused and the
  // agent can retry, instead of being revoked for "reusing" it.
  const next = await issueRefreshToken(owner, 1);
  const accessToken = await getTokenSigner().signAccessToken(owner);
  const rotation = await rotateRefreshToken(db, refreshToken, next, now);
  switch (rotation.status) {
    case "invalid":
      return fail({ agentId: rotation.agentId, reason: `refresh_${rotation.reason}` });
    case "reused":
      return reused(
        db,
        req,
        { agentId: rotation.agentId, detail: { familyId: rotation.familyId } },
        now,
      );
    case "rotated":
      await cacheRefreshToken(rotation.agentId, next);
      await writeAgentAudit(db, {
        agentId: rotation.agentId,
        event: "token_refresh",
        ip: clientIp(req),
        detail: { familyId: rotation.familyId },
      });
      return issued(accessToken, next.token);
  }
}

/**
 * Exchanges a refresh token for a 15-minute access token and rotates it. Presenting an
 * already-used refresh token revokes the agent.
 */
async function post(req: Request): Promise<Response> {
  const db = getDb();
  const ip = clientIp(req);
  const now = new Date();

  const lockout = await authLockoutRemaining(db, ip, now);
  if (lockout > 0) return tooManyRequests(lockout);
  const ipLimit = await hitRateLimit(db, AGENT_RATE_LIMITS.tokenPerIp(ip), now);
  if (ipLimit.limited) return tooManyRequests(ipLimit.retryAfterSeconds);

  const body = TokenRequest.safeParse(await readJson(req));
  if (!body.success) return badRequest();
  const { refreshToken } = body.data;
  return isLegacyRefreshToken(refreshToken)
    ? refreshLegacy(db, req, refreshToken, now)
    : refreshSigned(db, req, refreshToken, now);
}

export const POST = liveRoute(post);
