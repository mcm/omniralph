import { enrollAgent, writeAgentAudit } from "@omniralph/db";
import { EnrollRequest, type EnrollResponse } from "@omniralph/shared";
import { cacheAgentActive } from "@/lib/agent-auth/auth-state";
import {
  cacheRefreshToken,
  issueRefreshToken,
  reenrolledGeneration,
} from "@/lib/agent-auth/refresh";
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
 * and its first (signed) refresh token. A token bound to an existing agent (Fleet ›
 * Re-enroll…) re-enrolls that agent in place instead (TOOL-925): same ID, pins and history,
 * a fresh refresh-token family no earlier token belongs to, and a `reenroll` audit row.
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
    issueRefreshToken: async (agentId, previousGeneration) =>
      issueRefreshToken(
        agentId,
        previousGeneration === null ? 1 : await reenrolledGeneration(agentId, previousGeneration),
      ),
    now,
  });
  if (!enrolled?.refreshToken) {
    return authFailure(db, req, { reason: "invalid_enrollment_token" }, now);
  }
  const { reenrolled } = enrolled;
  if (reenrolled) {
    // Its new family starts here: older tokens are stale, and it's no longer revoked.
    await cacheRefreshToken(
      enrolled.agentId,
      enrolled.refreshToken,
      enrolled.refreshToken.generation,
    );
    await cacheAgentActive(enrolled.agentId);
  } else {
    await cacheRefreshToken(enrolled.agentId, enrolled.refreshToken);
  }
  await writeAgentAudit(db, {
    agentId: enrolled.agentId,
    event: reenrolled ? "reenroll" : "enroll",
    ip,
    detail: {
      name: body.data.name,
      version: body.data.version,
      ...(reenrolled && {
        reenrolledBy: reenrolled.reenrolledBy,
        wasRevoked: reenrolled.wasRevoked,
        // After a `refresh_reuse`: the token family it replaces had been stolen or copied.
        compromisedFamily: reenrolled.compromisedFamily,
      }),
    },
  });
  return Response.json({
    agentId: enrolled.agentId,
    refreshToken: enrolled.refreshToken.token,
  } satisfies EnrollResponse);
}

export const POST = liveRoute(post);
