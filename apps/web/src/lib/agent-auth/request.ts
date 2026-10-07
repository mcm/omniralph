import { writeAgentAudit, type Database } from "@omniralph/db";
import { hitRateLimit, recordAuthFailure } from "@/lib/rate-limit";

/**
 * The caller's IP. On Vercel, `x-real-ip`/`x-forwarded-for` are set by the
 * platform (client-supplied values are overwritten).
 */
export function clientIp(req: Request): string {
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "unknown";
}

export function unauthorized(error = "unauthorized"): Response {
  return Response.json({ error }, { status: 401 });
}

export function badRequest(error = "invalid_request"): Response {
  return Response.json({ error }, { status: 400 });
}

/** Reads a JSON body, or `undefined` when it isn't valid JSON. */
export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

/**
 * Writes an `auth_failed` audit row, sampled to at most one per agent (or per
 * IP when the agent is unknown) per minute.
 */
async function auditAuthFailure(
  db: Database,
  input: { agentId: string | null; ip: string; reason: string; path: string },
  now: Date,
): Promise<void> {
  const subject = input.agentId ? `agent:${input.agentId}` : `ip:${input.ip}`;
  const { count } = await hitRateLimit(
    db,
    { key: `audit:auth_failed:${subject}`, limit: 1, windowSeconds: 60 },
    now,
  );
  if (count !== 1) return;
  await writeAgentAudit(db, {
    agentId: input.agentId,
    event: "auth_failed",
    ip: input.ip,
    detail: { reason: input.reason, path: input.path },
  });
}

/**
 * A failed authentication attempt: counts towards the IP's lockout (unless
 * `lockout` is false), writes a sampled `auth_failed` audit row and returns 401.
 */
export async function authFailure(
  db: Database,
  req: Request,
  input: { agentId?: string | null; reason: string; error?: string; lockout?: boolean },
  now: Date = new Date(),
): Promise<Response> {
  const ip = clientIp(req);
  if (input.lockout !== false) await recordAuthFailure(db, ip, now);
  await auditAuthFailure(
    db,
    { agentId: input.agentId ?? null, ip, reason: input.reason, path: new URL(req.url).pathname },
    now,
  );
  return unauthorized(input.error);
}
