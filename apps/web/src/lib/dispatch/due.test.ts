import { generateKeyPairSync, randomUUID } from "node:crypto";
import { closeDb, createDb, harnesses, jobs, organizations, type Database } from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import type { JobStartResponse } from "@omniralph/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
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

const { EPOCH_KEY, closeRedis, getRedis } = await import("@/lib/hot-state");
const { PostgresDispatcher } = await import("./dispatcher");
const { hasDueJob, jobDueKey, renewJobsDue, skipJobAndClearDue, syncJobsDueFromPostgres } =
  await import("./due");
const { getTokenSigner } = await import("@/lib/harness-auth/signer");
const { registerJobOutcomeHandler } = await import("@/lib/jobs/handlers");
const { POST: claim } = await import("@/app/api/harness/claim/route");
const { POST: fail } = await import("@/app/api/harness/jobs/[id]/fail/route");
const { POST: result } = await import("@/app/api/harness/jobs/[id]/result/route");
const { GET: expireJobs } = await import("@/app/api/cron/expire-jobs/route");

const JOB_TYPE = "due.test";
const databaseAvailable = testDatabaseAvailable();
const redisAvailable = await testRedisAvailable();

let ipCounter = 0;
function harnessRequest(path: string, accessToken: string, body: unknown): Request {
  ipCounter += 1;
  return new Request(`http://localhost/api/harness/${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "x-real-ip": `198.51.100.${ipCounter % 250}`,
    },
    body: JSON.stringify(body),
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!databaseAvailable || !redisAvailable)("claim due set", () => {
  let testDb: TestDatabase;
  let testRedis: TestRedis;
  let db: Database;
  /** Postgres calls made through `state.db` (the routes' `getDb()`). */
  let postgresCalls = 0;

  beforeAll(async () => {
    [testDb, testRedis] = await Promise.all([createTestDatabase(), startTestRedis()]);
    db = createDb(testDb.uri);
    // Counts every query the routes start; the tests themselves use `db` directly.
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
    registerJobOutcomeHandler(JOB_TYPE, { payload: z.object({}) });
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
  });

  /** An organization of its own with one harness, so other tests' jobs aren't due. */
  async function newOrg() {
    const [org] = await db.insert(organizations).values({ name: "Dueco" }).returning();
    const organizationId = org!.id;
    async function newHarness() {
      const [harness] = await db
        .insert(harnesses)
        .values({ organizationId, name: "coder-1" })
        .returning();
      return { id: harness!.id, token: await getTokenSigner().signAccessToken(harness!.id) };
    }
    const harness = await newHarness();
    async function dispatch() {
      const { job } = await new PostgresDispatcher({ db }).createAndPublish({
        organizationId,
        type: JOB_TYPE,
        taskType: "query",
        payload: {},
        dedupeKey: randomUUID(),
      });
      return job;
    }
    return { organizationId, harness, newHarness, dispatch };
  }

  function claimAs(accessToken: string, waitSeconds: number) {
    return claim(harnessRequest("claim", accessToken, { pools: ["short"], waitSeconds }));
  }

  async function claimedJobId(res: Response): Promise<string> {
    expect(res.status).toBe(200);
    return ((await res.json()) as JobStartResponse & { action: "run" }).job.id;
  }

  async function score(organizationId: string, jobId: string): Promise<number | null> {
    const value = await getRedis().zscore(jobDueKey(organizationId), jobId);
    return value === null ? null : Number(value);
  }

  /** Makes the epoch current and caches the harness's organization and auth state. */
  async function warm(accessToken: string) {
    expect((await claimAs(accessToken, 0)).status).toBe(204);
    expect(await getRedis().exists(EPOCH_KEY)).toBe(1);
  }

  async function jobRow(id: string) {
    const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
    return row!;
  }

  const DAY_MS = 24 * 3600 * 1000;

  /** Makes the job two days old, in Postgres and the queued set. */
  async function backdate(id: string) {
    await db
      .update(jobs)
      .set({ createdAt: new Date(Date.now() - 2 * DAY_MS) })
      .where(eq(jobs.id, id));
    await syncJobsDueFromPostgres(db, [id]);
  }

  function expireJobsCron() {
    return expireJobs(
      new Request("http://localhost/api/cron/expire-jobs", {
        headers: { authorization: "Bearer cron-secret" },
      }),
    );
  }

  async function queuedSince(jobId: string): Promise<number | null> {
    const value = await getRedis().zscore("job-queued-since", jobId);
    return value === null ? null : Number(value);
  }

  it("wakes a waiting claim for a dispatched job, without querying Postgres before", async () => {
    const { organizationId, harness, dispatch } = await newOrg();
    await warm(harness.token);
    postgresCalls = 0;
    const pending = claimAs(harness.token, 15);
    await sleep(4_500);
    // Two idle looks (every 2s), all in Redis.
    expect(postgresCalls).toBe(0);

    const dispatchedAt = Date.now();
    const job = await dispatch();
    expect(await score(organizationId, job.id)).toBe(job.availableAt.getTime());
    expect(await claimedJobId(await pending)).toBe(job.id);
    expect(Date.now() - dispatchedAt).toBeLessThan(3_000);
    expect(postgresCalls).toBeGreaterThan(0);

    // Claimed: due again when its lease lapses.
    const claimed = await jobRow(job.id);
    expect(claimed.status).toBe("running");
    expect(await score(organizationId, job.id)).toBe(claimed.leaseExpiresAt!.getTime());
  }, 30_000);

  it("doesn't wake a waiting claim for a delayed retry before it's due", async () => {
    const { organizationId, harness, dispatch } = await newOrg();
    const job = await dispatch();
    expect(await claimedJobId(await claimAs(harness.token, 0))).toBe(job.id);
    const failed = await fail(
      harnessRequest(`jobs/${job.id}/fail`, harness.token, {
        retryable: true,
        retryAfterSeconds: 4,
        error: "rate limited",
      }),
      ctx(job.id),
    );
    expect(failed.status).toBe(200);
    const retry = await jobRow(job.id);
    expect(retry.status).toBe("queued");
    expect(await score(organizationId, job.id)).toBe(retry.availableAt.getTime());

    postgresCalls = 0;
    const pending = claimAs(harness.token, 15);
    await sleep(2_500);
    expect(postgresCalls).toBe(0);
    expect(await claimedJobId(await pending)).toBe(job.id);
    expect(Date.now()).toBeGreaterThanOrEqual(retry.availableAt.getTime());
    expect(Date.now() - retry.availableAt.getTime()).toBeLessThan(3_000);
  }, 30_000);

  it("wakes a waiting claim when a running job's lease lapses", async () => {
    const { organizationId, harness, newHarness, dispatch } = await newOrg();
    const job = await dispatch();
    expect(await claimedJobId(await claimAs(harness.token, 0))).toBe(job.id);
    // The first harness's last renewal: its lease lapses in 3s.
    const leaseExpiresAt = new Date(Date.now() + 3_000);
    await db.update(jobs).set({ leaseExpiresAt }).where(eq(jobs.id, job.id));
    await renewJobsDue(organizationId, [job.id], leaseExpiresAt);

    const other = await newHarness();
    await warm(other.token);
    postgresCalls = 0;
    const pending = claimAs(other.token, 15);
    await sleep(2_000);
    expect(postgresCalls).toBe(0);
    expect(await claimedJobId(await pending)).toBe(job.id);
    expect((await jobRow(job.id)).harnessId).toBe(other.id);
    expect(Date.now() - leaseExpiresAt.getTime()).toBeLessThan(3_000);
  }, 30_000);

  it("rebuilds a flushed Redis from queued and running jobs", async () => {
    const { organizationId, harness, dispatch } = await newOrg();
    const running = await dispatch();
    expect(await claimedJobId(await claimAs(harness.token, 0))).toBe(running.id);
    const queued = await dispatch();
    const done = await dispatch();
    await db.update(jobs).set({ status: "completed" }).where(eq(jobs.id, done.id));

    await getRedis().flushdb();
    expect(await hasDueJob(db, organizationId)).toBe(true);
    expect(await getRedis().exists(EPOCH_KEY)).toBe(1);
    expect(await score(organizationId, queued.id)).toBe(queued.availableAt.getTime());
    expect(await score(organizationId, running.id)).toBe(
      (await jobRow(running.id)).leaseExpiresAt!.getTime(),
    );
    expect(await score(organizationId, done.id)).toBeNull();

    // The rebuilt set wakes a claim for the queued job.
    expect(await claimedJobId(await claimAs(harness.token, 0))).toBe(queued.id);
  });

  it("removes completed, failed, canceled, skipped and expired jobs", async () => {
    const { organizationId, harness, dispatch } = await newOrg();
    const dispatcher = new PostgresDispatcher({ db });

    const completed = await dispatch();
    expect(await claimedJobId(await claimAs(harness.token, 0))).toBe(completed.id);
    const res = await result(
      harnessRequest(`jobs/${completed.id}/result`, harness.token, { result: {} }),
      ctx(completed.id),
    );
    expect(res.status).toBe(200);
    expect(await score(organizationId, completed.id)).toBeNull();

    const failed = await dispatch();
    expect(await claimedJobId(await claimAs(harness.token, 0))).toBe(failed.id);
    await fail(
      harnessRequest(`jobs/${failed.id}/fail`, harness.token, { retryable: false }),
      ctx(failed.id),
    );
    expect((await jobRow(failed.id)).status).toBe("failed");
    expect(await score(organizationId, failed.id)).toBeNull();

    const canceled = await dispatch();
    expect(await dispatcher.cancel(canceled.id)).toBe("canceled");
    expect(await score(organizationId, canceled.id)).toBeNull();

    const skipped = await dispatch();
    expect(await skipJobAndClearDue(db, skipped, { reason: "nothing to do" })).toBe(true);
    expect(await score(organizationId, skipped.id)).toBeNull();

    const expired = await dispatch();
    await backdate(expired.id);
    const cron = await expireJobsCron();
    expect(cron.status).toBe(200);
    expect((await jobRow(expired.id)).status).toBe("expired");
    expect(await score(organizationId, expired.id)).toBeNull();

    expect(await hasDueJob(db, organizationId)).toBe(false);
  });

  it("drops an entry left behind once a claim finds nothing for it", async () => {
    const { organizationId, harness, dispatch } = await newOrg();
    await warm(harness.token);
    const job = await dispatch();
    // Finished behind the due set's back (e.g. a rebuild raced the writer).
    await db.update(jobs).set({ status: "completed" }).where(eq(jobs.id, job.id));
    expect(await hasDueJob(db, organizationId)).toBe(true);
    expect((await claimAs(harness.token, 0)).status).toBe(204);
    expect(await score(organizationId, job.id)).toBeNull();
    expect(await hasDueJob(db, organizationId)).toBe(false);
  });

  it("skips the expire cron without querying Postgres while no queued job is a day old", async () => {
    const { harness, dispatch } = await newOrg();
    await warm(harness.token);
    const queued = await dispatch();
    expect(await queuedSince(queued.id)).toBe(queued.createdAt.getTime());
    // A running job that's old doesn't count: only queued jobs expire.
    const running = await dispatch();
    await backdate(running.id);
    expect(await claimedJobId(await claimAs(harness.token, 0))).toBe(running.id);
    expect(await queuedSince(running.id)).toBeNull();

    postgresCalls = 0;
    expect(await (await expireJobsCron()).json()).toEqual({ expired: 0 });
    expect(postgresCalls).toBe(0);
    expect((await jobRow(queued.id)).status).toBe("queued");
  });

  it("runs the expire cron once a queued job is a day old, even a delayed retry", async () => {
    const { organizationId, harness, dispatch } = await newOrg();
    await warm(harness.token);
    const job = await dispatch();
    await backdate(job.id);
    expect(await claimedJobId(await claimAs(harness.token, 0))).toBe(job.id);
    await fail(
      harnessRequest(`jobs/${job.id}/fail`, harness.token, {
        retryable: true,
        retryAfterSeconds: 3600,
        error: "rate limited",
      }),
      ctx(job.id),
    );
    // Retried: not due for an hour, but created two days ago.
    expect(await score(organizationId, job.id)).toBeGreaterThan(Date.now());
    expect(await queuedSince(job.id)).toBeLessThan(Date.now() - DAY_MS);

    postgresCalls = 0;
    expect(await (await expireJobsCron()).json()).toEqual({ expired: 1 });
    expect(postgresCalls).toBeGreaterThan(0);
    expect((await jobRow(job.id)).status).toBe("expired");
    expect(await queuedSince(job.id)).toBeNull();
    expect(await score(organizationId, job.id)).toBeNull();

    postgresCalls = 0;
    expect(await (await expireJobsCron()).json()).toEqual({ expired: 0 });
    expect(postgresCalls).toBe(0);
  });

  it("drops a queued entry left behind once the expire cron finds nothing for it", async () => {
    const { harness, dispatch } = await newOrg();
    await warm(harness.token);
    const job = await dispatch();
    await backdate(job.id);
    // Finished behind the set's back.
    await db.update(jobs).set({ status: "completed" }).where(eq(jobs.id, job.id));
    expect(await (await expireJobsCron()).json()).toEqual({ expired: 0 });
    expect(await queuedSince(job.id)).toBeNull();

    postgresCalls = 0;
    await expireJobsCron();
    expect(postgresCalls).toBe(0);
  });

  it("rebuilds the queued set of a flushed Redis before skipping the expire cron", async () => {
    const { dispatch } = await newOrg();
    const job = await dispatch();
    await db
      .update(jobs)
      .set({ createdAt: new Date(Date.now() - 2 * DAY_MS) })
      .where(eq(jobs.id, job.id));
    await getRedis().flushdb();
    expect(await (await expireJobsCron()).json()).toEqual({ expired: 1 });
    expect(await getRedis().exists(EPOCH_KEY)).toBe(1);
  });

  it("runs the expire cron from Postgres without Redis", async () => {
    vi.stubEnv("REDIS_URL", "");
    await closeRedis();
    const { dispatch } = await newOrg();
    const job = await dispatch();
    await db
      .update(jobs)
      .set({ createdAt: new Date(Date.now() - 2 * DAY_MS) })
      .where(eq(jobs.id, job.id));
    expect(await (await expireJobsCron()).json()).toEqual({ expired: 1 });
  });

  it("claims from Postgres on every look without Redis", async () => {
    vi.stubEnv("REDIS_URL", "");
    await closeRedis();
    const { harness, dispatch } = await newOrg();
    const pending = claimAs(harness.token, 15);
    await sleep(500);
    const job = await dispatch();
    expect(await claimedJobId(await pending)).toBe(job.id);
  }, 30_000);
});
