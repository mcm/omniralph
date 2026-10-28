import {
  captureChanges,
  closeDb,
  createDb,
  agents,
  insertJob,
  jobs,
  organizations,
  triageRuns,
  type Database,
} from "@omniralph/db";
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

const { agentLiveKey, noteAgentOnline, sweepAgentLiveness } = await import("./liveness");
const { AGENT_ONLINE_WINDOW_MS } = await import("./display");
const { agentLastSeenKey } = await import("./last-seen");
const { closeRedis, getRedis } = await import("@/lib/hot-state");
const { GET: livenessCron } = await import("@/app/api/cron/agent-liveness/route");

const databaseAvailable = testDatabaseAvailable();
const redisAvailable = await testRedisAvailable();

describe.skipIf(!databaseAvailable || !redisAvailable)("agent liveness", () => {
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

  async function newAgent(lastHeartbeatAt: Date | null = new Date()): Promise<string> {
    await db.update(agents).set({ liveOnline: false });
    const [agent] = await db
      .insert(agents)
      .values({ organizationId: orgId, name: "host", lastHeartbeatAt })
      .returning();
    return agent!.id;
  }

  const liveOnline = async (id: string) =>
    (await db.select().from(agents).where(eq(agents.id, id)))[0]!.liveOnline;

  const agentEvents = (changes: { resource: string; ids: string[] }[]) =>
    changes.filter((c) => c.resource === "agent").flatMap((c) => c.ids);

  for (const hotState of [false, true]) {
    describe(hotState ? "with Redis" : "without Redis", () => {
      beforeEach(async () => {
        vi.stubEnv("REDIS_URL", hotState ? testRedis.url : "");
        await closeRedis();
        if (hotState) await getRedis().flushdb();
      });

      it("publishes an agent event when a heartbeat brings it online, once", async () => {
        const id = await newAgent();
        const first = await captureChanges(() => noteAgentOnline(db, id));
        expect(first.changes).toEqual([
          expect.objectContaining({ resource: "agent", ids: [id], organizationId: orgId }),
        ]);
        expect(await liveOnline(id)).toBe(true);
        // Steady heartbeats publish nothing.
        for (let i = 0; i < 3; i++) {
          expect((await captureChanges(() => noteAgentOnline(db, id))).changes).toEqual([]);
        }
        if (hotState) expect(await getRedis().get(agentLiveKey(id))).toBe("1");
      });

      it("publishes an agent event when its heartbeats stop, and again when they resume", async () => {
        const now = new Date();
        const id = await newAgent(new Date(now.getTime() - AGENT_ONLINE_WINDOW_MS - 1_000));
        await noteAgentOnline(db, id);
        const fresh = await newAgentKeepingOthers(new Date(now.getTime() - 5_000));
        await noteAgentOnline(db, fresh);

        const swept = await captureChanges(() => sweepAgentLiveness(db, now));
        expect(swept.result).toEqual([id]);
        expect(agentEvents(swept.changes)).toEqual([id]);
        expect(await liveOnline(id)).toBe(false);
        expect(await liveOnline(fresh)).toBe(true);
        if (hotState) expect(await getRedis().get(agentLiveKey(id))).toBeNull();
        // Already offline: the next sweep publishes nothing.
        expect((await captureChanges(() => sweepAgentLiveness(db, now))).changes).toEqual([]);
        // Its next heartbeat brings it online again.
        expect(agentEvents((await captureChanges(() => noteAgentOnline(db, id))).changes)).toEqual([
          id,
        ]);
      });

      it("reads a recent heartbeat from Redis's last-seen over the row's", async () => {
        const now = new Date();
        const id = await newAgent(new Date(now.getTime() - 24 * 3600_000));
        await noteAgentOnline(db, id);
        if (hotState) {
          await getRedis().set(agentLastSeenKey(id), String(now.getTime() - 5_000));
          expect(await sweepAgentLiveness(db, now)).toEqual([]);
          expect(await liveOnline(id)).toBe(true);
        } else {
          expect(await sweepAgentLiveness(db, now)).toEqual([id]);
        }
      });

      it("never announces a revoked agent online", async () => {
        const id = await newAgent();
        await db.update(agents).set({ revokedAt: new Date() }).where(eq(agents.id, id));
        expect((await captureChanges(() => noteAgentOnline(db, id))).changes).toEqual([]);
        expect(await liveOnline(id)).toBe(false);
      });
    });
  }

  async function newAgentKeepingOthers(lastHeartbeatAt: Date): Promise<string> {
    const [agent] = await db
      .insert(agents)
      .values({ organizationId: orgId, name: "other", lastHeartbeatAt })
      .returning();
    return agent!.id;
  }

  describe("the agent-liveness cron", () => {
    it("requires the cron secret", async () => {
      const response = await livenessCron(new Request("http://localhost/api/cron/agent-liveness"));
      expect(response.status).toBe(401);
    });

    it("announces stale agents offline", async () => {
      vi.stubEnv("REDIS_URL", "");
      await closeRedis();
      const id = await newAgent(new Date(Date.now() - AGENT_ONLINE_WINDOW_MS - 1_000));
      await noteAgentOnline(db, id);
      const response = await livenessCron(
        new Request("http://localhost/api/cron/agent-liveness", {
          headers: { authorization: "Bearer cron-secret" },
        }),
      );
      expect(await response.json()).toEqual({ offline: 1, waits: 0 });
      expect(await liveOnline(id)).toBe(false);
    });

    it("sets what a queued run waits for once the only agent with its host tool goes offline", async () => {
      vi.stubEnv("REDIS_URL", "");
      await closeRedis();
      const [org] = await db.insert(organizations).values({ name: "Initech" }).returning();
      const [agent] = await db
        .insert(agents)
        .values({
          organizationId: org!.id,
          name: "gh-box",
          lastHeartbeatAt: new Date(Date.now() - AGENT_ONLINE_WINDOW_MS - 1_000),
          reportedHostTools: [
            { name: "gh", path: "/usr/bin/gh", source: "discovered", problem: null },
          ],
        })
        .returning();
      await noteAgentOnline(db, agent!.id);
      const [triage] = await db
        .insert(triageRuns)
        .values({
          organizationId: org!.id,
          linearIssueId: "triage-gh",
          linearAgentSessionId: "triage-gh-session",
          trigger: "label",
          status: "queued",
        })
        .returning();
      const { job } = await insertJob(db, {
        organizationId: org!.id,
        type: "triage.run",
        taskType: "query",
        triageRunId: triage!.id,
        requiredHostTools: ["gh"],
      });
      expect(job.waitingReason).toBeNull();
      const cron = () =>
        captureChanges(async () => {
          const response = await livenessCron(
            new Request("http://localhost/api/cron/agent-liveness", {
              headers: { authorization: "Bearer cron-secret" },
            }),
          );
          return response.json();
        });
      const runEvents = (changes: { resource: string; ids: string[] }[]) =>
        changes.filter((c) => c.resource === "run" && c.ids.includes(job.id));

      const swept = await cron();
      expect(swept.result).toEqual({ offline: 1, waits: 1 });
      expect(runEvents(swept.changes)).toEqual([
        expect.objectContaining({ resource: "run", ids: [job.id], runId: triage!.id }),
      ]);
      const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
      expect(row!.waitingReason).toEqual({ code: "host_tools_missing", hostTools: ["gh"] });
      // Unchanged on the next sweep: nothing published.
      const again = await cron();
      expect(again.result).toEqual({ offline: 0, waits: 0 });
      expect(runEvents(again.changes)).toEqual([]);
    });
  });
});
