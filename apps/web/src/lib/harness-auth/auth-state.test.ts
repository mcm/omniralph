import { generateKeyPairSync } from "node:crypto";
import { closeDb, createDb, harnesses, organizations, type Database } from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobDispatcher } from "@/lib/dispatch";
import { startTestRedis, testRedisAvailable, type TestRedis } from "@/lib/hot-state/testing";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ db: undefined as unknown as Database }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
delete process.env.KMS_AGENT_ISSUER_ID;
process.env.LOCAL_AGENT_SIGNING_KEY = privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();

const { HARNESS_AUTH_TTL_SECONDS, harnessAuthKey, readHarnessAuthState } =
  await import("./auth-state");
const { requireHarness } = await import("./verify");
const { revokeHarness } = await import("./revoke");
const { getTokenSigner } = await import("./signer");
const { EPOCH_KEY, closeRedis, getRedis } = await import("@/lib/hot-state");

/** A database that fails any query: proves a read was served from Redis. */
const noPostgres = new Proxy({} as Database, {
  get(_target, property) {
    throw new Error(`Postgres used (db.${String(property)})`);
  },
});

const dispatcher = { republish: vi.fn(async () => undefined) } as unknown as JobDispatcher;

const databaseAvailable = testDatabaseAvailable();
const redisAvailable = await testRedisAvailable();

describe.skipIf(!databaseAvailable || !redisAvailable)("harness auth state", () => {
  let testDb: TestDatabase;
  let testRedis: TestRedis;
  let db: Database;
  let orgId: string;

  beforeAll(async () => {
    [testDb, testRedis] = await Promise.all([createTestDatabase(), startTestRedis()]);
    db = createDb(testDb.uri);
    state.db = db;
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
  }, 180_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await closeRedis();
    if (db) await closeDb(db);
    await Promise.all([testDb?.stop(), testRedis?.stop()]);
  });

  async function newHarness(): Promise<string> {
    const [harness] = await db
      .insert(harnesses)
      .values({ organizationId: orgId, name: "coder-1" })
      .returning();
    return harness!.id;
  }

  async function requestAs(harnessId: string): Promise<Request> {
    const token = await getTokenSigner().signAccessToken(harnessId);
    return new Request("http://localhost/api/harness/heartbeat", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-real-ip": "203.0.113.7" },
    });
  }

  describe("with Redis", () => {
    beforeEach(async () => {
      vi.stubEnv("REDIS_URL", testRedis.url);
      await getRedis().flushall();
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("reads a miss from Postgres and caches it for an hour", async () => {
      const harnessId = await newHarness();
      expect(await readHarnessAuthState(db, harnessId)).toBe("active");
      const redis = getRedis();
      expect(await redis.get(harnessAuthKey(harnessId))).toBe("active");
      const ttl = await redis.ttl(harnessAuthKey(harnessId));
      expect(ttl).toBeGreaterThan(HARNESS_AUTH_TTL_SECONDS - 10);
      expect(ttl).toBeLessThanOrEqual(HARNESS_AUTH_TTL_SECONDS);
    });

    it("serves a cache hit without querying Postgres", async () => {
      const harnessId = await newHarness();
      expect(await readHarnessAuthState(db, harnessId)).toBe("active");
      expect(await readHarnessAuthState(noPostgres, harnessId)).toBe("active");
    });

    it("authenticates a request on a cache hit without querying Postgres", async () => {
      const harnessId = await newHarness();
      expect(await requireHarness(await requestAs(harnessId))).toEqual({ harnessId });
      // The lockout check and the auth state are both answered from Redis.
      state.db = noPostgres;
      try {
        expect(await requireHarness(await requestAs(harnessId))).toEqual({ harnessId });
      } finally {
        state.db = db;
      }
    });

    it("doesn't cache an unknown harness", async () => {
      const harnessId = crypto.randomUUID();
      expect(await readHarnessAuthState(db, harnessId)).toBe("unknown");
      expect(await getRedis().exists(harnessAuthKey(harnessId))).toBe(0);
    });

    it("writes the revocation to Redis so the next request gets 401", async () => {
      const harnessId = await newHarness();
      expect(await requireHarness(await requestAs(harnessId))).toEqual({ harnessId });
      expect(await getRedis().get(harnessAuthKey(harnessId))).toBe("active");

      expect(await revokeHarness(harnessId, { db, dispatcher })).toBe(true);

      expect(await getRedis().get(harnessAuthKey(harnessId))).toBe("revoked");
      expect(await readHarnessAuthState(noPostgres, harnessId)).toBe("revoked");
      const res = await requireHarness(await requestAs(harnessId));
      expect((res as Response).status).toBe(401);
    });

    it("keeps a revoked harness refused after Redis is flushed", async () => {
      const harnessId = await newHarness();
      expect(await requireHarness(await requestAs(harnessId))).toEqual({ harnessId });
      expect(await revokeHarness(harnessId, { db, dispatcher })).toBe(true);

      await getRedis().flushall();
      const res = await requireHarness(await requestAs(harnessId));
      expect((res as Response).status).toBe(401);
      expect(await getRedis().get(harnessAuthKey(harnessId))).toBe("revoked");
    });

    it("drops cached states on a rebuild", async () => {
      const harnessId = await newHarness();
      await readHarnessAuthState(db, harnessId);
      // A stale entry, as left by a revocation whose Redis write failed (which deletes the epoch).
      await db.update(harnesses).set({ revokedAt: new Date() }).where(eq(harnesses.id, harnessId));
      await getRedis().del(EPOCH_KEY);
      expect(await readHarnessAuthState(db, harnessId)).toBe("revoked");
    });
  });

  describe("with REDIS_URL unset", () => {
    beforeEach(() => {
      vi.stubEnv("REDIS_URL", "");
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("reads Postgres on every request", async () => {
      const harnessId = await newHarness();
      expect(await readHarnessAuthState(db, harnessId)).toBe("active");
      await expect(readHarnessAuthState(noPostgres, harnessId)).rejects.toThrow(/Postgres used/);

      expect(await revokeHarness(harnessId, { db, dispatcher })).toBe(true);
      expect(await readHarnessAuthState(db, harnessId)).toBe("revoked");
      const res = await requireHarness(await requestAs(harnessId));
      expect((res as Response).status).toBe(401);
    });
  });
});
