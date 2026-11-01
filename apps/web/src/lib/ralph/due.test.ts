import { randomBytes, randomUUID } from "node:crypto";
import {
  closeDb,
  connectRepository,
  createDb,
  createRun,
  ensureLane,
  getLane,
  insertJob,
  jobs,
  organizations,
  ralphRuns,
  repositories,
  updateLane,
  upsertScmConnection,
  type Database,
  type Job,
  type RalphLane,
  type RalphLaneCleanup,
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
import type * as TrackerClient from "@/lib/tracker/client";
import type * as ReconcileCron from "./reconcile-cron";
import type * as Run from "./run";
import type * as Sinks from "@/lib/sinks";
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
  /** Whether looking up a job's outcome hooks throws (a hook that never runs). */
  hooksFail: false,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/dispatch", () => ({ getDispatcher: () => ({}) }));
vi.mock("@/lib/tracker/client", async (importOriginal) => {
  const actual = await importOriginal<typeof TrackerClient>();
  return {
    ...actual,
    getTrackerGateway: async ({ organizationId }: { organizationId: string }) => {
      if (!state.linearConnected.has(organizationId)) throw new actual.TrackerNotConnectedError();
      return {};
    },
    getTrackerGatewayOrDisconnected: async () => actual.disconnectedTrackerGateway(),
    lazyTrackerGateway: () => actual.disconnectedTrackerGateway(),
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
vi.mock("@/lib/sinks", async (importOriginal) => {
  const actual = await importOriginal<typeof Sinks>();
  return {
    ...actual,
    jobHooks: (...args: Parameters<typeof actual.jobHooks>) => {
      if (state.hooksFail) throw new Error("killed before the hook");
      return actual.jobHooks(...args);
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
  RALPH_RETRY_MS,
  RALPH_SAFETY_MS,
  RALPH_WAITING_MS,
  RECONCILE_STALE_MS,
  laneDueAt,
  runDueAt,
  scheduleJobOutcomeCheck,
  scheduleLane,
  scheduleRun,
} = await import("./due");
const { advanceRun } = await import("./run");
const { cleanupDedupeKey, recordClosedPullRequest } = await import("./cleanup");
const { onRalphCleanupJobFinished } = await import("./jobs");
const { GET } = await import("@/app/api/cron/ralph-reconcile/route");
const { GET: expireJobs } = await import("@/app/api/cron/expire-jobs/route");

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

describe("laneDueAt", () => {
  const cleanup = (fields: Partial<RalphLaneCleanup>) => ({
    cleanup: {
      status: "done",
      at: "",
      mergedSha: "a",
      questions: [],
      ...fields,
    } as RalphLaneCleanup,
  });
  const branch = {
    kind: "branch" as const,
    commits: 2,
    askedAt: new Date(NOW).toISOString(),
    deadline: new Date(NOW + 30 * MINUTE).toISOString(),
  };
  const stashes = { kind: "stashes" as const, shas: ["s"], askedAt: new Date(NOW).toISOString() };

  it("schedules nothing while a cleanup job is in flight or waits for the run's job", () => {
    expect(laneDueAt(cleanup({ status: "running", jobId: "j" }), NOW)).toBeNull();
    expect(laneDueAt(cleanup({ questions: [branch], jobId: "j" }), NOW)).toBeNull();
    expect(laneDueAt(cleanup({ status: "pending" }), NOW)).toBeNull();
  });

  it("retries a failed cleanup in an hour", () => {
    expect(laneDueAt(cleanup({ status: "failed" }), NOW)).toBe(NOW + RALPH_RETRY_MS);
  });

  it("checks a kept branch at its question's deadline", () => {
    expect(laneDueAt(cleanup({ questions: [stashes, branch] }), NOW)).toBe(NOW + 30 * MINUTE);
  });

  it("schedules nothing for a lane without cleanup, done, or only asked about stashes", () => {
    expect(laneDueAt({ cleanup: null }, NOW)).toBeNull();
    expect(laneDueAt(cleanup({}), NOW)).toBeNull();
    expect(laneDueAt(cleanup({ questions: [stashes] }), NOW)).toBeNull();
  });
});

describe.skipIf(!databaseAvailable || !redisAvailable)("ralph reconcile schedule", () => {
  let testDb: TestDatabase;
  let testRedis: TestRedis;
  let db: Database;
  let organizationId: string;
  let repositoryId: string;
  /** A repository that was disconnected: a cleanup job can't be enqueued there. */
  let disconnectedRepositoryId: string;
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
    const connection = (await upsertScmConnection(
      db,
      {
        organizationId,
        provider: "github",
        name: "ralphco",
        baseUrl: "https://api.github.com",
        externalId: "1",
        credentials: {},
      },
      randomBytes(32),
    ))!;
    const connect = (externalId: string) =>
      connectRepository(db, {
        connectionId: connection.id,
        provider: "github",
        externalId,
        fullPath: `ralphco/repo-${externalId}`,
      });
    repositoryId = (await connect("1")).id;
    disconnectedRepositoryId = (await connect("2")).id;
    await db
      .update(repositories)
      .set({ disconnectedAt: new Date() })
      .where(eq(repositories.id, disconnectedRepositoryId));
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
    state.hooksFail = false;
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
      trackerIssueId: `issue-${randomUUID()}`,
      trackerIdentifier: "TOOL-1",
      trackerSessionId: `session-${randomUUID()}`,
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

  const laneScore = async (laneId: string) => {
    const value = await getRedis().zscore(DUE_KEY, `lane:${laneId}`);
    return value === null ? null : Number(value);
  };

  /** A lane of a completed run, with `cleanup` and its PR/MR state. */
  async function newLane(
    cleanup: Partial<RalphLaneCleanup> | null,
    fields: Partial<Pick<RalphLane, "prClosed" | "prMerged" | "repositoryId">> = {},
  ): Promise<RalphLane> {
    const run = await newRun("completed");
    const lane = await ensureLane(db, {
      runId: run.id,
      repositoryId: fields.repositoryId ?? repositoryId,
      branch: `omniralph/${run.id}`,
      baseBranch: "main",
    });
    return (await updateLane(db, lane.id, {
      prNumber: 7,
      prClosed: fields.prClosed ?? true,
      prMerged: fields.prMerged ?? true,
      cleanup: cleanup && {
        status: "done",
        at: new Date(NOW).toISOString(),
        mergedSha: "a".repeat(40),
        questions: [],
        ...cleanup,
      },
    }))!;
  }

  const branchQuestion = (deadline: number) => ({
    kind: "branch" as const,
    commits: 2,
    askedAt: new Date(NOW - 60 * MINUTE).toISOString(),
    deadline: new Date(deadline).toISOString(),
  });

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
    await scheduleLane(randomUUID(), NOW + 55 * MINUTE);
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

    expect(await cron()).toEqual({
      due: { reconciled: 1, failed: 0 },
      dueLanes: { checked: 0, started: 0, expired: 0, failed: 0 },
    });
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
    const tracker = await newRun("waiting", { organizationId: other!.id });
    await scheduleRun(chat.id, NOW);
    await scheduleRun(tracker.id, NOW);

    await cron();
    expect(state.advanced).toEqual([chat.id]);
    expect(await score(chat.id)).toBeNull();
    expect(await score(tracker.id)).toBeNull();
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
    await scheduleJobOutcomeCheck({ ralphRunId: runId, dedupeKey: "something-else" });
    expect(await score(runId)).toBe(NOW + RALPH_SAFETY_MS);
    await scheduleJobOutcomeCheck({ ralphRunId: null });
    expect(await getRedis().zcard(DUE_KEY)).toBe(1);
  });

  it("schedules a cleanup job's lane too before its outcome commits", async () => {
    const runId = randomUUID();
    const laneId = randomUUID();
    await scheduleJobOutcomeCheck({ ralphRunId: runId, dedupeKey: cleanupDedupeKey(laneId) });
    expect(await score(runId)).toBe(NOW + RALPH_SAFETY_MS);
    expect(await laneScore(laneId)).toBe(NOW + RALPH_SAFETY_MS);
  });

  it("schedules an expired ralph job's run before its outcome hook runs", async () => {
    const run = await newRun("completed");
    const { job } = await insertJob(db, {
      organizationId,
      type: "worktree.exec",
      taskType: "system",
      ralphRunId: run.id,
    });
    await db
      .update(jobs)
      .set({ createdAt: new Date(NOW - 2 * 24 * 60 * MINUTE) })
      .where(eq(jobs.id, job.id));
    state.hooksFail = true;
    const response = await expireJobs(
      new Request("http://localhost/api/cron/expire-jobs", {
        headers: { authorization: "Bearer cron-secret" },
      }),
    );
    expect(await response.json()).toEqual({ expired: 1 });
    expect(await score(run.id)).toBe(NOW + RALPH_SAFETY_MS);
  });

  it("checks only the due lanes, and reschedules each from what's left", async () => {
    await idle();
    const done = await newLane({});
    const asked = await newLane({ questions: [branchQuestion(NOW + 30 * MINUTE)] });
    const later = await newLane({ status: "failed" });
    const gone = randomUUID();
    // Safety checks of cleanup jobs' outcomes, applied meanwhile.
    for (const laneId of [done.id, asked.id, gone]) await scheduleLane(laneId, NOW - MINUTE);
    await scheduleLane(later.id, NOW + MINUTE);

    expect(await cron()).toEqual({
      due: { reconciled: 0, failed: 0 },
      dueLanes: { checked: 2, started: 0, expired: 0, failed: 0 },
    });
    expect(state.fullPasses).toBe(0);
    expect(state.advanced).toEqual([]);
    expect(await laneScore(done.id)).toBeNull();
    expect(await laneScore(asked.id)).toBe(NOW + 30 * MINUTE);
    expect(await laneScore(gone)).toBeNull();
    expect(await laneScore(later.id)).toBe(NOW + MINUTE);
  });

  it("retries a kept branch's deletion it couldn't start in an hour", async () => {
    await idle();
    const lane = await newLane(
      { questions: [branchQuestion(NOW - MINUTE)] },
      { repositoryId: disconnectedRepositoryId },
    );
    await scheduleLane(lane.id, NOW - MINUTE);
    expect(await cron()).toMatchObject({
      dueLanes: { checked: 1, started: 0, expired: 0, failed: 0 },
    });
    expect(await laneScore(lane.id)).toBe(NOW + RALPH_RETRY_MS);
  });

  it("checks a closed PR's lane again when its cleanup failed to start", async () => {
    await idle();
    const lane = await newLane(null, { prClosed: false, prMerged: false });
    // The run's lock fails: the lane is recorded closed, but its cleanup doesn't start.
    const broken = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "transaction") return () => Promise.reject(new Error("Postgres blip"));
        return Reflect.get(target, property, receiver);
      },
    });
    await recordClosedPullRequest({ db: broken } as unknown as RalphDeps, lane, {
      state: "closed",
      headSha: "b".repeat(40),
      mergeSha: null,
    } as never);
    expect((await getLane(db, lane.id))?.cleanup).toBeNull();
    expect(await laneScore(lane.id)).toBe(NOW + RALPH_SAFETY_MS);

    vi.setSystemTime(NOW + RALPH_SAFETY_MS);
    expect(await cron()).toMatchObject({ dueLanes: { checked: 1, failed: 0 } });
    // The lane never ran a job on an agent: its keep-branch cleanup has nothing to remove.
    expect((await getLane(db, lane.id))?.cleanup).toMatchObject({
      status: "done",
      keepBranch: "closed",
    });
    expect(await laneScore(lane.id)).toBeNull();
  });

  it("replaces a cleanup job's safety check from its lane once its outcome is handled", async () => {
    const lane = await newLane({ questions: [branchQuestion(NOW + 30 * MINUTE)] });
    const job = {
      id: randomUUID(),
      type: "worktree.cleanup",
      status: "completed",
      ralphRunId: lane.runId,
      dedupeKey: cleanupDedupeKey(lane.id),
      payload: {},
      result: {},
    } as unknown as Job;
    await scheduleJobOutcomeCheck(job);
    await onRalphCleanupJobFinished(db, job, {
      db,
      organizationId,
      adapterFor: () => {
        throw new Error("no code host here");
      },
    } as unknown as RalphDeps);
    expect(await laneScore(lane.id)).toBe(NOW + 30 * MINUTE);
    // The run is completed: its safety check is gone too.
    expect(await score(lane.runId)).toBeNull();
  });

  it("does the full pass once per daily window, then the runs still due", async () => {
    await idle();
    expect(Number(await getRedis().get(RECONCILED_KEY))).toBe(Date.UTC(2026, 9, 28, 3, 15));
    // Between windows: no full pass, only the due entries.
    vi.setSystemTime(Date.UTC(2026, 9, 29, 3, 10));
    const run = await newRun("completed");
    await scheduleRun(run.id, Date.now());
    expect(await cron()).toEqual({
      due: { reconciled: 1, failed: 0 },
      dueLanes: expect.anything(),
    });
    expect(state.fullPasses).toBe(0);
    // The first invocation at or after the window's start does it, once.
    vi.setSystemTime(Date.UTC(2026, 9, 29, 3, 20));
    const late = await newRun("completed");
    await scheduleRun(late.id, Date.now());
    expect(await cron()).toMatchObject({ organizations: 0, due: { reconciled: 1, failed: 0 } });
    expect(state.fullPasses).toBe(1);
    expect(state.advanced).toEqual([run.id, late.id]);
    expect(Number(await getRedis().get(RECONCILED_KEY))).toBe(Date.UTC(2026, 9, 29, 3, 15));
    vi.setSystemTime(Date.UTC(2026, 9, 29, 3, 30));
    expect(await cron()).toEqual({ skipped: true });
    vi.setSystemTime(Date.UTC(2026, 9, 30, 3, 14));
    expect(await cron()).toEqual({ skipped: true });
    expect(state.fullPasses).toBe(1);
  });

  it("makes up a window's full pass at the next invocation when the first one didn't run", async () => {
    await idle();
    // No invocation at 03:20 or for the rest of the day: the next one, a day later, does it.
    vi.setSystemTime(Date.UTC(2026, 9, 30, 2, 0));
    expect(await cron()).toMatchObject({ organizations: 0 });
    expect(state.fullPasses).toBe(1);
    expect(Number(await getRedis().get(RECONCILED_KEY))).toBe(Date.UTC(2026, 9, 29, 3, 15));
    expect(await cron()).toEqual({ skipped: true });
    // The next window is still at its start.
    vi.setSystemTime(Date.UTC(2026, 9, 30, 3, 15));
    await cron();
    expect(state.fullPasses).toBe(2);
  });

  it("rebuilds the schedule: unfinished runs and waiting or failed cleanups now, kept branches at their deadline", async () => {
    const runs = await Promise.all(
      (["pending", "running", "waiting"] as const).map((status) => newRun(status)),
    );
    const done = await Promise.all(
      (["completed", "failed", "stopped"] as const).map((status) => newRun(status)),
    );
    const lanes = {
      pending: await newLane({ status: "pending" }),
      failed: await newLane({ status: "failed" }),
      asked: await newLane({ questions: [branchQuestion(NOW + 30 * MINUTE)] }),
      done: await newLane({}),
      open: await newLane(null, { prClosed: false, prMerged: false }),
    };
    await scheduleRun(done[0]!.id, NOW + MINUTE);
    await scheduleLane(lanes.done.id, NOW + MINUTE);
    await getRedis().del(EPOCH_KEY);
    expect(await ensureHotStateEpoch(getRedis(), db)).toBe(true);
    for (const run of runs) expect(await score(run.id)).toBe(NOW);
    for (const run of done) expect(await score(run.id)).toBeNull();
    expect(await laneScore(lanes.pending.id)).toBe(NOW);
    expect(await laneScore(lanes.failed.id)).toBe(NOW);
    expect(await laneScore(lanes.asked.id)).toBe(NOW + 30 * MINUTE);
    expect(await laneScore(lanes.done.id)).toBeNull();
    expect(await laneScore(lanes.open.id)).toBeNull();
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
