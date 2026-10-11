import { enrollHarness, writeHarnessAudit } from "@omniralph/db";
import { EnrollRequest, type EnrollResponse } from "@omniralph/shared";
import { authFailure, badRequest, clientIp, readJson } from "@/lib/harness-auth/request";
import { getDb } from "@/lib/db";
import {
  HARNESS_RATE_LIMITS,
  authLockoutRemaining,
  hitRateLimit,
  tooManyRequests,
} from "@/lib/rate-limit";

/**
 * Exchanges a one-time enrollment token (1 hour, single use) for a new harness
 * and its first refresh token.
 */
export async function POST(req: Request): Promise<Response> {
  const db = getDb();
  const ip = clientIp(req);
  const now = new Date();

  const lockout = await authLockoutRemaining(db, ip, now);
  if (lockout > 0) return tooManyRequests(lockout);
  const limit = await hitRateLimit(db, HARNESS_RATE_LIMITS.enrollPerIp(ip), now);
  if (limit.limited) return tooManyRequests(limit.retryAfterSeconds);

  const body = EnrollRequest.safeParse(await readJson(req));
  if (!body.success) return badRequest();

  const enrolled = await enrollHarness(db, { ...body.data, now });
  if (!enrolled) {
    return authFailure(db, req, { reason: "invalid_enrollment_token" }, now);
  }
  await writeHarnessAudit(db, {
    harnessId: enrolled.harnessId,
    event: "enroll",
    ip,
    detail: {
      name: body.data.name,
      version: body.data.version,
      capabilities: body.data.capabilities,
    },
  });
  return Response.json(enrolled satisfies EnrollResponse);
}
