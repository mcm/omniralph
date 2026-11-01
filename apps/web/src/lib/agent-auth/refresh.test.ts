import { generateKeyPairSync } from "node:crypto";
import {
  agents,
  closeDb,
  createAgentEnrollment,
  createAgentReenrollment,
  createDb,
  listAgentAudit,
  organizations,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestRedis, testRedisAvailable, type TestRedis } from "@/lib/hot-state/testing";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ db: undefined as unknown as Database }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
delete process.env.KMS_AGENT_ISSUER_ID;
process.env.LOCAL_AGENT_SIGNING_KEY = privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
process.env.CRON_SECRET = "cron-secret";

const { POST: enroll } = await import("@/app/api/agent/enroll/route");
const { POST: token } = await import("@/app/api/agent/token/route");
const { GET: flushRoute } = await import("@/app/api/cron/flush-agent-auth/route");
const { requireAgent } = await import("./verify");
const { getTokenSigner } = await import("./signer");
const { REENROLL_GENERATION_GAP, REFRESH_AUDIT_KEY, REFRESH_CHANGED_KEY } =
  await import("./refresh");
const { EPOCH_KEY, REBUILD_LOCK_KEY, closeRedis, getRedis } = await import("@/lib/hot-state");

/** A database that fails any use: proves a refresh didn't touch Postgres. */
const noPostgres = new Proxy({} as Database, {
  get(_target, property) {
    throw new Error(`Postgres used (db.${String(property)})`);
  },
});

const databaseAvailable = testDatabaseAvailable();
const redisAvailable = await testRedisAvailable();

let ipCounter = 0;
function newIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost/api/agent/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": newIp() },
    body: JSON.stringify(body),
  });
}

function cronRequest(): Request {
  return new Request("http://localhost/api/cron/flush-agent-auth", {
    headers: { authorization: "Bearer cron-secret" },
  });
}

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

describe.skipIf(!databaseAvailable || !redisAvailable)("write-free token refresh", () => {
  let testDb: TestDatabase;
  let testRedis: TestRedis;
  let db: Database;
  let orgId: string;

  beforeAll(async () => {
    [testDb, testRedis] = await Promise.all([createTestDatabase(), startTestRedis()]);
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
    vi.stubEnv("REDIS_URL", testRedis.url);
  }, 180_000);

  beforeEach(() => {
    state.db = db;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await closeRedis();
    if (db) await closeDb(db);
    await Promise.all([testDb?.stop(), testRedis?.stop()]);
  });

  async function enrollNew(): Promise<{ agentId: string; refreshToken: string }> {
    const enrollment = await createAgentEnrollment(db, { organizationId: orgId });
    const res = await enroll(
      post("enroll", { enrollmentToken: enrollment.token, name: "coder-1", version: "0.1.0" }),
    );
    expect(res.status).toBe(200);
    return (await res.json()) as { agentId: string; refreshToken: string };
  }

  async function refresh(refreshToken: string): Promise<Response> {
    return token(post("token", { refreshToken }));
  }

  async function refreshed(refreshToken: string): Promise<Tokens> {
    const res = await refresh(refreshToken);
    expect(res.status).toBe(200);
    return (await res.json()) as Tokens;
  }

  async function agentRow(agentId: string) {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    return agent!;
  }

  it("rotates in Redis without touching Postgres", async () => {
    const { agentId, refreshToken } = await enrollNew();
    // The first refresh caches the agent's auth state.
    let tokens = await refreshed(refreshToken);

    state.db = noPostgres;
    for (let i = 0; i < 3; i++) tokens = await refreshed(tokens.refreshToken);
    expect(await requireAgent(authed(tokens.accessToken))).toEqual({ agentId });
    state.db = db;

    expect(decodeJwt(tokens.refreshToken)).toMatchObject({ gen: 5 });
    // Postgres still has the enrollment's generation and no audit rows: both wait for the flush.
    expect((await agentRow(agentId)).refreshGeneration).toBe(1);
    expect(await listAgentAudit(db, { agentId, event: "token_refresh" })).toEqual([]);
  });

  it("revokes the agent when an older token is presented", async () => {
    const { agentId, refreshToken } = await enrollNew();
    const tokens = await refreshed(refreshToken);

    const reuse = await refresh(refreshToken);
    expect(reuse.status).toBe(401);
    expect(await reuse.json()).toEqual({ error: "refresh_token_reused" });
    expect((await agentRow(agentId)).revokedAt).not.toBeNull();
    expect(await listAgentAudit(db, { agentId, event: "refresh_reuse" })).toHaveLength(1);

    // The revocation is cached: the newer tokens stop working at once.
    expect((await refresh(tokens.refreshToken)).status).toBe(401);
    expect(await requireAgent(authed(tokens.accessToken))).toBeInstanceOf(Response);
  });

  it("revokes the agent when another token of the current generation is presented", async () => {
    const { agentId, refreshToken } = await enrollNew();
    const tokens = await refreshed(refreshToken);
    // Signed by us, with Redis's generation but not the random ID it holds.
    const copy = await getTokenSigner().signRefreshToken({ agentId, generation: 2, tokenId: "x" });
    expect(await (await refresh(copy)).json()).toEqual({ error: "refresh_token_reused" });
    expect((await agentRow(agentId)).revokedAt).not.toBeNull();
    expect((await refresh(tokens.refreshToken)).status).toBe(401);
  });

  it("treats concurrent presentations of one token as reuse", async () => {
    const { agentId, refreshToken } = await enrollNew();
    const statuses = await Promise.all([refresh(refreshToken), refresh(refreshToken)]).then((r) =>
      r.map((res) => res.status).sort(),
    );
    expect(statuses).toEqual([200, 401]);
    expect((await agentRow(agentId)).revokedAt).not.toBeNull();
  });

  it("flushes generations and buffered audit rows once a day", async () => {
    // Drain what earlier tests buffered.
    await flushRoute(cronRequest());
    const { agentId, refreshToken } = await enrollNew();
    const first = await refreshed(refreshToken);
    const second = await refreshed(first.refreshToken);

    const res = await flushRoute(cronRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ generations: 1, audits: 2 });
    expect((await agentRow(agentId)).refreshGeneration).toBe(3);
    const audit = await listAgentAudit(db, { agentId, event: "token_refresh" });
    expect(audit.map((a) => a.detail)).toEqual([{ generation: 1 }, { generation: 2 }]);
    expect(audit[0]!.ip).toMatch(/^198\.51\.100\./);
    expect(await getRedis().llen(REFRESH_AUDIT_KEY)).toBe(0);

    expect(await getRedis().scard(REFRESH_CHANGED_KEY)).toBe(0);

    // Nothing new: Postgres isn't touched.
    state.db = noPostgres;
    try {
      expect(await (await flushRoute(cronRequest())).json()).toEqual({
        generations: 0,
        audits: 0,
      });
    } finally {
      state.db = db;
    }
    // The flushed token keeps working.
    await refreshed(second.refreshToken);
  });

  it("leaves the buffer to a flush already running", async () => {
    await flushRoute(cronRequest());
    const { agentId, refreshToken } = await enrollNew();
    await refreshed(refreshToken);
    await getRedis().set("agent-refresh:flush-lock", "another flush", "PX", 60_000);
    try {
      expect(await (await flushRoute(cronRequest())).json()).toEqual({
        generations: 0,
        audits: 0,
      });
      expect(await getRedis().llen(REFRESH_AUDIT_KEY)).toBe(1);
    } finally {
      await getRedis().del("agent-refresh:flush-lock");
    }
    expect(await (await flushRoute(cronRequest())).json()).toEqual({ generations: 1, audits: 1 });
    expect((await agentRow(agentId)).refreshGeneration).toBe(2);
  });

  it("rejects the flush without the cron secret", async () => {
    const res = await flushRoute(new Request("http://localhost/api/cron/flush-agent-auth"));
    expect(res.status).toBe(401);
  });

  it("keeps Redis's newer generations through a rebuild", async () => {
    const { agentId, refreshToken } = await enrollNew();
    const older = (await refreshed(refreshToken)).refreshToken;
    await refreshed(older);
    // Another writer's failure forces a rebuild; Postgres still has generation 1, but the
    // rebuild doesn't lower Redis's generation 3: the generation-2 token is still reuse.
    await getRedis().del(EPOCH_KEY);
    expect((await refresh(older)).status).toBe(401);
    expect((await agentRow(agentId)).revokedAt).not.toBeNull();
  });

  it("records a rotation that fell back to Postgres during a rebuild", async () => {
    const { agentId, refreshToken } = await enrollNew();
    // Another instance is rebuilding: this refresh rotates in Postgres.
    await getRedis().del(EPOCH_KEY);
    await getRedis().set(REBUILD_LOCK_KEY, "another instance", "PX", 30_000);
    let tokens: Tokens;
    try {
      tokens = await refreshed(refreshToken);
    } finally {
      // The rebuild finishes, having read Postgres before the rotation committed.
      await getRedis().set(EPOCH_KEY, new Date().toISOString());
      await getRedis().del(REBUILD_LOCK_KEY);
    }
    expect((await agentRow(agentId)).refreshGeneration).toBe(2);

    // Redis has the rotated token: a copy of the old one is reuse, not accepted once.
    expect(await (await refresh(refreshToken)).json()).toEqual({ error: "refresh_token_reused" });
    expect((await agentRow(agentId)).revokedAt).not.toBeNull();
    expect((await refresh(tokens.refreshToken)).status).toBe(401);
  });

  it("lets the agent retry when the script's reply is lost and Postgres fails too", async () => {
    const { agentId, refreshToken } = await enrollNew();
    const redis = getRedis();
    const evalScript = redis.eval.bind(redis);
    // The rotate script (four keys) runs, but its reply never arrives.
    const lostReply = vi.spyOn(redis, "eval").mockImplementation((async (
      ...args: Parameters<typeof redis.eval>
    ) => {
      const reply = await evalScript(...args);
      if (args[1] === 4) throw new Error("connection reset");
      return reply;
    }) as typeof redis.eval);
    state.db = new Proxy(db, {
      get(target, property) {
        if (property === "transaction") return () => Promise.reject(new Error("Postgres down"));
        return Reflect.get(target, property) as unknown;
      },
    });
    try {
      await expect(refresh(refreshToken)).rejects.toThrow("Postgres down");
    } finally {
      lostReply.mockRestore();
      state.db = db;
    }

    // The client never got the next token and retries with its own: not reuse.
    const tokens = await refreshed(refreshToken);
    expect(decodeJwt(tokens.refreshToken)).toMatchObject({ gen: 2 });
    expect((await agentRow(agentId)).revokedAt).toBeNull();
  });

  describe("re-enrolling a revoked agent in place", () => {
    async function reenroll(agentId: string): Promise<{ refreshToken: string }> {
      const enrollment = await createAgentReenrollment(db, { organizationId: orgId, agentId });
      const res = await enroll(
        post("enroll", { enrollmentToken: enrollment!.token, name: "coder-1", version: "0.2.0" }),
      );
      expect(res.status).toBe(200);
      return (await res.json()) as { refreshToken: string };
    }

    it("starts the new family past Redis's generation; older tokens are stale, not reuse", async () => {
      const { agentId, refreshToken } = await enrollNew();
      // Generation 4 in Redis; Postgres still has 1 (no flush yet).
      let tokens = await refreshed(refreshToken);
      for (let i = 0; i < 2; i++) tokens = await refreshed(tokens.refreshToken);
      expect(await (await refresh(refreshToken)).json()).toEqual({
        error: "refresh_token_reused",
      });
      expect((await agentRow(agentId)).revokedAt).not.toBeNull();

      const { refreshToken: fresh } = await reenroll(agentId);
      expect(decodeJwt(fresh)).toMatchObject({ gen: 4 + REENROLL_GENERATION_GAP });
      // The cached `revoked` is gone: the new tokens work at once, in Redis.
      const next = await refreshed(fresh);
      expect(await requireAgent(authed(next.accessToken))).toEqual({ agentId });

      // Every earlier token is rejected without revoking the agent again.
      for (const old of [refreshToken, tokens.refreshToken]) {
        expect((await refresh(old)).status).toBe(401);
      }
      expect((await agentRow(agentId)).revokedAt).toBeNull();

      // Still after Redis loses its state: the family comes back from Postgres.
      await getRedis().flushall();
      expect((await refresh(tokens.refreshToken)).status).toBe(401);
      expect((await agentRow(agentId)).revokedAt).toBeNull();
      await refreshed(next.refreshToken);
    });
  });

  describe("after Redis loses its state", () => {
    it("accepts the agent's newer token once and catches up", async () => {
      const { agentId, refreshToken } = await enrollNew();
      const current = await refreshed(await refreshed(refreshToken).then((t) => t.refreshToken));
      await getRedis().flushall();

      // Rebuilt from Postgres (generation 1): the agent's generation-3 token is newer.
      const next = await refreshed(current.refreshToken);
      expect(decodeJwt(next.refreshToken)).toMatchObject({ gen: 4 });
      await refreshed(next.refreshToken);
      expect((await agentRow(agentId)).revokedAt).toBeNull();
    });

    it("stops a thief and the agent both refreshing from one token", async () => {
      const { agentId, refreshToken } = await enrollNew();
      const stolen = (await refreshed(refreshToken)).refreshToken;
      await getRedis().flushall();

      // The thief refreshes first: its token is newer than Postgres's generation.
      await refreshed(stolen);
      // The agent's copy is now behind: reuse.
      expect((await refresh(stolen)).status).toBe(401);
      expect((await agentRow(agentId)).revokedAt).not.toBeNull();
    });
  });

  it("rotates in Postgres with Redis down, and Redis catches up after", async () => {
    const { agentId, refreshToken } = await enrollNew();
    const inRedis = await refreshed(refreshToken);

    await closeRedis();
    vi.stubEnv("REDIS_URL", "redis://127.0.0.1:1");
    let tokens: Tokens;
    try {
      // Postgres is a generation behind Redis: the agent's token is newer and accepted.
      tokens = await refreshed(inRedis.refreshToken);
    } finally {
      await closeRedis();
      vi.stubEnv("REDIS_URL", testRedis.url);
    }
    expect((await agentRow(agentId)).refreshGeneration).toBe(3);
    // Written straight to Postgres.
    expect(await listAgentAudit(db, { agentId, event: "token_refresh" })).toHaveLength(1);

    // Back on Redis, whose generation (2) is behind the agent's.
    await refreshed(tokens.refreshToken);
    expect((await agentRow(agentId)).revokedAt).toBeNull();
  }, 60_000);
});

function authed(accessToken: string): Request {
  return new Request("http://localhost/api/agent/heartbeat", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "x-real-ip": newIp() },
  });
}
