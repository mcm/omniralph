import { randomBytes } from "node:crypto";
import {
  closeDb,
  completeJob,
  claimJob,
  connectRepository,
  createDb,
  createRun,
  getJob,
  agents,
  hiddenRefs,
  jobs,
  organizations,
  ralphRuns,
  recordHiddenRef,
  upsertScmConnection,
  type Database,
  type RalphRunStatus,
} from "@omniralph/db";
import {
  CODING_TASKS_MIN_HARNESS_VERSION,
  MAX_JOB_DELIVERIES,
  ralphHiddenRef,
  WorktreeCleanupPayload,
  type WorktreeCleanupResult,
} from "@omniralph/shared";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ db: undefined as unknown as Database }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/dispatch", async () => {
  const { PostgresDispatcher } = await import("@/lib/dispatch/dispatcher");
  return { getDispatcher: () => new PostgresDispatcher({ db: state.db }) };
});

process.env.CRON_SECRET = "cron-secret";

const { GET: pruneRoute } = await import("./prune-hidden-refs/route");
const { applyHiddenRefsJob, HIDDEN_REF_MAX_AGE_DAYS } = await import("@/lib/ralph/hidden-refs");

const databaseAvailable = testDatabaseAvailable();

function cronRequest(secret?: string) {
  return new Request("http://localhost/api/cron/prune-hidden-refs", {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);
const sha = (n: number) => n.toString(16).padStart(40, "0");

describe.skipIf(!databaseAvailable)("GET /api/cron/prune-hidden-refs", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let repoId: string;
  let otherRepoId: string;
  let harnessId: string;
  let seq = 0;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
    const connection = (await upsertScmConnection(
      db,
      {
        organizationId: orgId,
        provider: "gitlab",
        name: "acme",
        baseUrl: "https://gitlab.example.com",
        externalId: "1",
        credentials: {},
      },
      randomBytes(32),
    ))!;
    const repo = (externalId: string, fullPath: string) =>
      connectRepository(db, {
        connectionId: connection.id,
        provider: "gitlab",
        externalId,
        fullPath,
      });
    repoId = (await repo("1", "acme/api")).id;
    otherRepoId = (await repo("2", "acme/web")).id;
    [{ id: harnessId }] = (await db
      .insert(agents)
      .values({ organizationId: orgId, name: "coder-1" })
      .returning({ id: agents.id })) as [{ id: string }];
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    await db.delete(jobs);
    await db.delete(ralphRuns);
  });

  /** A run in `status` with its hidden ref in `repositories`, pushed `age` days ago. */
  async function runWithRef(
    status: RalphRunStatus,
    age: number,
    repositories = [repoId],
  ): Promise<{ runId: string; ref: string }> {
    seq += 1;
    const { run } = await createRun(db, {
      organizationId: orgId,
      linearIssueId: `issue-${seq}`,
      linearIdentifier: `ENG-${seq}`,
      linearAgentSessionId: `session-${seq}`,
      kind: "children",
      repositoryId: repoId,
      branch: `feat/eng-${seq}`,
      baseBranch: "main",
    });
    await db.update(ralphRuns).set({ status }).where(eq(ralphRuns.id, run.id));
    const ref = ralphHiddenRef(run.id);
    for (const repositoryId of repositories) {
      await recordHiddenRef(db, { repositoryId, runId: run.id, ref, sha: sha(seq) });
    }
    await db
      .update(hiddenRefs)
      .set({ createdAt: daysAgo(age) })
      .where(eq(hiddenRefs.runId, run.id));
    return { runId: run.id, ref };
  }

  const queuedDeletions = async () =>
    (await db.select().from(jobs)).map((job) => {
      const payload = WorktreeCleanupPayload.parse(job.payload);
      return {
        runId: job.ralphRunId,
        repositoryId: job.repositoryId,
        type: job.type,
        taskType: job.taskType,
        targetHarnessId: job.targetAgentId,
        action: payload.action,
        hiddenRefs: payload.hiddenRefs,
      };
    });

  const deletion = (runId: string, ref: string, repositoryId = repoId) => ({
    runId,
    repositoryId,
    type: "worktree.cleanup",
    taskType: "system",
    targetHarnessId: null,
    action: undefined,
    hiddenRefs: [ref],
  });

  it("enqueues the deletion of refs of ended runs, and of old ones whose run isn't running", async () => {
    const completed = await runWithRef("completed", 0, [repoId, otherRepoId]);
    const failed = await runWithRef("failed", 1);
    const oldStopped = await runWithRef("stopped", HIDDEN_REF_MAX_AGE_DAYS + 1);
    const oldWaiting = await runWithRef("waiting", HIDDEN_REF_MAX_AGE_DAYS + 1);
    // Kept: a stopped run may resume from its ref; a running one is using it.
    await runWithRef("stopped", HIDDEN_REF_MAX_AGE_DAYS - 1);
    await runWithRef("running", HIDDEN_REF_MAX_AGE_DAYS + 30);
    const gone = await runWithRef("completed", 30);
    await db
      .update(hiddenRefs)
      .set({ deletedAt: new Date() })
      .where(eq(hiddenRefs.runId, gone.runId));

    const res = await pruneRoute(cronRequest("cron-secret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ refs: 5, enqueued: 5, failed: 0 });
    expect(await queuedDeletions()).toEqual(
      expect.arrayContaining([
        deletion(completed.runId, completed.ref),
        deletion(completed.runId, completed.ref, otherRepoId),
        deletion(failed.runId, failed.ref),
        deletion(oldStopped.runId, oldStopped.ref),
        deletion(oldWaiting.runId, oldWaiting.ref),
      ]),
    );
    expect(await queuedDeletions()).toHaveLength(5);

    // A deletion under way isn't enqueued twice.
    await pruneRoute(cronRequest("cron-secret"));
    expect(await queuedDeletions()).toHaveLength(5);
  });

  it("marks the refs the result reports deleted, and sweeps the others again", async () => {
    const { runId, ref } = await runWithRef("completed", 0);
    await pruneRoute(cronRequest("cron-secret"));
    const [queued] = await db.select().from(jobs);
    const { claim } = await claimJob(db, {
      organizationId: orgId,
      agentId: harnessId,
      acceptedTaskTypes: ["query", "coding"],
      pools: ["short", "long"],
      agentVersion: CODING_TASKS_MIN_HARNESS_VERSION,
      maxDeliveries: MAX_JOB_DELIVERIES,
    });
    expect(claim?.job.id).toBe(queued!.id);
    const result = (deletedRefs: string[]): WorktreeCleanupResult => ({
      error: null,
      removedWorktree: false,
      hadBranch: false,
      stashed: null,
      unmerged: 0,
      stashes: [],
      handled: 0,
      deletedRefs,
      durationMs: 5,
    });

    // A ref it wasn't asked to delete is ignored; one it couldn't delete stays for the sweep.
    await completeJob(db, {
      jobId: queued!.id,
      agentId: harnessId,
      result: { ...result([ralphHiddenRef(crypto.randomUUID())]), error: "push rejected" },
    });
    expect(await applyHiddenRefsJob(db, (await getJob(db, queued!.id))!)).toBe(0);
    await pruneRoute(cronRequest("cron-secret"));
    const [, again] = await db.select().from(jobs).orderBy(jobs.createdAt);
    expect(again).toBeDefined();
    await claimJob(db, {
      organizationId: orgId,
      agentId: harnessId,
      acceptedTaskTypes: ["query", "coding"],
      pools: ["short", "long"],
      agentVersion: CODING_TASKS_MIN_HARNESS_VERSION,
      maxDeliveries: MAX_JOB_DELIVERIES,
    });
    await completeJob(db, { jobId: again!.id, agentId: harnessId, result: result([ref]) });
    expect(await applyHiddenRefsJob(db, (await getJob(db, again!.id))!)).toBe(1);

    const [row] = await db.select().from(hiddenRefs).where(eq(hiddenRefs.runId, runId));
    expect(row?.deletedAt).toBeInstanceOf(Date);
    expect(await (await pruneRoute(cronRequest("cron-secret"))).json()).toEqual({
      refs: 0,
      enqueued: 0,
      failed: 0,
    });
  });

  it("requires CRON_SECRET", async () => {
    await runWithRef("completed", 0);
    expect((await pruneRoute(cronRequest())).status).toBe(401);
    expect((await pruneRoute(cronRequest("wrong"))).status).toBe(401);
    expect(await db.select().from(jobs)).toEqual([]);
  });
});
