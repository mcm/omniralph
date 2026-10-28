import { randomUUID } from "node:crypto";
import {
  closeDb,
  createDb,
  createRun,
  organizations,
  ralphRuns,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestRedis, testRedisAvailable, type TestRedis } from "@/lib/hot-state/testing";
import type { RalphDeps } from "./run";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  /** Full reconcile runs. */
  runs: 0,
  /** Runs during the next full run, e.g. a writer committing meanwhile. */
  during: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/dispatch", () => ({ getDispatcher: () => ({}) }));
vi.mock("@/lib/ralph/reconcile-cron", () => ({
  reconcileAllOrganizations: async () => {
    state.runs += 1;
    await state.during?.();
    state.during = undefined;
    return { organizations: 0, reconciled: 0, failed: 0 };
  },
}));

process.env.CRON_SECRET = "cron-secret";
const { EPOCH_KEY, closeRedis, getRedis } = await import("@/lib/hot-state");
const { markRalphActive, runReconcilePass } = await import("./active");
const { advanceRun } = await import("./run");
const { GET } = await import("@/app/api/cron/ralph-reconcile/route");

const databaseAvailable = testDatabaseAvailable();
const redisAvailable = await testRedisAvailable();

const ACTIVE_KEY = "ralph:active";
const RECONCILED_KEY = "ralph:reconciled";
const BACKOFF_KEY = "ralph:backoff";
const MINUTE = 60_000;

const cron = async () =>
  (await GET(
    new Request("http://localhost/api/cron/ralph-reconcile", {
      headers: { authorization: "Bearer cron-secret" },
    }),
  ).then((res) => res.json())) as Record<string, unknown>;

describe.skipIf(!databaseAvailable || !redisAvailable)("ralph reconcile marker", () => {
  let testDb: TestDatabase;
  let testRedis: TestRedis;
  let db: Database;
  let organizationId: string;
  /** Postgres calls made through `state.db` (the route's `getDb()`). */
  let postgresCalls = 0;

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
    const [org] = await db.insert(organizations).values({ name: "Ralphco" }).returning();
    organizationId = org!.id;
  }, 180_000);

  afterAll(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await closeRedis();
    if (db) await closeDb(db);
    await Promise.all([testDb?.stop(), testRedis?.stop()]);
  });

  beforeEach(async () => {
    vi.stubEnv("REDIS_URL", testRedis.url);
    await closeRedis();
    await getRedis().flushdb();
    await db.delete(ralphRuns);
    state.runs = 0;
    state.during = undefined;
    // Only `Date`: the cron's schedule is simulated, Redis and Postgres keep real timers.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 9, 28, 12) });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** The cron's next invocation, `minutes` (10: its schedule) after the clock. */
  async function cronIn(minutes = 10) {
    vi.setSystemTime(Date.now() + minutes * MINUTE);
    return cron();
  }

  /**
   * Invokes the cron every 10 minutes for `minutes`; returns the minutes (from now) of
   * the invocations that ran a pass, and checks the others didn't query Postgres.
   */
  async function schedule(minutes: number) {
    const ran: number[] = [];
    for (let at = 10; at <= minutes; at += 10) {
      const before = state.runs;
      postgresCalls = 0;
      const body = await cronIn();
      if (state.runs > before) ran.push(at);
      else {
        expect(body).toEqual({ skipped: true });
        expect(postgresCalls).toBe(0);
      }
    }
    return ran;
  }

  /** A run waiting on a blocker: work the cron must keep checking. */
  async function waitingRun() {
    const { run } = await createRun(db, {
      organizationId,
      linearIssueId: `issue-${randomUUID()}`,
      linearIdentifier: "TOOL-1",
      linearAgentSessionId: `session-${randomUUID()}`,
      kind: "children",
      repositoryId: null,
      status: "waiting",
    });
    return run;
  }

  /** Brings Redis to idle: a full run that found no work. */
  async function idle() {
    await cron();
    expect(await getRedis().exists(EPOCH_KEY)).toBe(1);
    expect(await getRedis().exists(ACTIVE_KEY)).toBe(0);
    expect(await getRedis().exists(RECONCILED_KEY)).toBe(1);
    state.runs = 0;
  }

  it("skips without querying Postgres while the marker is absent", async () => {
    await idle();
    postgresCalls = 0;
    expect(await cron()).toEqual({ skipped: true });
    expect(await cron()).toEqual({ skipped: true });
    expect(state.runs).toBe(0);
    expect(postgresCalls).toBe(0);
  });

  it("runs once marked, then clears the marker after a run that found no work", async () => {
    await idle();
    await markRalphActive();
    expect(await cron()).toMatchObject({ organizations: 0 });
    expect(state.runs).toBe(1);
    expect(await getRedis().exists(ACTIVE_KEY)).toBe(0);
    expect(await cron()).toEqual({ skipped: true });
    expect(state.runs).toBe(1);
  });

  it("keeps the marker while there's ralph work, and clears it once there's none", async () => {
    await idle();
    const run = await waitingRun();
    await markRalphActive();
    await cron();
    await cronIn();
    expect(state.runs).toBe(2);
    expect(await getRedis().exists(ACTIVE_KEY)).toBe(1);

    await db.update(ralphRuns).set({ status: "completed" }).where(eq(ralphRuns.id, run.id));
    await markRalphActive();
    await cronIn();
    expect(state.runs).toBe(3);
    expect(await getRedis().exists(ACTIVE_KEY)).toBe(0);
    expect(await getRedis().exists(BACKOFF_KEY)).toBe(0);
    expect(await cronIn()).toEqual({ skipped: true });
  });

  it("keeps a marker set during the run", async () => {
    await idle();
    await markRalphActive();
    state.during = markRalphActive;
    await cron();
    expect(await getRedis().exists(ACTIVE_KEY)).toBe(1);
    await cron();
    expect(state.runs).toBe(2);
    expect(await getRedis().exists(ACTIVE_KEY)).toBe(0);
  });

  it("does a full run once a day regardless of the marker", async () => {
    await idle();
    expect(await getRedis().ttl(RECONCILED_KEY)).toBeGreaterThan(24 * 3600 - 60);
    // A day after the last full run.
    await getRedis().del(RECONCILED_KEY);
    postgresCalls = 0;
    expect(await cron()).toMatchObject({ organizations: 0 });
    expect(state.runs).toBe(1);
    expect(postgresCalls).toBeGreaterThan(0);
    expect(await getRedis().exists(ACTIVE_KEY)).toBe(0);
    expect(await cron()).toEqual({ skipped: true });

    // A forced run that finds work nobody marked keeps the cron running.
    await waitingRun();
    await getRedis().del(RECONCILED_KEY);
    await cron();
    expect(await getRedis().exists(ACTIVE_KEY)).toBe(1);
    await cronIn();
    expect(state.runs).toBe(3);
  });

  it("backs off from every 10 minutes to every hour while passes change nothing", async () => {
    await idle();
    await waitingRun();
    await markRalphActive();
    // Intervals of 10, 20, 40, then 60 minutes.
    expect(await schedule(190)).toEqual([10, 20, 40, 80, 140]);
  });

  it("starts again at 10 minutes after a change from outside the cron", async () => {
    await idle();
    await waitingRun();
    await markRalphActive();
    await schedule(80);
    // Backed off to an hour; a webhook or UI action marks ralph work.
    await markRalphActive();
    expect(await schedule(30)).toEqual([10, 20]);
  });

  it("keeps a reset by a change from outside the cron during a pass", async () => {
    await idle();
    await waitingRun();
    await markRalphActive();
    expect(await schedule(30)).toEqual([10, 20]);
    // The pass at 40 minutes: a webhook marks meanwhile.
    state.during = markRalphActive;
    // Without the reset: [10, 50].
    expect(await schedule(50)).toEqual([10, 20, 40]);
  });

  it("starts again at 10 minutes after a pass that changed something", async () => {
    await idle();
    const run = await waitingRun();
    await markRalphActive();
    expect(await schedule(30)).toEqual([10, 20]);
    // The pass at 40 minutes advances the run (and, as `advanceRun` does, marks it).
    state.during = () =>
      runReconcilePass(async () => {
        await db
          .update(ralphRuns)
          .set({ waitingOn: { blockers: [], manual: [] } })
          .where(eq(ralphRuns.id, run.id));
        await markRalphActive();
      });
    // Without the reset: [10, 50].
    expect(await schedule(50)).toEqual([10, 20, 40]);
  });

  it("doesn't reset the backoff for the cron's own marks", async () => {
    await idle();
    await waitingRun();
    await markRalphActive();
    expect(await schedule(30)).toEqual([10, 20]);
    state.during = () => runReconcilePass(markRalphActive);
    // Intervals of 40, then 60 minutes, as without the marks.
    expect(await schedule(60)).toEqual([10, 50]);
  });

  it("runs a pass when the backoff is lost, and the daily full pass while backed off", async () => {
    await idle();
    await waitingRun();
    await markRalphActive();
    await schedule(80);
    await getRedis().del(BACKOFF_KEY);
    expect(await schedule(20)).toEqual([10, 20]);
    expect(await schedule(10)).toEqual([]);
    await getRedis().del(RECONCILED_KEY);
    expect(await schedule(10)).toEqual([10]);
  });

  it("marks ralph work when a run advances", async () => {
    await idle();
    const run = await waitingRun();
    // Gone or not, the advance marks: the cron decides.
    await advanceRun(randomUUID(), { db } as RalphDeps);
    expect(await getRedis().exists(ACTIVE_KEY)).toBe(1);
    await getRedis().del(ACTIVE_KEY);
    await db.update(ralphRuns).set({ status: "completed" }).where(eq(ralphRuns.id, run.id));
    expect((await advanceRun(run.id, { db } as RalphDeps)).action).toBe("finished");
    expect(await getRedis().exists(ACTIVE_KEY)).toBe(1);
  });

  it("runs after Redis was flushed", async () => {
    await idle();
    await getRedis().flushdb();
    await cron();
    expect(state.runs).toBe(1);
  });

  it("runs every time without Redis", async () => {
    vi.stubEnv("REDIS_URL", "");
    await closeRedis();
    await cron();
    await cron();
    expect(state.runs).toBe(2);
  });
});
