import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import {
  LATEST_AGENT_VERSION_KEY,
  agentRepoPins,
  appSettings,
  chatConnections,
  chatThreadRuns,
  chatThreads,
  closeDb,
  connectRepository,
  createDb,
  getRepository,
  agents,
  jobs,
  organizations,
  ralphRuns,
  upsertScmConnection,
  users,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import type { HeartbeatResponse } from "@omniralph/shared";
import { getBuiltinPlaybook } from "@omniralph/tasks";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgUser } from "@/lib/auth/session";
import { startTestRedis, testRedisAvailable, type TestRedis } from "@/lib/hot-state/testing";

vi.mock("server-only", () => ({}));
// The card saves reach the API handler, which imports next-auth; nothing here signs in.
vi.mock("@/lib/auth/session", () => ({}));
const state = vi.hoisted(() => ({ db: undefined as unknown as Database, latest: "2.0.0" }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/agents/npm", () => ({
  NpmRegistryError: class extends Error {},
  latestAgentVersion: async () => state.latest,
}));

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
delete process.env.KMS_AGENT_ISSUER_ID;
process.env.LOCAL_AGENT_SIGNING_KEY = privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const { EPOCH_KEY, closeRedis, getRedis } = await import("@/lib/hot-state");
const { POST: heartbeat } = await import("@/app/api/agent/heartbeat/route");
const { getTokenSigner } = await import("@/lib/agent-auth/signer");
const { PostgresDispatcher } = await import("@/lib/dispatch/dispatcher");
const { jobDueKey } = await import("@/lib/dispatch/due");
const {
  CACHED_RESPONSE_KEEP_MS,
  agentChangesKey,
  bumpAgentHeartbeat,
  bumpOrganizationHeartbeat,
  cachedResponseDueAt,
  checkHeartbeatDrift,
  heartbeatResponseKey,
  latestVersionKey,
  organizationChangesKey,
} = await import("./heartbeat-cache");
const { currentDailyWindow } = await import("@/lib/daily-window");
const { agentOrganizationKey } = await import("./organization");
const { agentReportKey } = await import("./last-seen");
const defaults = await import("./defaults");
const { pinRepository } = await import("./pins");
const { saveAgentsCard } = await import("@/lib/repositories/cards");
const { sendToChatRun } = await import("@/lib/ralph/chat-reply");
const playbookManage = await import("@/lib/playbooks/manage");

const databaseAvailable = testDatabaseAvailable();
const redisAvailable = await testRedisAvailable();

const LOCAL = {
  maxConcurrency: 5,
  poolLimits: { short: 5, long: 4 },
  versionPin: null,
  installablesAllow: ["@omniralph/*"],
};
const IDLE = {
  version: "1.4.0",
  selfUpdate: "supported",
  runningJobIds: [],
  freeSlots: 1,
  local: LOCAL,
};

let ipCounter = 0;

describe.skipIf(!databaseAvailable || !redisAvailable)("heartbeat answered from Redis", () => {
  let testDb: TestDatabase;
  let testRedis: TestRedis;
  let db: Database;
  /** Postgres calls made through `state.db` (the routes' `getDb()`). */
  let postgresCalls = 0;
  let userId: string;

  beforeAll(async () => {
    [testDb, testRedis] = await Promise.all([createTestDatabase(), startTestRedis()]);
    db = createDb(testDb.uri);
    const queryMethods = new Set([
      "select",
      "selectDistinct",
      "insert",
      "update",
      "delete",
      "execute",
      "transaction",
      "query",
    ]);
    state.db = new Proxy(db, {
      get(target, property, receiver) {
        if (typeof property === "string" && queryMethods.has(property)) postgresCalls += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const [user] = await db.insert(users).values({ name: "Ada" }).returning();
    userId = user!.id;
  }, 180_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await closeRedis();
    if (db) await closeDb(db);
    await Promise.all([testDb?.stop(), testRedis?.stop()]);
  });

  beforeEach(async () => {
    vi.stubEnv("REDIS_URL", testRedis.url);
    await closeRedis();
    await getRedis().flushdb();
    state.latest = "2.0.0";
  });

  /** An agent of a fresh organization (organization settings don't leak between tests). */
  async function newAgent(): Promise<{ agentId: string; orgId: string }> {
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    const [agent] = await db
      .insert(agents)
      .values({ organizationId: org!.id, name: "coder-1" })
      .returning();
    return { agentId: agent!.id, orgId: org!.id };
  }

  /** Sends a heartbeat; returns its response and the Postgres calls it made. */
  async function send(
    agentId: string,
    body: Record<string, unknown> = {},
  ): Promise<{ response: HeartbeatResponse; calls: number }> {
    const token = await getTokenSigner().signAccessToken(agentId);
    ipCounter += 1;
    const before = postgresCalls;
    const response = await heartbeat(
      new Request("http://localhost/api/agent/heartbeat", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-real-ip": `198.51.100.${ipCounter % 250}`,
        },
        body: JSON.stringify({ ...IDLE, ...body }),
      }),
    );
    expect(response.status).toBe(200);
    return {
      response: (await response.json()) as HeartbeatResponse,
      calls: postgresCalls - before,
    };
  }

  /** Two idle heartbeats: the second is answered from Redis. */
  async function warm(agentId: string): Promise<HeartbeatResponse> {
    const first = await send(agentId);
    expect(first.calls).toBeGreaterThan(0);
    const second = await send(agentId);
    expect(second.calls).toBe(0);
    expect(second.response).toEqual(first.response);
    return second.response;
  }

  const admin = (orgId: string) => ({ id: userId, organization: { id: orgId } });
  /** An admin of `orgId` as the playbook handlers get them. */
  const orgAdmin = (orgId: string) =>
    ({
      id: userId,
      name: "Ada",
      email: null,
      image: null,
      theme: null,
      showAdvanced: false,
      role: "admin",
      organization: { id: orgId, name: "Acme" },
    }) as unknown as OrgUser;
  /** A custom chat-ask playbook requiring `hostTools`. */
  const playbookInput = (hostTools: string[]) => {
    const { id: _id, ...fields } = getBuiltinPlaybook("builtin:ask-about-code")!;
    return { ...fields, name: "Security review", requires: { hostTools } };
  };
  /** The playbook `setUp` created, by organization. */
  const playbookIds = new Map<string, string>();

  async function newRepository(orgId: string): Promise<string> {
    const connection = (await upsertScmConnection(db, {
      organizationId: orgId,
      provider: "gitlab",
      name: "bot",
      baseUrl: "https://gitlab.example.com",
      externalId: randomUUID(),
      credentials: { token: "glpat-bot", webhookSecret: "hook" },
    }))!;
    const repo = await connectRepository(db, {
      connectionId: connection.id,
      provider: "gitlab",
      externalId: randomUUID(),
      fullPath: "acme/api",
    });
    return repo.id;
  }

  async function runningJob(orgId: string, agentId: string, extra = {}): Promise<string> {
    const [job] = await db
      .insert(jobs)
      .values({
        organizationId: orgId,
        type: "test.job",
        taskType: "review",
        status: "running",
        agentId,
        startedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 30_000),
        ...extra,
      })
      .returning();
    return job!.id;
  }

  it("answers an unchanged idle heartbeat without a Postgres query", async () => {
    const { agentId } = await newAgent();
    const cached = await warm(agentId);
    expect(cached.pinnedRepositories).toEqual([]);
    // Last-seen still moves.
    const seen = Number(await getRedis().get(`agent-last-seen:${agentId}`));
    expect(Date.now() - seen).toBeLessThan(5_000);
    // `claimable` without a due job: false, still from Redis.
    const claimable = await send(agentId, { claimablePools: ["short"] });
    expect(claimable.calls).toBe(0);
    expect(claimable.response.claimable).toBe(false);
  });

  it("asks Postgres about claimablePools when the organization has a due job", async () => {
    const { agentId, orgId } = await newAgent();
    await warm(agentId);
    await getRedis().zadd(jobDueKey(orgId), Date.now() - 1000, randomUUID());
    const { response, calls } = await send(agentId, { claimablePools: ["short"] });
    expect(calls).toBeGreaterThan(0);
    expect(response.claimable).toBe(false);
  });

  it("takes the Postgres path when the agent's report changes", async () => {
    const { agentId } = await newAgent();
    await warm(agentId);
    expect((await send(agentId, { version: "1.5.0" })).calls).toBeGreaterThan(0);
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(row!.reportedVersion).toBe("1.5.0");
    expect((await send(agentId, { version: "1.5.0" })).calls).toBe(0);
    // A new local settings report is stored, then answered from Redis again.
    const local = { ...LOCAL, maxConcurrency: 2, poolLimits: { short: 2, long: 1 } };
    expect((await send(agentId, { version: "1.5.0", local })).calls).toBeGreaterThan(0);
    const [stored] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(stored).toMatchObject({
      reportedMaxConcurrency: 2,
      reportedPoolLimits: { short: 2, long: 1 },
      reportedVersionPin: null,
      reportedInstallablesAllow: ["@omniralph/*"],
    });
    const cached = await send(agentId, { version: "1.5.0", local });
    expect(cached.calls).toBe(0);
    // Its slots are its own: the response never carries any.
    expect(cached.response).not.toHaveProperty("maxConcurrency");
    expect(cached.response).not.toHaveProperty("poolLimits");
    // A new host tools report is stored too, then answered from Redis again.
    const tools = [{ name: "semgrep", path: "/bin/semgrep", source: "discovered", problem: null }];
    expect(
      (await send(agentId, { version: "1.5.0", local, hostTools: tools })).calls,
    ).toBeGreaterThan(0);
    const [withTools] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(withTools!.reportedHostTools).toEqual(tools);
    expect((await send(agentId, { version: "1.5.0", local, hostTools: tools })).calls).toBe(0);
    const blocked = [{ name: "semgrep", path: null, source: null, problem: "blocked" }];
    expect(
      (await send(agentId, { version: "1.5.0", local, hostTools: blocked })).calls,
    ).toBeGreaterThan(0);
  });

  it("takes the Postgres path while a token-refresh report starts, changes or clears", async () => {
    const { agentId } = await newAgent();
    await warm(agentId);
    const stored = async () =>
      (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!.reportedTokenRefresh;
    const tokenRefresh = {
      failingSince: new Date(Date.now() - 60_000).toISOString(),
      consecutiveFailures: 1,
      lastError: "network",
      accessTokenExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      refreshTokenExpiresAt: null,
    };
    expect((await send(agentId, { tokenRefresh })).calls).toBeGreaterThan(0);
    expect(await stored()).toEqual(tokenRefresh);
    expect((await send(agentId, { tokenRefresh })).calls).toBe(0);
    const again = { ...tokenRefresh, consecutiveFailures: 2, lastError: "http_502" };
    expect((await send(agentId, { tokenRefresh: again })).calls).toBeGreaterThan(0);
    expect(await stored()).toEqual(again);
    // The first healthy heartbeat clears it, then is answered from Redis again.
    expect((await send(agentId)).calls).toBeGreaterThan(0);
    expect(await stored()).toBeNull();
    expect((await send(agentId)).calls).toBe(0);
  });

  type Change = (ids: { agentId: string; orgId: string }) => Promise<void>;
  const changes: [string, Change, (response: HeartbeatResponse) => void][] = [
    [
      "pin",
      async ({ agentId, orgId }) => {
        const repositoryId = await newRepository(orgId);
        const dispatcher = new PostgresDispatcher({ db });
        expect((await pinRepository(db, dispatcher, { agentId, repositoryId })).result).toBe(
          "pinned",
        );
      },
      (response) =>
        expect(response.pinnedRepositories).toEqual([
          { id: expect.any(String), provider: "gitlab", fullPath: "acme/api" },
        ]),
    ],
    [
      "unpin",
      async ({ agentId }) => {
        // Pinned before the warm-up (`setUp`), unpinned here from the repo's Agents card.
        const [pinned] = (await send(agentId)).response.pinnedRepositories;
        const repository = (await getRepository(db, pinned!.id))!;
        const saved = await saveAgentsCard(
          db,
          new PostgresDispatcher({ db }),
          { userId: null, name: "Admin" },
          repository,
          { pinnedAgentIds: [] },
        );
        expect(saved).toMatchObject({ ok: true, card: { pinned: [] } });
      },
      (response) => expect(response.pinnedRepositories).toEqual([]),
    ],
    [
      "organization version",
      async ({ orgId }) => {
        await defaults.setGlobalAgentVersion(db, admin(orgId), "2.8.0");
      },
      (response) => {
        expect(response.desiredVersion).toBe("2.8.0");
        expect(response.versionPolicy).toBe("pinned");
      },
    ],
    [
      "playbook created",
      async ({ orgId }) => {
        const saved = await playbookManage.createPlaybook(
          db,
          orgAdmin(orgId),
          playbookInput(["opengrep"]),
        );
        expect(saved).toMatchObject({ ok: true });
      },
      (response) => expect(response.requiredHostTools).toEqual(["opengrep"]),
    ],
    [
      "playbook updated",
      async ({ orgId }) => {
        const saved = await playbookManage.updatePlaybook(
          db,
          orgAdmin(orgId),
          playbookIds.get(orgId)!,
          playbookInput(["opengrep", "gh"]),
        );
        expect(saved).toMatchObject({ ok: true });
      },
      (response) => expect(response.requiredHostTools).toEqual(["gh", "opengrep"]),
    ],
    [
      "playbook deleted",
      async ({ orgId }) => {
        expect(
          await playbookManage.deletePlaybook(db, orgAdmin(orgId), playbookIds.get(orgId)!),
        ).toEqual({ ok: true });
      },
      (response) => expect(response.requiredHostTools).toEqual([]),
    ],
  ];

  /** What a change needs in place before the warm-up. */
  async function setUp(name: string, ids: { agentId: string; orgId: string }): Promise<void> {
    if (name === "unpin") {
      const repositoryId = await newRepository(ids.orgId);
      await pinRepository(db, new PostgresDispatcher({ db }), { ...ids, repositoryId });
    }
    if (name === "playbook updated" || name === "playbook deleted") {
      const saved = await playbookManage.createPlaybook(
        db,
        orgAdmin(ids.orgId),
        playbookInput(["opengrep"]),
      );
      if (!("id" in saved)) throw new Error("setup");
      playbookIds.set(ids.orgId, saved.id);
    }
  }

  it.each(changes)("a %s change invalidates the cached response", async (name, change, check) => {
    const ids = await newAgent();
    await setUp(name, ids);
    const before = await warm(ids.agentId);
    await change(ids);
    const after = await send(ids.agentId);
    expect(after.calls).toBeGreaterThan(0);
    expect(after.response).not.toEqual(before);
    check(after.response);
    // Cached again from then on.
    const again = await send(ids.agentId);
    expect(again.calls).toBe(0);
    expect(again.response).toEqual(after.response);
  });

  it("a cancel request invalidates the cached response", async () => {
    const { agentId, orgId } = await newAgent();
    await warm(agentId);
    const jobId = await runningJob(orgId, agentId);
    expect(await new PostgresDispatcher({ db }).cancel(jobId)).toBe("cancel_requested");
    expect((await send(agentId)).calls).toBeGreaterThan(0);
  });

  it("a job message invalidates the cached response", async () => {
    const { agentId, orgId } = await newAgent();
    const [connection] = await db
      .insert(chatConnections)
      .values({ organizationId: orgId, platform: "discord", externalId: randomUUID(), name: "G" })
      .returning();
    const [thread] = await db
      .insert(chatThreads)
      .values({
        organizationId: orgId,
        connectionId: connection!.id,
        platform: "discord",
        externalThreadId: randomUUID(),
        channelId: "CH1",
        startedByExternalUserId: "U1",
      })
      .returning();
    const [run] = await db
      .insert(ralphRuns)
      .values({
        organizationId: orgId,
        origin: "chat",
        chatThreadId: thread!.id,
        kind: "single",
        mode: "request",
        status: "running",
      })
      .returning();
    await db.insert(chatThreadRuns).values({
      organizationId: orgId,
      chatThreadId: thread!.id,
      kind: "coding",
      ralphRunId: run!.id,
    });
    await runningJob(orgId, agentId, { type: "ralph.request", ralphRunId: run!.id });
    await warm(agentId);
    const deps = { db, organizationId: orgId } as Parameters<typeof sendToChatRun>[0];
    expect(
      await sendToChatRun(deps, { chatThreadId: thread!.id, text: "Use tabs.", author: null }),
    ).toMatchObject({ status: "live" });
    expect((await send(agentId)).calls).toBeGreaterThan(0);
  });

  it("follows npm's latest from Redis, and a new latest invalidates the cached response", async () => {
    const { agentId, orgId } = await newAgent();
    await defaults.setGlobalAgentVersion(db, admin(orgId), "latest");
    const warmed = await warm(agentId);
    expect(warmed.desiredVersion).toBe("2.0.0");
    expect(warmed.versionPolicy).toBe("latest");
    const age = async (key: string) => {
      const stored = JSON.parse((await getRedis().get(key))!) as { checkedAt: number };
      stored.checkedAt -= 10 * 60_000;
      await getRedis().set(key, JSON.stringify(stored));
    };
    // Due to be read again: npm is, Postgres isn't.
    await age(latestVersionKey(orgId));
    expect((await send(agentId)).calls).toBe(0);

    state.latest = "2.1.0";
    await age(latestVersionKey(orgId));
    await db
      .update(appSettings)
      .set({ updatedAt: new Date(Date.now() - 10 * 60_000) })
      .where(
        and(eq(appSettings.organizationId, orgId), eq(appSettings.key, LATEST_AGENT_VERSION_KEY)),
      );
    const after = await send(agentId);
    expect(after.calls).toBeGreaterThan(0);
    expect(after.response.desiredVersion).toBe("2.1.0");
    expect(after.response.versionPolicy).toBe("latest");
  });

  const DAY_MS = 24 * 3600_000;

  /**
   * Expects `key` to expire at a daily window start, between `minDays` and `maxDays` days from
   * now: a key whose expiry sends the next request to Postgres sends it in the window.
   */
  async function expectExpiresAtWindow(key: string, minDays: number, maxDays: number) {
    const pttl = await getRedis().pttl(key);
    const expiresAt = Date.now() + pttl;
    // Within the few seconds since the key was set of a window start.
    const window = currentDailyWindow(new Date(expiresAt + 5_000));
    expect(Math.abs(expiresAt - window)).toBeLessThan(5_000);
    expect(pttl).toBeGreaterThan(minDays * DAY_MS - 5_000);
    expect(pttl).toBeLessThanOrEqual(maxDays * DAY_MS);
  }

  it("expires the cached organization and the change counters at a daily window start", async () => {
    const { agentId, orgId } = await newAgent();
    await warm(agentId);
    const builtAt = Date.now();
    await expectExpiresAtWindow(agentOrganizationKey(agentId), 6, 7);
    await expectExpiresAtWindow(agentChangesKey(agentId), 29, 30);
    await expectExpiresAtWindow(organizationChangesKey(orgId), 29, 30);
    // A response cached with the counters is due before they expire, so a counter recreated at
    // a new value never sends a heartbeat to Postgres before its window.
    expect(cachedResponseDueAt(builtAt)).toBeLessThan(
      Date.now() + (await getRedis().pttl(agentChangesKey(agentId))),
    );

    // A bump keeps the expiry at a window start.
    await getRedis().pexpire(agentChangesKey(agentId), 60_000);
    await getRedis().pexpire(organizationChangesKey(orgId), 60_000);
    await bumpAgentHeartbeat(agentId);
    await bumpOrganizationHeartbeat(orgId);
    await expectExpiresAtWindow(agentChangesKey(agentId), 29, 30);
    await expectExpiresAtWindow(organizationChangesKey(orgId), 29, 30);
  });

  /** Sets the cached response's build time (ms). */
  async function setBuiltAt(agentId: string, builtAt: number) {
    const key = heartbeatResponseKey(agentId);
    const entry = JSON.parse((await getRedis().get(key))!) as { builtAt: number };
    entry.builtAt = builtAt;
    await getRedis().set(key, JSON.stringify(entry), "PX", CACHED_RESPONSE_KEEP_MS);
  }

  describe("the cached response's bound", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("uses a cached response until the next daily window, then builds it from Postgres", async () => {
      const errors = vi.spyOn(console, "error");
      const { agentId } = await newAgent();
      const cached = await warm(agentId);
      // Kept past the bound, for the drift check.
      expect(await getRedis().pttl(heartbeatResponseKey(agentId))).toBeGreaterThan(
        cachedResponseDueAt(Date.now()) - Date.now(),
      );
      // Built at the latest window's start, up to a day ago: still used.
      const window = currentDailyWindow(new Date());
      await setBuiltAt(agentId, window);
      expect((await send(agentId)).calls).toBe(0);

      // Built a minute before it, however recently: due.
      await setBuiltAt(agentId, window - 60_000);
      const fresh = await send(agentId);
      expect(fresh.calls).toBeGreaterThan(0);
      expect(fresh.response).toEqual(cached);
      // Nothing drifted; the fresh response is cached again.
      expect(errors).not.toHaveBeenCalled();
      expect((await send(agentId)).calls).toBe(0);
    });

    it("builds the response from Postgres again once the epoch changed", async () => {
      const { agentId } = await newAgent();
      await warm(agentId);
      expect((await send(agentId)).calls).toBe(0);
      // A rebuild elsewhere: the counters the response was cached with may be gone.
      await getRedis().set(EPOCH_KEY, randomUUID());
      expect((await send(agentId)).calls).toBeGreaterThan(0);
      expect((await send(agentId)).calls).toBe(0);
    });

    it("logs the fields of a response served stale by a missed bump", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const { agentId, orgId } = await newAgent();
      await warm(agentId);
      const repositoryId = await newRepository(orgId);
      // A write that forgot to bump: the cache keeps serving the old response...
      await db.insert(agentRepoPins).values({ agentId, repositoryId });
      const stale = await send(agentId);
      expect(stale.calls).toBe(0);
      expect(stale.response.pinnedRepositories).toEqual([]);

      // ...until a daily window passes: the agent gets the fresh one, and the drift is logged.
      // The report's fingerprint expires at that window too.
      await setBuiltAt(agentId, currentDailyWindow(new Date()) - 60_000);
      await getRedis().del(agentReportKey(agentId));
      const fresh = await send(agentId);
      expect(fresh.calls).toBeGreaterThan(0);
      expect(fresh.response.pinnedRepositories).toHaveLength(1);
      expect(errors).toHaveBeenCalledTimes(1);
      const [message, detail] = errors.mock.calls[0]!;
      expect(message).toContain(agentId);
      expect(message).toContain(orgId);
      expect(detail).toEqual({ agentId, organizationId: orgId, fields: ["pinnedRepositories"] });
      // Names, not values.
      expect(JSON.stringify(errors.mock.calls)).not.toContain(repositoryId);
      expect(JSON.stringify(errors.mock.calls)).not.toContain("acme/api");

      // The fresh response is cached.
      const next = await send(agentId);
      expect(next.calls).toBe(0);
      expect(next.response.pinnedRepositories).toHaveLength(1);
    });
  });

  it("takes the Postgres path with running jobs, renewing their leases", async () => {
    const { agentId, orgId } = await newAgent();
    await warm(agentId);
    const jobId = await runningJob(orgId, agentId);
    for (let i = 0; i < 2; i++) {
      const [before] = await db.select().from(jobs).where(eq(jobs.id, jobId));
      const { response, calls } = await send(agentId, { runningJobIds: [jobId] });
      expect(calls).toBeGreaterThan(0);
      expect(response.cancelJobIds).toEqual([]);
      expect(response.jobTokens.length).toBeGreaterThan(0);
      const [after] = await db.select().from(jobs).where(eq(jobs.id, jobId));
      expect(after!.leaseExpiresAt!.getTime()).toBeGreaterThan(before!.leaseExpiresAt!.getTime());
    }
    // Once it stops reporting the job, the idle response is the cached one again.
    expect((await send(agentId)).calls).toBe(0);
  });

  it("takes the Postgres path for message acknowledgements", async () => {
    const { agentId } = await newAgent();
    await warm(agentId);
    expect((await send(agentId, { deliveredMessageIds: [randomUUID()] })).calls).toBeGreaterThan(0);
  });

  it("rebuilds after a flushed Redis, and needs Postgres every time without Redis", async () => {
    const { agentId } = await newAgent();
    await warm(agentId);
    await getRedis().flushdb();
    expect((await send(agentId)).calls).toBeGreaterThan(0);
    expect((await send(agentId)).calls).toBe(0);

    vi.stubEnv("REDIS_URL", "");
    await closeRedis();
    expect((await send(agentId)).calls).toBeGreaterThan(0);
    expect((await send(agentId)).calls).toBeGreaterThan(0);
  });
});

describe("cachedResponseDueAt", () => {
  const at = (iso: string) => new Date(iso).getTime();

  it("is the first daily window start after the build, whenever in the day it was built", () => {
    expect(cachedResponseDueAt(at("2026-10-31T02:00:00Z"))).toBe(at("2026-10-31T03:15:00Z"));
    expect(cachedResponseDueAt(at("2026-10-31T03:15:00Z"))).toBe(at("2026-11-01T03:15:00Z"));
    expect(cachedResponseDueAt(at("2026-10-31T23:59:00Z"))).toBe(at("2026-11-01T03:15:00Z"));
  });
});

describe("checkHeartbeatDrift", () => {
  const base = {
    pollIntervalSeconds: 60,
    pinnedRepositories: [],
    organizationId: "org-1",
    topics: [],
    queueRegion: "",
    cancelJobIds: [],
    jobTokens: [],
    jobMessages: [],
    desiredVersion: "2.0.0",
    versionPolicy: "latest" as const,
    requiredHostTools: ["gh"],
  };
  const check = (
    cached: Partial<typeof base>,
    fresh: Partial<typeof base>,
    latest: { cached?: string | null; fresh?: string | null } = {},
  ) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const fields = checkHeartbeatDrift({
        agentId: "agent-1",
        organizationId: "org-1",
        cached: {
          response: { ...base, ...cached },
          ...(latest.cached !== undefined && { latestVersion: latest.cached }),
          due: true,
        },
        fresh: { ...base, ...fresh },
        latestVersion: latest.fresh,
      });
      return { fields, logged: errors.mock.calls.length };
    } finally {
      errors.mockRestore();
    }
  };

  it("reports nothing for equal responses, whatever their key order", () => {
    const reordered = Object.fromEntries(Object.entries(base).reverse());
    expect(check(base, reordered)).toEqual({ fields: [], logged: 0 });
  });

  it("names every cached field that differs", () => {
    expect(check({}, { requiredHostTools: [], desiredVersion: "2.1.0" })).toEqual({
      fields: ["desiredVersion", "requiredHostTools"],
      logged: 1,
    });
  });

  it("leaves out the version when npm's latest moved without a bump", () => {
    const moved = { desiredVersion: "2.1.0" };
    expect(check({}, moved, { cached: "2.0.0", fresh: "2.1.0" })).toEqual({
      fields: [],
      logged: 0,
    });
    // Same latest: a different version is drift.
    expect(check({}, moved, { cached: "2.0.0", fresh: "2.0.0" }).fields).toEqual([
      "desiredVersion",
    ]);
    // Not tracking latest: compared.
    expect(check({}, moved).fields).toEqual(["desiredVersion"]);
  });
});
