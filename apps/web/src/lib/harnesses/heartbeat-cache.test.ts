import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import {
  LATEST_HARNESS_VERSION_KEY,
  appSettings,
  chatConnections,
  chatThreadRuns,
  chatThreads,
  closeDb,
  connectRepository,
  createDb,
  harnesses,
  jobs,
  organizations,
  ralphRuns,
  seedReviewProfiles,
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
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestRedis, testRedisAvailable, type TestRedis } from "@/lib/hot-state/testing";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ db: undefined as unknown as Database, latest: "2.0.0" }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/harnesses/npm", () => ({
  NpmRegistryError: class extends Error {},
  latestHarnessVersion: async () => state.latest,
}));

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
delete process.env.KMS_AGENT_ISSUER_ID;
process.env.LOCAL_AGENT_SIGNING_KEY = privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const { closeRedis, getRedis } = await import("@/lib/hot-state");
const { POST: heartbeat } = await import("@/app/api/harness/heartbeat/route");
const { getTokenSigner } = await import("@/lib/harness-auth/signer");
const { PostgresDispatcher } = await import("@/lib/dispatch/dispatcher");
const { jobDueKey } = await import("@/lib/dispatch/due");
const { latestVersionKey } = await import("./heartbeat-cache");
const manage = await import("./manage");
const defaults = await import("./defaults");
const { pinRepository } = await import("./pins");
const { saveRepositorySettings } = await import("@/lib/repositories/settings");
const { sendToChatRun } = await import("@/lib/ralph/chat-reply");

const databaseAvailable = testDatabaseAvailable();
const redisAvailable = await testRedisAvailable();

const IDLE = { version: "1.4.0", selfUpdate: "supported", runningJobIds: [], freeSlots: 1 };

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

  /** A harness of a fresh organization (organization settings don't leak between tests). */
  async function newHarness(): Promise<{ harnessId: string; orgId: string }> {
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    const [harness] = await db
      .insert(harnesses)
      .values({ organizationId: org!.id, name: "coder-1" })
      .returning();
    return { harnessId: harness!.id, orgId: org!.id };
  }

  /** Sends a heartbeat; returns its response and the Postgres calls it made. */
  async function send(
    harnessId: string,
    body: Record<string, unknown> = {},
  ): Promise<{ response: HeartbeatResponse; calls: number }> {
    const token = await getTokenSigner().signAccessToken(harnessId);
    ipCounter += 1;
    const before = postgresCalls;
    const response = await heartbeat(
      new Request("http://localhost/api/harness/heartbeat", {
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
  async function warm(harnessId: string): Promise<HeartbeatResponse> {
    const first = await send(harnessId);
    expect(first.calls).toBeGreaterThan(0);
    const second = await send(harnessId);
    expect(second.calls).toBe(0);
    expect(second.response).toEqual(first.response);
    return second.response;
  }

  const admin = (orgId: string) => ({ id: userId, organization: { id: orgId } });

  async function newRepository(orgId: string): Promise<string> {
    await seedReviewProfiles(db, orgId);
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

  async function runningJob(orgId: string, harnessId: string, extra = {}): Promise<string> {
    const [job] = await db
      .insert(jobs)
      .values({
        organizationId: orgId,
        type: "test.job",
        taskType: "review",
        status: "running",
        harnessId,
        startedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 30_000),
        ...extra,
      })
      .returning();
    return job!.id;
  }

  it("answers an unchanged idle heartbeat without a Postgres query", async () => {
    const { harnessId } = await newHarness();
    const cached = await warm(harnessId);
    expect(cached.pinnedRepoIds).toEqual([]);
    // Last-seen still moves.
    const seen = Number(await getRedis().get(`harness-last-seen:${harnessId}`));
    expect(Date.now() - seen).toBeLessThan(5_000);
    // `claimable` without a due job: false, still from Redis.
    const claimable = await send(harnessId, { claimablePools: ["short"] });
    expect(claimable.calls).toBe(0);
    expect(claimable.response.claimable).toBe(false);
  });

  it("asks Postgres about claimablePools when the organization has a due job", async () => {
    const { harnessId, orgId } = await newHarness();
    await warm(harnessId);
    await getRedis().zadd(jobDueKey(orgId), Date.now() - 1000, randomUUID());
    const { response, calls } = await send(harnessId, { claimablePools: ["short"] });
    expect(calls).toBeGreaterThan(0);
    expect(response.claimable).toBe(false);
  });

  it("takes the Postgres path when the harness's report changes", async () => {
    const { harnessId } = await newHarness();
    await warm(harnessId);
    expect((await send(harnessId, { version: "1.5.0" })).calls).toBeGreaterThan(0);
    const [row] = await db.select().from(harnesses).where(eq(harnesses.id, harnessId));
    expect(row!.reportedVersion).toBe("1.5.0");
    expect((await send(harnessId, { version: "1.5.0" })).calls).toBe(0);
    // A new host tools report is stored too.
    const tools = [{ name: "semgrep", configuredPathExists: null, discoveredPath: "/bin/semgrep" }];
    expect((await send(harnessId, { version: "1.5.0", hostTools: tools })).calls).toBeGreaterThan(
      0,
    );
  });

  type Change = (ids: { harnessId: string; orgId: string }) => Promise<void>;
  const changes: [string, Change, (response: HeartbeatResponse) => void][] = [
    [
      "harness config",
      async ({ harnessId, orgId }) => {
        expect(
          await manage.updateHarnessConfig(db, orgId, harnessId, {
            maxConcurrency: 3,
            acceptedTaskTypes: null,
            poolLimits: {},
          }),
        ).toEqual({ ok: true });
      },
      (response) => expect(response.maxConcurrency).toBe(3),
    ],
    [
      "harness desired version",
      async ({ harnessId, orgId }) => {
        await manage.setHarnessDesiredVersion(db, orgId, harnessId, "1.9.0");
      },
      (response) => expect(response.desiredVersion).toBe("1.9.0"),
    ],
    [
      "pin",
      async ({ harnessId, orgId }) => {
        const repositoryId = await newRepository(orgId);
        const dispatcher = new PostgresDispatcher({ db });
        expect((await pinRepository(db, dispatcher, { harnessId, repositoryId })).result).toBe(
          "pinned",
        );
      },
      (response) => expect(response.pinnedRepoIds).toHaveLength(1),
    ],
    [
      "unpin",
      async ({ harnessId, orgId }) => {
        // Pinned before the warm-up (`setUp`), unpinned here from the repository's settings.
        const [repositoryId] = (await send(harnessId)).response.pinnedRepoIds;
        const saved = await saveRepositorySettings(
          db,
          new PostgresDispatcher({ db }),
          orgId,
          repositoryId!,
          {
            profileId: "standard",
            triggers: { onOpen: true, onPush: true, drafts: false },
            pathExcludes: [],
            customInstructions: "",
            pinnedHarnessIds: [],
            reviewTaskIds: ["builtin:review-pr"],
            correlationTaskId: "builtin:correlate-findings",
          },
        );
        expect(saved).toMatchObject({ status: "saved", unpinnedHarnessIds: [harnessId] });
      },
      (response) => expect(response.pinnedRepoIds).toEqual([]),
    ],
    [
      "update request",
      async ({ harnessId, orgId }) => {
        expect(await manage.requestHarnessUpdate(db, orgId, harnessId)).toMatchObject({
          ok: true,
        });
      },
      (response) => expect(response.updateRequest).toMatchObject({ version: "2.0.0" }),
    ],
    [
      "organization defaults",
      async ({ orgId }) => {
        await defaults.setOrganizationDefaults(db, admin(orgId), {
          allowedTaskTypes: ["review"],
          maxConcurrency: 7,
        });
      },
      (response) => {
        expect(response.maxConcurrency).toBe(7);
        expect(response.acceptedTaskTypes).toEqual(["review"]);
      },
    ],
    [
      "organization version",
      async ({ orgId }) => {
        await defaults.setGlobalHarnessVersion(db, admin(orgId), "1.8.0");
      },
      (response) => expect(response.desiredVersion).toBe("1.8.0"),
    ],
    [
      "host tool added",
      async ({ orgId }) => {
        expect((await defaults.addHostTool(db, orgId, { name: "semgrep" })).ok).toBe(true);
      },
      (response) => expect(response.hostTools).toEqual([{ name: "semgrep", configuredPath: null }]),
    ],
    [
      "host tool path",
      async ({ harnessId, orgId }) => {
        const [tool] = await defaults.loadHostToolCatalog(db, orgId);
        expect(
          await manage.setHostToolPath(db, orgId, harnessId, tool!.id, "/opt/semgrep"),
        ).toEqual({ ok: true });
      },
      (response) =>
        expect(response.hostTools).toEqual([{ name: "semgrep", configuredPath: "/opt/semgrep" }]),
    ],
    [
      "host tool removed",
      async ({ orgId }) => {
        const [tool] = await defaults.loadHostToolCatalog(db, orgId);
        expect(await defaults.removeHostTool(db, orgId, tool!.id)).toEqual({ ok: true });
      },
      (response) => expect(response.hostTools).toEqual([]),
    ],
  ];

  /** What a change needs in place before the warm-up. */
  async function setUp(name: string, ids: { harnessId: string; orgId: string }): Promise<void> {
    if (name === "unpin") {
      const repositoryId = await newRepository(ids.orgId);
      await pinRepository(db, new PostgresDispatcher({ db }), { ...ids, repositoryId });
    }
    if (name === "host tool path" || name === "host tool removed") {
      await defaults.addHostTool(db, ids.orgId, { name: "semgrep" });
    }
  }

  it.each(changes)("a %s change invalidates the cached response", async (name, change, check) => {
    const ids = await newHarness();
    await setUp(name, ids);
    const before = await warm(ids.harnessId);
    await change(ids);
    const after = await send(ids.harnessId);
    expect(after.calls).toBeGreaterThan(0);
    expect(after.response).not.toEqual(before);
    check(after.response);
    // Cached again from then on.
    const again = await send(ids.harnessId);
    expect(again.calls).toBe(0);
    expect(again.response).toEqual(after.response);
  });

  it("a cancel request invalidates the cached response", async () => {
    const { harnessId, orgId } = await newHarness();
    await warm(harnessId);
    const jobId = await runningJob(orgId, harnessId);
    expect(await new PostgresDispatcher({ db }).cancel(jobId)).toBe("cancel_requested");
    expect((await send(harnessId)).calls).toBeGreaterThan(0);
  });

  it("a job message invalidates the cached response", async () => {
    const { harnessId, orgId } = await newHarness();
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
    await runningJob(orgId, harnessId, { type: "ralph.request", ralphRunId: run!.id });
    await warm(harnessId);
    const deps = { db, organizationId: orgId } as Parameters<typeof sendToChatRun>[0];
    expect(
      await sendToChatRun(deps, { chatThreadId: thread!.id, text: "Use tabs.", author: null }),
    ).toMatchObject({ status: "live" });
    expect((await send(harnessId)).calls).toBeGreaterThan(0);
  });

  it("follows npm's latest from Redis, and a new latest invalidates the cached response", async () => {
    const { harnessId, orgId } = await newHarness();
    await defaults.setGlobalHarnessVersion(db, admin(orgId), "latest");
    expect((await warm(harnessId)).desiredVersion).toBe("2.0.0");
    const age = async (key: string) => {
      const stored = JSON.parse((await getRedis().get(key))!) as { checkedAt: number };
      stored.checkedAt -= 10 * 60_000;
      await getRedis().set(key, JSON.stringify(stored));
    };
    // Due to be read again: npm is, Postgres isn't.
    await age(latestVersionKey(orgId));
    expect((await send(harnessId)).calls).toBe(0);

    state.latest = "2.1.0";
    await age(latestVersionKey(orgId));
    await db
      .update(appSettings)
      .set({ updatedAt: new Date(Date.now() - 10 * 60_000) })
      .where(
        and(eq(appSettings.organizationId, orgId), eq(appSettings.key, LATEST_HARNESS_VERSION_KEY)),
      );
    const after = await send(harnessId);
    expect(after.calls).toBeGreaterThan(0);
    expect(after.response.desiredVersion).toBe("2.1.0");
  });

  it("takes the Postgres path with running jobs, renewing their leases", async () => {
    const { harnessId, orgId } = await newHarness();
    await warm(harnessId);
    const jobId = await runningJob(orgId, harnessId);
    for (let i = 0; i < 2; i++) {
      const [before] = await db.select().from(jobs).where(eq(jobs.id, jobId));
      const { response, calls } = await send(harnessId, { runningJobIds: [jobId] });
      expect(calls).toBeGreaterThan(0);
      expect(response.cancelJobIds).toEqual([]);
      expect(response.jobTokens.length).toBeGreaterThan(0);
      const [after] = await db.select().from(jobs).where(eq(jobs.id, jobId));
      expect(after!.leaseExpiresAt!.getTime()).toBeGreaterThan(before!.leaseExpiresAt!.getTime());
    }
    // Once it stops reporting the job, the idle response is the cached one again.
    expect((await send(harnessId)).calls).toBe(0);
  });

  it("takes the Postgres path for message acknowledgements", async () => {
    const { harnessId } = await newHarness();
    await warm(harnessId);
    expect((await send(harnessId, { deliveredMessageIds: [randomUUID()] })).calls).toBeGreaterThan(
      0,
    );
  });

  it("rebuilds after a flushed Redis, and needs Postgres every time without Redis", async () => {
    const { harnessId } = await newHarness();
    await warm(harnessId);
    await getRedis().flushdb();
    expect((await send(harnessId)).calls).toBeGreaterThan(0);
    expect((await send(harnessId)).calls).toBe(0);

    vi.stubEnv("REDIS_URL", "");
    await closeRedis();
    expect((await send(harnessId)).calls).toBeGreaterThan(0);
    expect((await send(harnessId)).calls).toBeGreaterThan(0);
  });
});
