import { enrollAgent, writeAgentAudit } from "@omniralph/db";
import { EnrollRequest, type EnrollResponse } from "@omniralph/shared";
import { cacheRefreshToken, issueRefreshToken } from "@/lib/agent-auth/refresh";
import { authFailure, badRequest, clientIp, readJson } from "@/lib/agent-auth/request";
import { getDb } from "@/lib/db";
import {
  AGENT_RATE_LIMITS,
  authLockoutRemaining,
  hitRateLimit,
  tooManyRequests,
} from "@/lib/rate-limit";
import { liveRoute } from "@/lib/live/request";

/**
 * Exchanges a one-time enrollment token (1 hour, single use) for a new agent
 * and its first (signed) refresh token.
 */
async function post(req: Request): Promise<Response> {
  const db = getDb();
  const ip = clientIp(req);
  const now = new Date();

  const lockout = await authLockoutRemaining(db, ip, now);
  if (lockout > 0) return tooManyRequests(lockout);
  const limit = await hitRateLimit(db, AGENT_RATE_LIMITS.enrollPerIp(ip), now);
  if (limit.limited) return tooManyRequests(limit.retryAfterSeconds);

  const body = EnrollRequest.safeParse(await readJson(req));
  if (!body.success) return badRequest();

  const enrolled = await enrollAgent(db, {
    ...body.data,
    issueRefreshToken: (agentId) => issueRefreshToken(agentId, 1),
    now,
  });
  if (!enrolled?.refreshToken) {
    return authFailure(db, req, { reason: "invalid_enrollment_token" }, now);
  }
  await cacheRefreshToken(enrolled.agentId, enrolled.refreshToken);
  await writeAgentAudit(db, {
    agentId: enrolled.agentId,
    event: "enroll",
    ip,
    detail: {
      name: body.data.name,
      version: body.data.version,
    },
  });
  return Response.json({
    agentId: enrolled.agentId,
    refreshToken: enrolled.refreshToken.token,
  } satisfies EnrollResponse);
}

export const POST = liveRoute(post);
