import type { Database } from "@omniralph/db";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestRedis, testRedisAvailable, type TestRedis } from "./testing";

vi.mock("server-only", () => ({}));

const {
  EPOCH_KEY,
  REBUILD_LOCK_KEY,
  closeRedis,
  ensureHotStateEpoch,
  getRedis,
  hotStateEnabled,
  readHotState,
  registerHotStateRebuilder,
  unregisterHotStateRebuilder,
  writeHotState,
} = await import("./index");

// The epoch helper hands rebuilders the database; these tests' rebuilders don't use it.
const db = {} as Database;

describe("with REDIS_URL unset", () => {
  beforeEach(() => {
    vi.stubEnv("REDIS_URL", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports hot state off and refuses a client", () => {
    expect(hotStateEnabled()).toBe(false);
    expect(() => getRedis()).toThrow(/REDIS_URL/);
  });

  it("reads from Postgres without touching Redis", async () => {
    const fromRedis = vi.fn(async () => "redis");
    await expect(readHotState(db, fromRedis, async () => "postgres")).resolves.toBe("postgres");
    expect(fromRedis).not.toHaveBeenCalled();
  });

  it("skips writes", async () => {
    const update = vi.fn(async () => undefined);
    await writeHotState(update);
    expect(update).not.toHaveBeenCalled();
  });
});

const redisAvailable = await testRedisAvailable();

describe.skipIf(!redisAvailable)("with Redis", () => {
  let testRedis: TestRedis;
  const rebuild = vi.fn(async (redis: Redis) => {
    await redis.set("test:derived", "rebuilt");
  });

  beforeAll(async () => {
    testRedis = await startTestRedis();
  });
  afterAll(async () => {
    await closeRedis();
    await testRedis?.stop();
  });
  beforeEach(async () => {
    vi.stubEnv("REDIS_URL", testRedis.url);
    await getRedis().flushall();
    rebuild.mockClear();
    registerHotStateRebuilder("test", rebuild);
  });
  afterEach(() => {
    unregisterHotStateRebuilder("test");
    vi.unstubAllEnvs();
  });

  it("creates one client lazily", () => {
    expect(hotStateEnabled()).toBe(true);
    expect(getRedis()).toBe(getRedis());
  });

  it("rebuilds when the epoch is missing, then trusts it", async () => {
    const redis = getRedis();
    await expect(ensureHotStateEpoch(redis, db)).resolves.toBe(true);
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(rebuild).toHaveBeenCalledWith(redis, db);
    expect(await redis.get("test:derived")).toBe("rebuilt");
    expect(await redis.exists(EPOCH_KEY)).toBe(1);
    expect(await redis.ttl(EPOCH_KEY)).toBe(-1);
    expect(await redis.exists(REBUILD_LOCK_KEY)).toBe(0);

    await expect(ensureHotStateEpoch(redis, db)).resolves.toBe(true);
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it("rebuilds again after Redis loses its data", async () => {
    const redis = getRedis();
    await ensureHotStateEpoch(redis, db);
    await redis.flushall();
    await ensureHotStateEpoch(redis, db);
    expect(rebuild).toHaveBeenCalledTimes(2);
    expect(await redis.get("test:derived")).toBe("rebuilt");
  });

  it("runs one rebuild for concurrent callers", async () => {
    const redis = getRedis();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => ensureHotStateEpoch(redis, db)),
    );
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(results.filter(Boolean).length).toBeGreaterThanOrEqual(1);
    expect(await redis.exists(EPOCH_KEY)).toBe(1);
  });

  it("doesn't rebuild while another instance holds the lock", async () => {
    const redis = getRedis();
    await redis.set(REBUILD_LOCK_KEY, "someone-else", "PX", 30_000);
    await expect(ensureHotStateEpoch(redis, db)).resolves.toBe(false);
    expect(rebuild).not.toHaveBeenCalled();
    expect(await redis.get(REBUILD_LOCK_KEY)).toBe("someone-else");
  });

  it("leaves the epoch unset and releases the lock when a rebuilder fails", async () => {
    const redis = getRedis();
    rebuild.mockRejectedValueOnce(new Error("postgres down"));
    await expect(ensureHotStateEpoch(redis, db)).rejects.toThrow("postgres down");
    expect(await redis.exists(EPOCH_KEY)).toBe(0);
    expect(await redis.exists(REBUILD_LOCK_KEY)).toBe(0);

    await expect(ensureHotStateEpoch(redis, db)).resolves.toBe(true);
    expect(rebuild).toHaveBeenCalledTimes(2);
  });

  it("reads from Redis once the epoch is current", async () => {
    const fromPostgres = vi.fn(async () => "postgres");
    const value = await readHotState(db, async (redis) => redis.get("test:derived"), fromPostgres);
    expect(value).toBe("rebuilt");
    expect(fromPostgres).not.toHaveBeenCalled();
  });

  it("falls back to Postgres while another instance rebuilds or when Redis fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const redis = getRedis();
    await redis.set(REBUILD_LOCK_KEY, "someone-else", "PX", 30_000);
    await expect(
      readHotState(
        db,
        async () => "redis",
        async () => "postgres",
      ),
    ).resolves.toBe("postgres");
    await redis.del(REBUILD_LOCK_KEY);
    await expect(
      readHotState(
        db,
        async () => {
          throw new Error("WRONGTYPE");
        },
        async () => "postgres",
      ),
    ).resolves.toBe("postgres");
    warn.mockRestore();
  });

  it("forces a rebuild when a write fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const redis = getRedis();
    await ensureHotStateEpoch(redis, db);
    await writeHotState(async (r) => r.set("test:derived", "updated"));
    expect(await redis.get("test:derived")).toBe("updated");
    expect(await redis.exists(EPOCH_KEY)).toBe(1);

    await writeHotState(async () => {
      throw new Error("timeout");
    });
    expect(await redis.exists(EPOCH_KEY)).toBe(0);
    warn.mockRestore();
  });
});
