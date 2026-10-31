// `GET /api/ui/agents/{id}/last-seen`: the agent's Redis last-seen for its open panel, which
// polls it every 10 s, so with warm Redis caches it must not query Postgres.
import { agents, closeDb, createDb, organizations, type Database } from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRole, type Role } from "@/lib/auth/roles";
import { startTestRedis, testRedisAvailable, type TestRedis } from "@/lib/hot-state/testing";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ db: undefined as unknown as Database, orgId: "" }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") =>
    assertRole(
      {
        id: "user-1",
        role: "member",
        name: null,
        email: null,
        image: null,
        organization: { id: state.orgId, name: "Acme" },
      },
      role,
    ),
}));

const { GET } = await import("./route");
const { agentLastSeenKey } = await import("@/lib/agents/last-seen");
const { closeRedis, getRedis } = await import("@/lib/hot-state");

const databaseAvailable = testDatabaseAvailable();
const redisAvailable = await testRedisAvailable();

describe.skipIf(!databaseAvailable || !redisAvailable)("GET /api/ui/agents/{id}/last-seen", () => {
  let testDb: TestDatabase;
  let testRedis: TestRedis;
  let db: Database;
  let orgId: string;
  let otherOrgId: string;

  beforeAll(async () => {
    [testDb, testRedis] = await Promise.all([createTestDatabase(), startTestRedis()]);
    db = createDb(testDb.uri);
    state.db = db;
    const [org, other] = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Other" }])
      .returning();
    orgId = org!.id;
    otherOrgId = other!.id;
    state.orgId = orgId;
  }, 180_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await closeRedis();
    if (db) await closeDb(db);
    await Promise.all([testDb?.stop(), testRedis?.stop()]);
  });

  async function newAgent(organizationId = orgId, lastHeartbeatAt: Date | null = null) {
    const [agent] = await db
      .insert(agents)
      .values({ organizationId, name: "coder-1", lastHeartbeatAt })
      .returning();
    return agent!.id;
  }

  async function lastSeen(agentId: string) {
    const response = await GET(new Request(`http://localhost/api/ui/agents/${agentId}/last-seen`), {
      params: Promise.resolve({ id: agentId }),
    });
    return { status: response.status, body: (await response.json()) as unknown };
  }

  /** Runs `read` with `state.db` counting every use of the database. */
  async function countingQueries<T>(read: () => Promise<T>): Promise<{ result: T; uses: number }> {
    let uses = 0;
    const real = db;
    state.db = new Proxy(real, {
      get(target, prop, receiver) {
        uses += 1;
        return Reflect.get(target, prop, receiver);
      },
    });
    try {
      return { result: await read(), uses };
    } finally {
      state.db = real;
    }
  }

  describe("with Redis", () => {
    beforeEach(async () => {
      vi.stubEnv("REDIS_URL", testRedis.url);
      await closeRedis();
      await getRedis().flushdb();
    });

    it("answers the Redis last-seen without querying Postgres once the caches are warm", async () => {
      const agentId = await newAgent(orgId, new Date("2026-10-30T08:00:00.000Z"));
      const seen = new Date("2026-10-31T12:00:05.000Z");
      await getRedis().set(agentLastSeenKey(agentId), String(seen.getTime()));
      // The first read fills the hot-state epoch and the agent's cached organization.
      const cold = await countingQueries(() => lastSeen(agentId));
      expect(cold.result).toEqual({ status: 200, body: { lastHeartbeatAt: seen.toISOString() } });
      expect(cold.uses).toBeGreaterThan(0);

      const { result, uses } = await countingQueries(() => lastSeen(agentId));
      expect(result).toEqual({ status: 200, body: { lastHeartbeatAt: seen.toISOString() } });
      expect(uses).toBe(0);
    });

    it("answers null when Redis has no last-seen for the agent", async () => {
      const agentId = await newAgent(orgId, new Date("2026-10-30T08:00:00.000Z"));
      expect(await lastSeen(agentId)).toEqual({ status: 200, body: { lastHeartbeatAt: null } });
    });

    it("is not found for an agent of an organization the user isn't a member of", async () => {
      const agentId = await newAgent(otherOrgId);
      await getRedis().set(agentLastSeenKey(agentId), String(Date.now()));
      expect((await lastSeen(agentId)).status).toBe(404);
    });

    it("is not found for an unknown agent or an ID that isn't a UUID", async () => {
      expect((await lastSeen("aaaaaaaa-0000-4000-8000-000000000000")).status).toBe(404);
      expect((await lastSeen("not-a-uuid")).status).toBe(404);
    });
  });

  describe("without Redis", () => {
    beforeEach(async () => {
      vi.stubEnv("REDIS_URL", "");
      await closeRedis();
    });

    it("finds the organization in Postgres and answers null", async () => {
      const agentId = await newAgent(orgId, new Date("2026-10-30T08:00:00.000Z"));
      expect(await lastSeen(agentId)).toEqual({ status: 200, body: { lastHeartbeatAt: null } });
      expect((await lastSeen(await newAgent(otherOrgId))).status).toBe(404);
    });
  });
});
