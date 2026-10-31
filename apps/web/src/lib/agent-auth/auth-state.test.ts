import { generateKeyPairSync } from "node:crypto";
import { closeDb, createDb, agents, organizations, type Database } from "@omniralph/db";
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

const { agentAuthKey, cacheAgentRevoked, readAgentAuthState } = await import("./auth-state");
const { requireAgent } = await import("./verify");
const { revokeAgent } = await import("./revoke");
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

describe.skipIf(!databaseAvailable || !redisAvailable)("agent auth state", () => {
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

  async function newAgent(): Promise<string> {
    const [agent] = await db
      .insert(agents)
      .values({ organizationId: orgId, name: "coder-1" })
      .returning();
    return agent!.id;
  }

  async function requestAs(agentId: string): Promise<Request> {
    const token = await getTokenSigner().signAccessToken(agentId);
    return new Request("http://localhost/api/agent/heartbeat", {
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

    describe("at a fixed time", () => {
      beforeEach(() => {
        // Only Date: Redis and Postgres keep real timers.
        vi.useFakeTimers({ toFake: ["Date"] });
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      it("reads a miss from Postgres and caches it until the next daily window", async () => {
        vi.setSystemTime(new Date("2026-10-31T12:00:00Z"));
        const agentId = await newAgent();
        expect(await readAgentAuthState(db, agentId)).toBe("active");
        const redis = getRedis();
        expect(await redis.get(agentAuthKey(agentId))).toBe("active");
        // 03:15 UTC tomorrow, not a day after it was cached.
        const pttl = await redis.pttl(agentAuthKey(agentId));
        expect(pttl).toBeGreaterThan(15.25 * 3600_000 - 60_000);
        expect(pttl).toBeLessThanOrEqual(15.25 * 3600_000);
      });

      it("expires a state cached just before the window at the window's start", async () => {
        vi.setSystemTime(new Date("2026-10-31T03:14:00Z"));
        const agentId = await newAgent();
        expect(await readAgentAuthState(db, agentId)).toBe("active");
        const pttl = await getRedis().pttl(agentAuthKey(agentId));
        expect(pttl).toBeGreaterThan(0);
        expect(pttl).toBeLessThanOrEqual(60_000);
      });

      it("overwrites a cached state with the revocation, which also lasts until the window", async () => {
        vi.setSystemTime(new Date("2026-10-31T12:00:00Z"));
        const agentId = await newAgent();
        expect(await readAgentAuthState(db, agentId)).toBe("active");
        await cacheAgentRevoked(agentId);
        expect(await readAgentAuthState(noPostgres, agentId)).toBe("revoked");
        const pttl = await getRedis().pttl(agentAuthKey(agentId));
        expect(pttl).toBeGreaterThan(15.25 * 3600_000 - 60_000);
        expect(pttl).toBeLessThanOrEqual(15.25 * 3600_000);
      });
    });

    it("serves a cache hit without querying Postgres", async () => {
      const agentId = await newAgent();
      expect(await readAgentAuthState(db, agentId)).toBe("active");
      expect(await readAgentAuthState(noPostgres, agentId)).toBe("active");
    });

    it("authenticates a request on a cache hit without querying Postgres", async () => {
      const agentId = await newAgent();
      expect(await requireAgent(await requestAs(agentId))).toEqual({ agentId });
      // The lockout check and the auth state are both answered from Redis.
      state.db = noPostgres;
      try {
        expect(await requireAgent(await requestAs(agentId))).toEqual({ agentId });
      } finally {
        state.db = db;
      }
    });

    it("doesn't cache an unknown agent", async () => {
      const agentId = crypto.randomUUID();
      expect(await readAgentAuthState(db, agentId)).toBe("unknown");
      expect(await getRedis().exists(agentAuthKey(agentId))).toBe(0);
    });

    it("writes the revocation to Redis so the next request gets 401", async () => {
      const agentId = await newAgent();
      expect(await requireAgent(await requestAs(agentId))).toEqual({ agentId });
      expect(await getRedis().get(agentAuthKey(agentId))).toBe("active");

      expect(await revokeAgent(agentId, { db, dispatcher })).toBe(true);

      expect(await getRedis().get(agentAuthKey(agentId))).toBe("revoked");
      expect(await readAgentAuthState(noPostgres, agentId)).toBe("revoked");
      const res = await requireAgent(await requestAs(agentId));
      expect((res as Response).status).toBe(401);
    });

    it("keeps a revoked agent refused after Redis is flushed", async () => {
      const agentId = await newAgent();
      expect(await requireAgent(await requestAs(agentId))).toEqual({ agentId });
      expect(await revokeAgent(agentId, { db, dispatcher })).toBe(true);

      await getRedis().flushall();
      const res = await requireAgent(await requestAs(agentId));
      expect((res as Response).status).toBe(401);
      expect(await getRedis().get(agentAuthKey(agentId))).toBe("revoked");
    });

    it("drops cached states on a rebuild", async () => {
      const agentId = await newAgent();
      await readAgentAuthState(db, agentId);
      // A stale entry, as left by a revocation whose Redis write failed (which deletes the epoch).
      await db.update(agents).set({ revokedAt: new Date() }).where(eq(agents.id, agentId));
      await getRedis().del(EPOCH_KEY);
      expect(await readAgentAuthState(db, agentId)).toBe("revoked");
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
      const agentId = await newAgent();
      expect(await readAgentAuthState(db, agentId)).toBe("active");
      await expect(readAgentAuthState(noPostgres, agentId)).rejects.toThrow(/Postgres used/);

      expect(await revokeAgent(agentId, { db, dispatcher })).toBe(true);
      expect(await readAgentAuthState(db, agentId)).toBe("revoked");
      const res = await requireAgent(await requestAs(agentId));
      expect((res as Response).status).toBe(401);
    });
  });
});
