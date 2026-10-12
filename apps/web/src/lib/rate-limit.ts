import { incrementRateLimit, latestRateLimitWindow, type Database } from "@omniralph/db";

/**
 * Fixed-window rate limiting in Postgres (`rate_limits`): one counter row per
 * (key, window start). Counting is a single upsert, so it holds across
 * serverless instances.
 */
export interface RateLimit {
  /** Counter key, e.g. `enroll:ip:1.2.3.4`. */
  key: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  limited: boolean;
  count: number;
  /** Seconds until the current window ends. */
  retryAfterSeconds: number;
}

function windowStartFor(now: Date, windowSeconds: number): Date {
  const size = windowSeconds * 1000;
  return new Date(Math.floor(now.getTime() / size) * size);
}

/** Counts one hit against `rule`; `limited` once the window's count exceeds the limit. */
export async function hitRateLimit(
  db: Database,
  rule: RateLimit,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  const start = windowStartFor(now, rule.windowSeconds);
  const count = await incrementRateLimit(db, rule.key, start);
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((start.getTime() + rule.windowSeconds * 1000 - now.getTime()) / 1000),
  );
  return { limited: count > rule.limit, count, retryAfterSeconds };
}

/** Agent API limits (US-017). */
export const HARNESS_RATE_LIMITS = {
  enrollPerIp: (ip: string): RateLimit => ({
    key: `enroll:ip:${ip}`,
    limit: 10,
    windowSeconds: 60,
  }),
  tokenPerIp: (ip: string): RateLimit => ({ key: `token:ip:${ip}`, limit: 60, windowSeconds: 60 }),
  tokenPerHarness: (harnessId: string): RateLimit => ({
    key: `token:agent:${harnessId}`,
    limit: 30,
    windowSeconds: 60,
  }),
} as const;

/** Control-panel agent turns in chat threads (TOOL-188). */
export const CHAT_AGENT_RATE_LIMITS = {
  perOrganization: (organizationId: string): RateLimit => ({
    key: `chat_agent:org:${organizationId}`,
    limit: 60,
    windowSeconds: 10 * 60,
  }),
  perChatUser: (organizationId: string, platform: string, externalUserId: string): RateLimit => ({
    key: `chat_agent:user:${organizationId}:${platform}:${externalUserId}`,
    limit: 10,
    windowSeconds: 60,
  }),
  /**
   * Wake-ups: responder turns relaying run events (`lib/chat/agent/wake.ts`),
   * counted apart from people's turns.
   */
  wakePerOrganization: (organizationId: string): RateLimit => ({
    key: `chat_agent:wake:${organizationId}`,
    limit: 60,
    windowSeconds: 10 * 60,
  }),
} as const;

/** After this many failed auth attempts from one IP within the window, the IP is locked out. */
export const AUTH_FAILURE_LIMIT = 20;
export const AUTH_FAILURE_WINDOW_SECONDS = 10 * 60;
export const AUTH_LOCKOUT_SECONDS = 10 * 60;

/**
 * How long `rate_limits` rows are kept (the prune cron). Must exceed every
 * window and lockout above, or a sweep could reset a live counter.
 */
export const RATE_LIMIT_RETENTION_SECONDS = 60 * 60;

const lockoutKey = (ip: string) => `auth_lockout:ip:${ip}`;

/**
 * Records a failed auth attempt from `ip`. The attempt that reaches
 * `AUTH_FAILURE_LIMIT` within a window starts a lockout of `AUTH_LOCKOUT_SECONDS`.
 */
export async function recordAuthFailure(
  db: Database,
  ip: string,
  now: Date = new Date(),
): Promise<void> {
  const { count } = await hitRateLimit(
    db,
    {
      key: `auth_failed:ip:${ip}`,
      limit: AUTH_FAILURE_LIMIT,
      windowSeconds: AUTH_FAILURE_WINDOW_SECONDS,
    },
    now,
  );
  if (count >= AUTH_FAILURE_LIMIT) await incrementRateLimit(db, lockoutKey(ip), now);
}

/** Seconds left on the IP's auth lockout, or 0 when it isn't locked out. */
export async function authLockoutRemaining(
  db: Database,
  ip: string,
  now: Date = new Date(),
): Promise<number> {
  const since = new Date(now.getTime() - AUTH_LOCKOUT_SECONDS * 1000);
  const lockedAt = await latestRateLimitWindow(db, lockoutKey(ip), since);
  if (!lockedAt) return 0;
  return Math.max(
    1,
    Math.ceil((lockedAt.getTime() + AUTH_LOCKOUT_SECONDS * 1000 - now.getTime()) / 1000),
  );
}

export function tooManyRequests(retryAfterSeconds: number): Response {
  return Response.json(
    { error: "rate_limited" },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}
