import { generateKeyPairSync, randomBytes } from "node:crypto";
import {
  closeDb,
  connectRepository,
  createDb,
  agentRepoPins,
  agents,
  organizations,
  pinnedAgentFor,
  upsertScmConnection,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRole, type Role } from "@/lib/auth/roles";
import { startTestRedis, testRedisAvailable, type TestRedis } from "@/lib/hot-state/testing";

/** A heartbeat's `local`: the agent's machine settings, all defaults. */
const LOCAL = {
  maxConcurrency: 5,
  poolLimits: { short: 5, long: 4 },
  versionPin: null,
  installablesAllow: ["@omniralph/*"],
};

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ db: undefined as unknown as Database, orgId: "" }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") =>
    assertRole(
      {
        id: "user-1",
        role: "admin",
        name: null,
        email: null,
        image: null,
        organization: { id: state.orgId, name: "Acme" },
      },
      role,
    ),
}));
vi.mock("@/lib/agents/npm", () => ({
  NpmRegistryError: class extends Error {},
  latestAgentVersion: async () => "2.0.0",
}));

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
delete process.env.KMS_AGENT_ISSUER_ID;
process.env.LOCAL_AGENT_SIGNING_KEY = privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const {
  POSTGRES_HEARTBEAT_MAX_AGE_MS,
  agentLastSeenKey,
  agentReportKey,
  readAgentLastSeen,
  recordHeartbeat,
  withLastSeen,
} = await import("./last-seen");
const { closeRedis, getRedis } = await import("@/lib/hot-state");
const { POST: heartbeat } = await import("@/app/api/agent/heartbeat/route");
const { GET: listAgents } = await import("@/app/api/ui/agents/route");
const { getTokenSigner } = await import("@/lib/agent-auth/signer");

const REPORT = { version: "1.4.0", selfUpdate: "supported" as const, failedVersions: [] };

const databaseAvailable = testDatabaseAvailable();
const redisAvailable = await testRedisAvailable();

describe.skipIf(!databaseAvailable || !redisAvailable)("agent last-seen", () => {
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
    state.orgId = orgId;
  }, 180_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await closeRedis();
    if (db) await closeDb(db);
    await Promise.all([testDb?.stop(), testRedis?.stop()]);
  });

  async function newAgent(lastHeartbeatAt: Date | null = null): Promise<string> {
    const [agent] = await db
      .insert(agents)
      .values({ organizationId: orgId, name: "coder-1", lastHeartbeatAt })
      .returning();
    return agent!.id;
  }

  async function row(agentId: string) {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    return agent!;
  }

  const at = (seconds: number) => new Date(Date.UTC(2026, 9, 16, 12, 0, seconds));

  describe("with Redis", () => {
    beforeEach(async () => {
      vi.stubEnv("REDIS_URL", testRedis.url);
      await closeRedis();
      await getRedis().flushdb();
    });

    it("writes the row once, then only last-seen while the report is unchanged", async () => {
      const agentId = await newAgent();
      await recordHeartbeat(db, agentId, REPORT, at(0));
      expect((await row(agentId)).lastHeartbeatAt).toEqual(at(0));
      const pttl = await getRedis().pttl(agentReportKey(agentId));
      expect(pttl).toBeGreaterThan(POSTGRES_HEARTBEAT_MAX_AGE_MS - 60_000);
      expect(pttl).toBeLessThanOrEqual(POSTGRES_HEARTBEAT_MAX_AGE_MS);

      const before = await row(agentId);
      const returned = await recordHeartbeat(db, agentId, REPORT, at(20));
      // No write: neither the heartbeat time nor `updated_at` moved.
      expect(await row(agentId)).toEqual(before);
      expect(returned).toEqual(before);
      expect(await getRedis().get(agentLastSeenKey(agentId))).toBe(String(at(20).getTime()));
      expect((await readAgentLastSeen([agentId])).get(agentId)).toEqual(at(20));
    });

    it.each([
      ["version", { version: "1.5.0" }],
      ["self-update support", { selfUpdate: "unsupported" as const }],
      [
        "update state",
        {
          update: {
            state: "installing" as const,
            version: "1.5.0",
            previous: "1.4.0",
            startsSincePending: 0,
            error: null,
          },
        },
      ],
      ["failed versions", { failedVersions: ["1.5.0"] }],
      ["installables", { installables: [{ name: "gh", version: "2.0.0" }] }],
      ["models", { models: [{ value: "opus", displayName: "Opus" }] }],
      ["version pin", { local: { ...LOCAL, versionPin: "2.0.3" } }],
      ["slots", { local: { ...LOCAL, maxConcurrency: 3, poolLimits: { short: 3, long: 2 } } }],
      ["allow-list", { local: { ...LOCAL, installablesAllow: [] } }],
      [
        "host tools",
        {
          hostTools: [
            { name: "gh", path: "/usr/bin/gh", source: "discovered" as const, problem: null },
          ],
        },
      ],
      [
        "Claude login",
        {
          claude: {
            status: "signed_out" as const,
            source: null,
            checkedAt: "2026-10-01T09:00:00.000Z",
          },
        },
      ],
      ["host", { host: { hostname: "coder-ws-1", coder: { owner: "steve", workspace: "w" } } }],
    ])("writes the row when the %s changed", async (_name, change) => {
      const agentId = await newAgent();
      await recordHeartbeat(db, agentId, REPORT, at(0));
      await recordHeartbeat(db, agentId, { ...REPORT, ...change }, at(20));
      expect((await row(agentId)).lastHeartbeatAt).toEqual(at(20));
      // And the new report is the one an unchanged heartbeat is compared with.
      await recordHeartbeat(db, agentId, { ...REPORT, ...change }, at(40));
      expect((await row(agentId)).lastHeartbeatAt).toEqual(at(20));
    });

    it("writes the row again once the stored report expired (a day without a write)", async () => {
      const agentId = await newAgent();
      await recordHeartbeat(db, agentId, REPORT, at(0));
      await getRedis().del(agentReportKey(agentId));
      await recordHeartbeat(db, agentId, REPORT, at(20));
      expect((await row(agentId)).lastHeartbeatAt).toEqual(at(20));
    });

    it("answers the heartbeat route without writing the row for an unchanged report", async () => {
      const agentId = await newAgent();
      const send = async () => {
        const token = await getTokenSigner().signAccessToken(agentId);
        const response = await heartbeat(
          new Request("http://localhost/api/agent/heartbeat", {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              "x-real-ip": "203.0.113.9",
            },
            body: JSON.stringify({
              version: "1.4.0",
              runningJobIds: [],
              freeSlots: 1,
              local: LOCAL,
            }),
          }),
        );
        expect(response.status).toBe(200);
        return (await response.json()) as { organizationId: string };
      };
      expect((await send()).organizationId).toBe(orgId);
      const first = await row(agentId);
      expect(first.lastHeartbeatAt).not.toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect((await send()).organizationId).toBe(orgId);
      expect(await row(agentId)).toEqual(first);
      const seen = (await readAgentLastSeen([agentId])).get(agentId);
      expect(seen!.getTime()).toBeGreaterThan(first.lastHeartbeatAt!.getTime());
    });

    it("has readers prefer the Redis last-seen when it's later", async () => {
      const stale = new Date(Date.now() - 3600_000);
      const agentId = await newAgent(stale);
      const fresh = new Date();
      await getRedis().set(agentLastSeenKey(agentId), String(fresh.getTime()));
      const other = await newAgent(fresh);
      await getRedis().set(agentLastSeenKey(other), String(stale.getTime()));

      const [a, b] = await withLastSeen([
        { id: agentId, lastHeartbeatAt: stale },
        { id: other, lastHeartbeatAt: fresh },
      ]);
      expect(a!.lastHeartbeatAt).toEqual(fresh);
      // The row's own value wins when it's later (written while Redis was down).
      expect(b!.lastHeartbeatAt).toEqual(fresh);

      const list = (await (
        await listAgents(new Request("http://localhost/api/ui/agents"), {
          params: Promise.resolve({}),
        })
      ).json()) as { agents: { id: string; online: boolean; lastHeartbeatAt: string }[] };
      const listed = list.agents.find((h) => h.id === agentId)!;
      expect(listed.lastHeartbeatAt).toBe(fresh.toISOString());
      // Online is the server's `live_online` flag (the heartbeat route sets it), not a fresh time.
      expect(listed.online).toBe(false);
    });

    it("breaks pinnedAgentFor's tie on the Redis last-seen", async () => {
      const connection = (await upsertScmConnection(db, {
        organizationId: orgId,
        provider: "gitlab",
        name: "bot",
        baseUrl: "https://gitlab.example.com",
        externalId: "5",
        credentials: { token: "glpat-bot", webhookSecret: "hook" },
      }))!;
      const repositoryId = (
        await connectRepository(db, {
          connectionId: connection.id,
          provider: "gitlab",
          externalId: "101",
          fullPath: "acme/api",
        })
      ).id;
      const older = await newAgent(new Date(Date.now() - 60_000));
      const newer = await newAgent(new Date(Date.now() - 30_000));
      await db.insert(agentRepoPins).values([
        { agentId: older, repositoryId },
        { agentId: newer, repositoryId },
      ]);
      expect(await pinnedAgentFor(db, orgId, repositoryId)).toBe(newer);
      await getRedis().set(agentLastSeenKey(older), String(Date.now()));
      expect(
        await pinnedAgentFor(db, orgId, repositoryId, { lastHeartbeats: readAgentLastSeen }),
      ).toBe(older);
    });
  });

  describe("without Redis", () => {
    beforeEach(async () => {
      vi.stubEnv("REDIS_URL", "");
      await closeRedis();
    });

    it("writes the row on every heartbeat and reads only the row", async () => {
      const agentId = await newAgent();
      await recordHeartbeat(db, agentId, REPORT, at(0));
      await recordHeartbeat(db, agentId, REPORT, at(20));
      expect((await row(agentId)).lastHeartbeatAt).toEqual(at(20));
      expect(await readAgentLastSeen([agentId])).toEqual(new Map());
    });
  });

  describe("with Redis down", () => {
    beforeEach(async () => {
      vi.stubEnv("REDIS_URL", "redis://127.0.0.1:1");
      await closeRedis();
    });

    it("falls back to writing the row on every heartbeat", async () => {
      const agentId = await newAgent();
      await recordHeartbeat(db, agentId, REPORT, at(0));
      await recordHeartbeat(db, agentId, REPORT, at(20));
      expect((await row(agentId)).lastHeartbeatAt).toEqual(at(20));
      expect(await readAgentLastSeen([agentId])).toEqual(new Map());
    });
  });
});
