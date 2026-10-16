import "server-only";
import { Redis } from "ioredis";

/**
 * The control panel's Redis (Upstash over TCP, `REDIS_URL`), holding hot state for
 * idle agent paths so Postgres (Neon) can suspend. Redis only holds what can be
 * rebuilt from Postgres; with `REDIS_URL` unset, callers use Postgres directly.
 */

let redis: Redis | undefined;

/** Whether hot state is configured (`REDIS_URL` set); without it, every caller reads Postgres. */
export function hotStateEnabled(): boolean {
  return Boolean(process.env.REDIS_URL);
}

/** The shared Redis client, created on first use. Throws when `REDIS_URL` is unset. */
export function getRedis(): Redis {
  if (!redis) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is not set: check hotStateEnabled() first");
    redis = new Redis(url, {
      // Fail a command quickly while Redis is unreachable, so callers fall back to
      // Postgres instead of queueing behind reconnect attempts.
      maxRetriesPerRequest: 1,
      connectTimeout: 5_000,
      commandTimeout: 2_000,
    });
    // Without a listener, ioredis logs every connection error as unhandled.
    redis.on("error", (error: unknown) => {
      console.warn("hot-state: Redis error", error);
    });
  }
  return redis;
}

/** Disconnects and forgets the shared client (tests, or after changing `REDIS_URL`). */
export async function closeRedis(): Promise<void> {
  const current = redis;
  redis = undefined;
  if (current) await current.quit().catch(() => current.disconnect());
}
