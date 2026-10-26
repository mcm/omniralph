import { closeDb, createDb, rateLimits, type Database } from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestRedis, testRedisAvailable, type TestRedis } from "@/lib/hot-state/testing";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ db: undefined as unknown as Database }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));

process.env.CRON_SECRET = "cron-secret";

const { GET: pruneRoute } = await import("./prune-rate-limits/route");
const {
  AGENT_RATE_LIMITS,
  AUTH_FAILURE_LIMIT,
  AUTH_FAILURE_WINDOW_SECONDS,
  AUTH_LOCKOUT_SECONDS,
  POSTGRES_FALLBACK_KEY,
  RATE_LIMIT_RETENTION_SECONDS,
  authLockoutRemaining,
  hitRateLimit,
  recordAuthFailure,
} = await import("@/lib/rate-limit");
const { closeRedis, getRedis } = await import("@/lib/hot-state");

/** A database that fails any query: proves Postgres wasn't used. */
const noPostgres = new Proxy({} as Database, {
  get(_target, property) {
    throw new Error(`Postgres used (db.${String(property)})`);
  },
});

const databaseAvailable = testDatabaseAvailable();
const redisAvailable = await testRedisAvailable();

function cronRequest(secret?: string) {
  return new Request("http://localhost/api/cron/prune-rate-limits", {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000);

describe.skipIf(!databaseAvailable || !redisAvailable)("rate limits", () => {
  let testDb: TestDatabase;
  let testRedis: TestRedis;
  let db: Database;

  beforeAll(async () => {
    [testDb, testRedis] = await Promise.all([createTestDatabase(), startTestRedis()]);
    db = createDb(testDb.uri);
    state.db = db;
  }, 180_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await closeRedis();
    if (db) await closeDb(db);
    await Promise.all([testDb?.stop(), testRedis?.stop()]);
  });

  async function keys(): Promise<string[]> {
    const rows = await db.select({ key: rateLimits.key }).from(rateLimits);
    return rows.map((r) => r.key).sort();
  }

  async function useRedis(url: string | undefined) {
    await closeRedis();
    vi.stubEnv("REDIS_URL", url ?? "");
  }

  it("keeps windows longer than every lockout and failure window", () => {
    expect(RATE_LIMIT_RETENTION_SECONDS).toBe(60 * 60);
    expect(RATE_LIMIT_RETENTION_SECONDS).toBeGreaterThan(AUTH_LOCKOUT_SECONDS);
    expect(RATE_LIMIT_RETENTION_SECONDS).toBeGreaterThan(AUTH_FAILURE_WINDOW_SECONDS);
  });

  describe.each([
    { backend: "Postgres", redis: false },
    { backend: "Redis", redis: true },
  ])("counting in $backend", ({ redis }) => {
    beforeEach(async () => {
      await useRedis(redis ? testRedis.url : undefined);
      await db.delete(rateLimits);
      if (redis) await getRedis().flushall();
    });

    it("counts a fixed window and reports when it ends", async () => {
      const rule = { key: `window:${redis}`, limit: 2, windowSeconds: 60 };
      const start = Math.floor(Date.now() / 60_000) * 60_000;
      const at = (seconds: number) => new Date(start + seconds * 1000);
      expect(await hitRateLimit(db, rule, at(10))).toEqual({
        limited: false,
        count: 1,
        retryAfterSeconds: 50,
      });
      expect(await hitRateLimit(db, rule, at(20.5))).toEqual({
        limited: false,
        count: 2,
        retryAfterSeconds: 40,
      });
      expect(await hitRateLimit(db, rule, at(59.9))).toEqual({
        limited: true,
        count: 3,
        retryAfterSeconds: 1,
      });
      // The next window starts over.
      expect(await hitRateLimit(db, rule, at(60))).toEqual({
        limited: false,
        count: 1,
        retryAfterSeconds: 60,
      });
      // Keys are independent.
      expect((await hitRateLimit(db, { ...rule, key: "other" }, at(30))).count).toBe(1);
    });

    it("locks an IP out after too many failed attempts", async () => {
      const ip = "203.0.113.9";
      const now = new Date();
      for (let i = 0; i < AUTH_FAILURE_LIMIT - 1; i += 1) await recordAuthFailure(db, ip, now);
      expect(await authLockoutRemaining(db, ip, now)).toBe(0);
      await recordAuthFailure(db, ip, now);
      expect(await authLockoutRemaining(db, ip, now)).toBe(AUTH_LOCKOUT_SECONDS);
      const later = new Date(now.getTime() + 60_000);
      expect(await authLockoutRemaining(db, ip, later)).toBe(AUTH_LOCKOUT_SECONDS - 60);
      const over = new Date(now.getTime() + AUTH_LOCKOUT_SECONDS * 1000);
      expect(await authLockoutRemaining(db, ip, over)).toBe(0);
      expect(await authLockoutRemaining(db, "203.0.113.10", now)).toBe(0);
      // Postgres holds nothing while Redis counts.
      expect(await keys()).toEqual(
        redis ? [] : ["auth_failed:ip:203.0.113.9", "auth_lockout:ip:203.0.113.9"],
      );
    });

    it("requires CRON_SECRET", async () => {
      await db.insert(rateLimits).values({ key: "x", windowStart: minutesAgo(120), count: 1 });
      expect((await pruneRoute(cronRequest())).status).toBe(401);
      expect((await pruneRoute(cronRequest("wrong"))).status).toBe(401);
      expect(await keys()).toEqual(["x"]);
    });
  });

  describe("pruning Postgres without Redis", () => {
    beforeEach(async () => {
      await useRedis(undefined);
      await db.delete(rateLimits);
    });

    it("deletes windows older than 1 hour and keeps current ones", async () => {
      await db.insert(rateLimits).values([
        { key: "token:ip:old", windowStart: minutesAgo(61), count: 5 },
        { key: "auth_lockout:ip:old", windowStart: minutesAgo(24 * 60), count: 1 },
        { key: "token:ip:recent", windowStart: minutesAgo(59), count: 2 },
      ]);
      // Live counters written the way the agent API writes them.
      await hitRateLimit(db, AGENT_RATE_LIMITS.enrollPerIp("203.0.113.1"));
      for (let i = 0; i < AUTH_FAILURE_LIMIT; i += 1) {
        await recordAuthFailure(db, "203.0.113.2");
      }
      expect(await authLockoutRemaining(db, "203.0.113.2")).toBeGreaterThan(0);

      const res = await pruneRoute(cronRequest("cron-secret"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ pruned: 2 });

      expect(await keys()).toEqual([
        "auth_failed:ip:203.0.113.2",
        "auth_lockout:ip:203.0.113.2",
        "enroll:ip:203.0.113.1",
        "token:ip:recent",
      ]);
      // The lockout and the failure count survive the sweep.
      expect(await authLockoutRemaining(db, "203.0.113.2")).toBeGreaterThan(0);
      const [failed] = await db
        .select({ count: rateLimits.count })
        .from(rateLimits)
        .where(eq(rateLimits.key, "auth_failed:ip:203.0.113.2"));
      expect(failed?.count).toBe(AUTH_FAILURE_LIMIT);
    });
  });

  describe("pruning with Redis", () => {
    beforeEach(async () => {
      await useRedis(testRedis.url);
      await db.delete(rateLimits);
      await getRedis().flushall();
    });

    it("returns without querying Postgres", async () => {
      await hitRateLimit(noPostgres, AGENT_RATE_LIMITS.enrollPerIp("203.0.113.1"));
      for (let i = 0; i < AUTH_FAILURE_LIMIT; i += 1) {
        await recordAuthFailure(noPostgres, "203.0.113.2");
      }
      expect(await authLockoutRemaining(noPostgres, "203.0.113.2")).toBeGreaterThan(0);

      state.db = noPostgres;
      try {
        const res = await pruneRoute(cronRequest("cron-secret"));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ pruned: 0 });
      } finally {
        state.db = db;
      }
      expect(await authLockoutRemaining(noPostgres, "203.0.113.2")).toBeGreaterThan(0);
    });

    it("counts in Postgres while Redis is down and sweeps those rows later", async () => {
      // Nothing listens on port 1: every Redis command fails.
      await useRedis("redis://127.0.0.1:1");
      const rule = AGENT_RATE_LIMITS.enrollPerIp("203.0.113.3");
      expect((await hitRateLimit(db, rule)).count).toBe(1);
      expect(await keys()).toEqual(["enroll:ip:203.0.113.3"]);

      // Back up: the next count records the fallback, so the cron sweeps Postgres.
      await useRedis(testRedis.url);
      await hitRateLimit(db, AGENT_RATE_LIMITS.enrollPerIp("203.0.113.4"));
      const recordedAt = Number(await getRedis().get(POSTGRES_FALLBACK_KEY));
      expect(recordedAt).toBeGreaterThan(Date.now() - 60_000);

      await db
        .insert(rateLimits)
        .values({ key: "token:ip:old", windowStart: minutesAgo(61), count: 1 });
      let res = await pruneRoute(cronRequest("cron-secret"));
      expect(await res.json()).toEqual({ pruned: 1 });
      // The fallback's rows aren't past retention yet: keep sweeping.
      expect(await getRedis().get(POSTGRES_FALLBACK_KEY)).toBe(String(recordedAt));

      // Once they are, the last sweep removes them and stops sweeping.
      await getRedis().set(POSTGRES_FALLBACK_KEY, String(minutesAgo(61).getTime()));
      await db.update(rateLimits).set({ windowStart: minutesAgo(61) });
      res = await pruneRoute(cronRequest("cron-secret"));
      expect(await res.json()).toEqual({ pruned: 1 });
      expect(await keys()).toEqual([]);
      expect(await getRedis().get(POSTGRES_FALLBACK_KEY)).toBeNull();
    });
  });
});
