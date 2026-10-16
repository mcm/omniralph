import {
  incrementRateLimit,
  latestRateLimitWindow,
  pruneRateLimits,
  type Database,
} from "@omniralph/db";
import type { Redis } from "ioredis";
import { getRedis, hotStateEnabled } from "@/lib/hot-state";

/**
 * Fixed-window rate limiting, counted in Redis (`rate-limit:{key}:{window start}`,
 * `INCR` + `PEXPIRE`) when hot state is on, so idle agent requests don't wake
 * Postgres; otherwise, or while Redis errors, in Postgres (`rate_limits`: one row
 * per key and window start, counted by a single upsert). Either way it holds
 * across serverless instances. Counters aren't rebuilt: losing Redis resets them.
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

const REDIS_PREFIX = "rate-limit:";

/**
 * When an instance last counted in Postgres while hot state was on (Redis errored):
 * the prune cron keeps sweeping `rate_limits` until those rows are past retention.
 */
export const POSTGRES_FALLBACK_KEY = `${REDIS_PREFIX}postgres-fallback-at`;

/** A Postgres fallback this instance hasn't recorded in Redis yet (it was down). */
let unrecordedFallbackAt: number | undefined;

// Raises the stored timestamp, never lowers it.
const RAISE_SCRIPT = `local c = redis.call('GET', KEYS[1])
if not c or tonumber(c) < tonumber(ARGV[1]) then redis.call('SET', KEYS[1], ARGV[1]) end
return 1`;

// Deletes the key only while it still holds the value read.
const COMPARE_AND_DELETE_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

/** Runs `fromRedis` with hot state on, else (or when Redis errors) `fromPostgres`. */
async function withCounters<T>(
  fromRedis: (redis: Redis) => Promise<T>,
  fromPostgres: () => Promise<T>,
): Promise<T> {
  if (!hotStateEnabled()) return fromPostgres();
  let value: { result: T } | undefined;
  try {
    const redis = getRedis();
    value = { result: await fromRedis(redis) };
    const fallbackAt = unrecordedFallbackAt;
    if (fallbackAt !== undefined) {
      unrecordedFallbackAt = undefined;
      await redis.eval(RAISE_SCRIPT, 1, POSTGRES_FALLBACK_KEY, String(fallbackAt)).catch(() => {
        unrecordedFallbackAt ??= fallbackAt;
      });
    }
  } catch (error) {
    console.warn("rate limit: counting in Postgres", error);
    unrecordedFallbackAt = Date.now();
  }
  return value ? value.result : fromPostgres();
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
  const end = start.getTime() + rule.windowSeconds * 1000;
  const count = await withCounters(
    async (redis) => {
      const key = `${REDIS_PREFIX}${rule.key}:${start.getTime()}`;
      // Kept a second past the window's end, so it never outlives the window by much.
      const ttl = Math.max(1000, end - now.getTime() + 1000);
      const results = await redis.multi().incr(key).pexpire(key, ttl).exec();
      const [error, value] = results?.[0] ?? [new Error("rate limit: transaction aborted")];
      if (error) throw error;
      return Number(value);
    },
    () => incrementRateLimit(db, rule.key, start),
  );
  const retryAfterSeconds = Math.max(1, Math.ceil((end - now.getTime()) / 1000));
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
 * window and lockout above, or a sweep could reset a live counter. Redis
 * counters expire with their window instead.
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
  if (count < AUTH_FAILURE_LIMIT) return;
  // Each attempt past the limit restarts the lockout (the latest one counts).
  await withCounters<unknown>(
    (redis) =>
      redis.set(
        `${REDIS_PREFIX}${lockoutKey(ip)}`,
        String(now.getTime()),
        "PX",
        AUTH_LOCKOUT_SECONDS * 1000,
      ),
    () => incrementRateLimit(db, lockoutKey(ip), now),
  );
}

/** Seconds left on the IP's auth lockout, or 0 when it isn't locked out. */
export async function authLockoutRemaining(
  db: Database,
  ip: string,
  now: Date = new Date(),
): Promise<number> {
  const since = new Date(now.getTime() - AUTH_LOCKOUT_SECONDS * 1000);
  const lockedAt = await withCounters(
    async (redis) => {
      const at = await redis.get(`${REDIS_PREFIX}${lockoutKey(ip)}`);
      return at === null ? null : new Date(Number(at));
    },
    () => latestRateLimitWindow(db, lockoutKey(ip), since),
  );
  if (!lockedAt || lockedAt <= since) return 0;
  return Math.max(
    1,
    Math.ceil((lockedAt.getTime() + AUTH_LOCKOUT_SECONDS * 1000 - now.getTime()) / 1000),
  );
}

/**
 * The prune cron's sweep: deletes `rate_limits` rows whose window started more than
 * `RATE_LIMIT_RETENTION_SECONDS` ago, returning how many. With hot state on, Postgres
 * only holds rows from a Redis outage, so it's swept only while those are recorded
 * (`POSTGRES_FALLBACK_KEY`) and otherwise not queried at all.
 */
export async function pruneRateLimitCounters(
  db: Database,
  now: Date = new Date(),
): Promise<number> {
  const retentionMs = RATE_LIMIT_RETENTION_SECONDS * 1000;
  const before = new Date(now.getTime() - retentionMs);
  if (!hotStateEnabled()) return pruneRateLimits(db, before);
  let fallbackAt: string | null;
  try {
    fallbackAt = await getRedis().get(POSTGRES_FALLBACK_KEY);
  } catch (error) {
    console.warn("rate limit: pruning Postgres, Redis unavailable", error);
    return pruneRateLimits(db, before);
  }
  if (fallbackAt === null) return 0;
  const pruned = await pruneRateLimits(db, before);
  // Once the last fallback's rows are past retention, this sweep removed them all.
  if (Number(fallbackAt) < before.getTime()) {
    await getRedis()
      .eval(COMPARE_AND_DELETE_SCRIPT, 1, POSTGRES_FALLBACK_KEY, fallbackAt)
      .catch(() => undefined);
  }
  return pruned;
}

export function tooManyRequests(retryAfterSeconds: number): Response {
  return Response.json(
    { error: "rate_limited" },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}
