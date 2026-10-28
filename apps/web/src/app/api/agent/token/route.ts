import { findRefreshTokenAgent, rotateRefreshToken, writeAgentAudit } from "@omniralph/db";
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
import { getTokenSigner } from "@/lib/agent-auth/signer";
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

/**
 * Exchanges a refresh token for a one-day access token and rotates it.
 * Presenting an already-used refresh token revokes its family and the agent.
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

  const owner = await findRefreshTokenAgent(db, refreshToken);
  if (!owner) return authFailure(db, req, { reason: "refresh_unknown" }, now);
  const agentLimit = await hitRateLimit(db, AGENT_RATE_LIMITS.tokenPerAgent(owner), now);
  if (agentLimit.limited) return tooManyRequests(agentLimit.retryAfterSeconds);

  // Sign before rotating: if signing (KMS) fails, the presented token stays unused and the
  // agent can retry, instead of being revoked for "reusing" it.
  const accessToken = await getTokenSigner().signAccessToken(owner);
  const rotation = await rotateRefreshToken(db, refreshToken, now);
  switch (rotation.status) {
    case "invalid":
      return authFailure(
        db,
        req,
        { agentId: rotation.agentId, reason: `refresh_${rotation.reason}` },
        now,
      );
    case "reused":
      await cacheAgentRevoked(rotation.agentId);
      await writeAgentAudit(db, {
        agentId: rotation.agentId,
        event: "refresh_reuse",
        ip,
        detail: { familyId: rotation.familyId },
      });
      await authFailure(db, req, { agentId: rotation.agentId, reason: "refresh_reuse" }, now);
      return unauthorized("refresh_token_reused");
    case "rotated": {
      await writeAgentAudit(db, {
        agentId: rotation.agentId,
        event: "token_refresh",
        ip,
        detail: { familyId: rotation.familyId },
      });
      return Response.json({
        accessToken,
        expiresIn: accessTokenLifetime(accessToken),
        refreshToken: rotation.refreshToken,
      } satisfies TokenResponse);
    }
  }
}

export const POST = liveRoute(post);
