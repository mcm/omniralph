import { randomUUID } from "node:crypto";
import {
  closeDb,
  createDb,
  createRun,
  organizations,
  ralphRuns,
  type Database,
  type RalphRun,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestRedis, testRedisAvailable, type TestRedis } from "@/lib/hot-state/testing";
import type * as LinearClient from "@/lib/linear/client";
import type * as ReconcileCron from "./reconcile-cron";
import type * as Run from "./run";
import type { AdvanceResult, RalphDeps } from "./run";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  /** Full passes. */
  fullPasses: 0,
  /** Runs the cron advanced, in order. */
  advanced: [] as string[],
  /** Organizations with Linear connected. */
  linearConnected: new Set<string>(),
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/dispatch", () => ({ getDispatcher: () => ({}) }));
vi.mock("@/lib/linear/client", async (importOriginal) => {
  const actual = await importOriginal<typeof LinearClient>();
  return {
    ...actual,
    getLinearGateway: async ({ organizationId }: { organizationId: string }) => {
      if (!state.linearConnected.has(organizationId)) throw new actual.LinearNotConnectedError();
      return {};
    },
    getLinearGatewayOrDisconnected: async () => actual.disconnectedLinearGateway(),
  };
});
vi.mock("@/lib/ralph/run", async (importOriginal) => {
  const actual = await importOriginal<typeof Run>();
  return {
    ...actual,
    advanceRun: (runId: string, deps: RalphDeps) => {
      state.advanced.push(runId);
      return actual.advanceRun(runId, deps);
    },
  };
});
vi.mock("@/lib/ralph/reconcile-cron", async (importOriginal) => {
  const actual = await importOriginal<typeof ReconcileCron>();
  return {
    ...actual,
    reconcileAllOrganizations: async () => {
      state.fullPasses += 1;
      return { organizations: 0, reconciled: 0, failed: 0 };
    },
  };
});

process.env.CRON_SECRET = "cron-secret";
const { EPOCH_KEY, closeRedis, ensureHotStateEpoch, getRedis } = await import("@/lib/hot-state");
const {
  RALPH_SAFETY_MS,
  RALPH_WAITING_MS,
  RECONCILE_STALE_MS,
  runDueAt,
  scheduleJobOutcomeCheck,
  scheduleRun,
} = await import("./due");
const { advanceRun } = await import("./run");
const { GET } = await import("@/app/api/cron/ralph-reconcile/route");

const databaseAvailable = testDatabaseAvailable();
const redisAvailable = await testRedisAvailable();

const DUE_KEY = "ralph:due";
const RECONCILED_KEY = "ralph:reconciled";
const NOW = Date.UTC(2026, 9, 28, 12);
const MINUTE = 60_000;

describe("runDueAt", () => {
  const run = (status: RalphRun["status"]) => ({ status }) as RalphRun;
  const at = (result: unknown) => runDueAt(result as AdvanceResult, NOW);

  it("schedules nothing while a job is in flight: its outcome advances the run", () => {
    for (const action of ["busy", "enqueued", "pushing", "describing", "preparing", "requesting"]) {
      expect(at({ action, run: run("running"), jobId: "j" })).toBeNull();
    }
  });

  it("removes a finished or gone run", () => {
    expect(at({ action: "gone" })).toBeNull();
    expect(at({ action: "finished", run: run("stopped") })).toBeNull();
    expect(at({ action: "completed", run: run("completed") })).toBeNull();
    expect(at({ action: "failed", run: run("failed") })).toBeNull();
  });

  it("re-checks a waiting run hourly, a pending or running one without a job when stale", () => {
    const waitingOn = { blockers: [], manual: [] };
    expect(at({ action: "waiting", run: run("waiting"), waitingOn })).toBe(NOW + RALPH_WAITING_MS);
    expect(at({ action: "waiting", run: run("pending"), waitingOn })).toBe(
      NOW + RECONCILE_STALE_MS,
    );
    expect(at({ action: "waiting", run: run("running"), waitingOn })).toBe(
      NOW + RECONCILE_STALE_MS,
    );
  });
});

describe.skipIf(!databaseAvailable || !redisAvailable)("ralph reconcile schedule", () => {
  let testDb: TestDatabase;
  let testRedis: TestRedis;
  let db: Database;
  let organizationId: string;
  /** Postgres calls made through `state.db` (the route's `getDb()`). */
  let postgresCalls = 0;

  const cron = async () =>
    (await GET(
      new Request("http://localhost/api/cron/ralph-reconcile", {
        headers: { authorization: "Bearer cron-secret" },
      }),
    ).then((res) => res.json())) as Record<string, unknown>;

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
    state.fullPasses = 0;
    state.advanced = [];
    state.linearConnected = new Set([organizationId]);
    // Only `Date`: Redis and Postgres keep real timers.
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function newRun(
    status: RalphRun["status"],
    options: { origin?: RalphRun["origin"]; organizationId?: string } = {},
  ) {
    const { run } = await createRun(db, {
      organizationId: options.organizationId ?? organizationId,
      linearIssueId: `issue-${randomUUID()}`,
      linearIdentifier: "TOOL-1",
      linearAgentSessionId: `session-${randomUUID()}`,
      kind: "children",
      repositoryId: null,
      status,
    });
    if (options.origin === "chat") {
      await db
        .update(ralphRuns)
        .set({ origin: "chat", mode: "request" })
        .where(eq(ralphRuns.id, run.id));
    }
    return run;
  }

  const score = async (runId: string) => {
    const value = await getRedis().zscore(DUE_KEY, `run:${runId}`);
    return value === null ? null : Number(value);
  };

  /** Brings Redis to idle: the epoch built and the day's full pass done. */
  async function idle() {
    await cron();
    expect(await getRedis().exists(EPOCH_KEY)).toBe(1);
    expect(await getRedis().exists(RECONCILED_KEY)).toBe(1);
    state.fullPasses = 0;
    state.advanced = [];
  }

  it("skips without querying Postgres while nothing is due", async () => {
    await idle();
    const run = await newRun("waiting");
    await scheduleRun(run.id, NOW + RALPH_WAITING_MS);
    postgresCalls = 0;
    expect(await cron()).toEqual({ skipped: true });
    vi.setSystemTime(NOW + 50 * MINUTE);
    expect(await cron()).toEqual({ skipped: true });
    expect(postgresCalls).toBe(0);
    expect(state.fullPasses).toBe(0);
    expect(state.advanced).toEqual([]);
  });

  it("advances only the due runs, and reschedules each from its result", async () => {
    await idle();
    const due = await newRun("completed");
    const later = await newRun("completed");
    const gone = randomUUID();
    await scheduleRun(due.id, NOW - MINUTE);
    await scheduleRun(gone, NOW - MINUTE);
    await scheduleRun(later.id, NOW + MINUTE);

    expect(await cron()).toEqual({ due: { reconciled: 1, failed: 0 } });
    expect(state.advanced).toEqual([due.id]);
    expect(state.fullPasses).toBe(0);
    // Finished: off the schedule; gone: removed without an advance.
    expect(await score(due.id)).toBeNull();
    expect(await score(gone)).toBeNull();
    expect(await score(later.id)).toBe(NOW + MINUTE);
  });

  it("advances due chat runs of an organization without Linear, and drops its Linear runs", async () => {
    await idle();
    const [other] = await db.insert(organizations).values({ name: "No Linear" }).returning();
    const chat = await newRun("completed", { origin: "chat", organizationId: other!.id });
    const linear = await newRun("waiting", { organizationId: other!.id });
    await scheduleRun(chat.id, NOW);
    await scheduleRun(linear.id, NOW);

    await cron();
    expect(state.advanced).toEqual([chat.id]);
    expect(await score(chat.id)).toBeNull();
    expect(await score(linear.id)).toBeNull();
  });

  it("keeps the safety check when an advance throws", async () => {
    const run = await newRun("waiting");
    const broken = {
      transaction: () => Promise.reject(new Error("Postgres is down")),
    } as unknown as Database;
    await expect(advanceRun(run.id, { db: broken } as RalphDeps)).rejects.toThrow("down");
    expect(await score(run.id)).toBe(NOW + RALPH_SAFETY_MS);
  });

  it("replaces the safety check with the advance's schedule", async () => {
    const finished = await newRun("stopped");
    await scheduleRun(finished.id, NOW + RALPH_WAITING_MS);
    expect((await advanceRun(finished.id, { db } as RalphDeps)).action).toBe("finished");
    expect(await score(finished.id)).toBeNull();
    const gone = randomUUID();
    expect((await advanceRun(gone, { db } as RalphDeps)).action).toBe("gone");
    expect(await score(gone)).toBeNull();
  });

  it("schedules a ralph job's run before its outcome commits", async () => {
    const runId = randomUUID();
    await scheduleJobOutcomeCheck({ ralphRunId: runId });
    expect(await score(runId)).toBe(NOW + RALPH_SAFETY_MS);
    await scheduleJobOutcomeCheck({ ralphRunId: null });
    expect(await getRedis().zcard(DUE_KEY)).toBe(1);
  });

  it("does the full pass once a day, then the runs still due", async () => {
    await idle();
    const run = await newRun("completed");
    await scheduleRun(run.id, NOW);
    await getRedis().del(RECONCILED_KEY);
    expect(await cron()).toMatchObject({ organizations: 0, due: { reconciled: 1, failed: 0 } });
    expect(state.fullPasses).toBe(1);
    expect(state.advanced).toEqual([run.id]);
    expect(await getRedis().ttl(RECONCILED_KEY)).toBeGreaterThan(24 * 3600 - 60);
    expect(await cron()).toEqual({ skipped: true });
  });

  it("rebuilds the schedule with every unfinished run due now", async () => {
    const runs = await Promise.all(
      (["pending", "running", "waiting"] as const).map((status) => newRun(status)),
    );
    const done = await Promise.all(
      (["completed", "failed", "stopped"] as const).map((status) => newRun(status)),
    );
    await scheduleRun(done[0]!.id, NOW + MINUTE);
    await getRedis().del(EPOCH_KEY);
    expect(await ensureHotStateEpoch(getRedis(), db)).toBe(true);
    for (const run of runs) expect(await score(run.id)).toBe(NOW);
    for (const run of done) expect(await score(run.id)).toBeNull();
  });

  it("does the full pass on every invocation without Redis", async () => {
    vi.stubEnv("REDIS_URL", "");
    await closeRedis();
    expect(await cron()).toMatchObject({ organizations: 0, due: { reconciled: 0, failed: 0 } });
    await cron();
    expect(state.fullPasses).toBe(2);
    expect(state.advanced).toEqual([]);
  });
});
