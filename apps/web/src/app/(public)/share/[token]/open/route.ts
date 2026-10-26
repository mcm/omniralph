import { findActiveWorkItemShareLink } from "@omniralph/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { clientIp } from "@/lib/agent-auth/request";
import { getDb } from "@/lib/db";
import { hitRateLimit } from "@/lib/rate-limit";
import {
  createShareAccess,
  hashShareToken,
  isShareToken,
  SHARE_ACCESS_COOKIE,
  SHARE_LINK_GONE_MESSAGE,
  SHARE_PASSWORD_ATTEMPTS_PER_MINUTE,
  SHARE_RESPONSE_HEADERS,
  SHARE_TOO_MANY_ATTEMPTS_MESSAGE,
  SHARE_WRONG_PASSWORD_MESSAGE,
  shareAccessCookieOptions,
  verifySharePassword,
} from "@/lib/work-items/share-links";

const bodySchema = z.object({ password: z.string().max(200) });

function answer(status: number, body?: { error: string }): NextResponse {
  const response = body ? NextResponse.json(body, { status }) : new NextResponse(null, { status });
  for (const [name, value] of Object.entries(SHARE_RESPONSE_HEADERS)) {
    response.headers.set(name, value);
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}

/**
 * Opens a password-protected review link: the right password sets an HTTP-only cookie
 * scoped to `/share/{token}` for 12 hours (204). A wrong one answers 401; more than
 * `SHARE_PASSWORD_ATTEMPTS_PER_MINUTE` attempts a minute per link and IP answer 429. No session.
 */
export async function POST(
  request: Request,
  route: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await route.params;
  const db = getDb();
  const link = isShareToken(token)
    ? await findActiveWorkItemShareLink(db, hashShareToken(token))
    : null;
  if (!link) return answer(404, { error: SHARE_LINK_GONE_MESSAGE });
  if (link.passwordHash === null) return answer(204);

  const limit = await hitRateLimit(db, {
    key: `share_password:${link.id}:${clientIp(request)}`,
    limit: SHARE_PASSWORD_ATTEMPTS_PER_MINUTE,
    windowSeconds: 60,
  });
  if (limit.limited) {
    const response = answer(429, { error: SHARE_TOO_MANY_ATTEMPTS_MESSAGE });
    response.headers.set("Retry-After", String(limit.retryAfterSeconds));
    return response;
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    const body = bodySchema.safeParse(await request.json());
    if (!body.success) return answer(400, { error: SHARE_WRONG_PASSWORD_MESSAGE });
    parsed = body.data;
  } catch {
    return answer(400, { error: SHARE_WRONG_PASSWORD_MESSAGE });
  }
  if (!(await verifySharePassword(parsed.password, link.passwordHash))) {
    return answer(401, { error: SHARE_WRONG_PASSWORD_MESSAGE });
  }
  const response = answer(204);
  response.cookies.set(
    SHARE_ACCESS_COOKIE,
    createShareAccess(link.id),
    shareAccessCookieOptions(token),
  );
  return response;
}
