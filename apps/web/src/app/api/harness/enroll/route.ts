import { enrollAgent, writeAgentAudit } from "@omniralph/db";
import { EnrollRequest, type EnrollResponse } from "@omniralph/shared";
import { authFailure, badRequest, clientIp, readJson } from "@/lib/harness-auth/request";
import { getDb } from "@/lib/db";
import {
  HARNESS_RATE_LIMITS,
  authLockoutRemaining,
  hitRateLimit,
  tooManyRequests,
} from "@/lib/rate-limit";
import { liveRoute } from "@/lib/live/request";

/**
 * Exchanges a one-time enrollment token (1 hour, single use) for a new harness
 * and its first refresh token.
 */
async function post(req: Request): Promise<Response> {
  const db = getDb();
  const ip = clientIp(req);
  const now = new Date();

  const lockout = await authLockoutRemaining(db, ip, now);
  if (lockout > 0) return tooManyRequests(lockout);
  const limit = await hitRateLimit(db, HARNESS_RATE_LIMITS.enrollPerIp(ip), now);
  if (limit.limited) return tooManyRequests(limit.retryAfterSeconds);

  const body = EnrollRequest.safeParse(await readJson(req));
  if (!body.success) return badRequest();

  const enrolled = await enrollAgent(db, { ...body.data, now });
  if (!enrolled) {
    return authFailure(db, req, { reason: "invalid_enrollment_token" }, now);
  }
  await writeAgentAudit(db, {
    agentId: enrolled.agentId,
    event: "enroll",
    ip,
    detail: {
      name: body.data.name,
      version: body.data.version,
    },
  });
  // The wire field keeps its name until TOOL-584.
  return Response.json({
    harnessId: enrolled.agentId,
    refreshToken: enrolled.refreshToken,
  } satisfies EnrollResponse);
}

export const POST = liveRoute(post);
