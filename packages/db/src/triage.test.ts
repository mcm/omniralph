import { createTestDatabase, testDatabaseAvailable, type TestDatabase } from "../testing/index.js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, createDb, type Database } from "./client.js";
import { failCompletedJob, insertJob } from "./jobs.js";
import { jobs, organizations, triageRuns } from "./schema.js";
import {
  createTriageRun,
  finishTriageRunJob,
  getActiveTriageRun,
  listIssueTriageRuns,
  getTriageRun,
  getTriageRunBySession,
  getTriageRunDetail,
  listTriageRuns,
  setTriageRunJob,
  setTriageRunSession,
  setTriageRunStatus,
  replyToTriageRun,
  requeueTriageRunForRetry,
  startTriageRunJob,
  stopTriageRun,
  takeTriageRunPendingReply,
  type NewTriageRunInput,
} from "./triage.js";

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("triage queries", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let otherOrgId: string;
  let session = 0;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    const [other] = await db.insert(organizations).values({ name: "Other" }).returning();
    orgId = org!.id;
    otherOrgId = other!.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    await db.delete(triageRuns);
    await db.delete(jobs);
  });

  const runInput = (overrides: Partial<NewTriageRunInput> = {}): NewTriageRunInput => {
    session += 1;
    return {
      organizationId: orgId,
      linearIssueId: "issue-1",
      linearAgentSessionId: `session-${session}`,
      trigger: "mention",
      ...overrides,
    };
  };

  const triageJob = async () =>
    (
      await insertJob(db, {
        organizationId: orgId,
        type: "triage.run",
        taskType: "query",
      })
    ).job;

  it("creates a queued run with no job or result", async () => {
    const input = runInput({ trigger: "label" });
    const { run, created } = await createTriageRun(db, input);
    expect(created).toBe(true);
    expect(run).toMatchObject({
      ...input,
      status: "queued",
      currentJobId: null,
      lastResult: null,
    });
    expect(run.createdAt).toBeInstanceOf(Date);
    expect(run.updatedAt).toBeInstanceOf(Date);
    expect(await getTriageRun(db, run.id)).toEqual(run);
  });

  it("returns the session's run instead of creating a second one", async () => {
    const input = runInput();
    const { run } = await createTriageRun(db, input);
    await setTriageRunStatus(db, run.id, "completed");
    const again = await createTriageRun(db, { ...input, linearIssueId: "issue-2" });
    expect(again.created).toBe(false);
    expect(again.run.id).toBe(run.id);
    expect(await db.select().from(triageRuns)).toHaveLength(1);
  });

  it("returns the issue's unfinished run instead of starting another", async () => {
    const { run } = await createTriageRun(db, runInput());
    const again = await createTriageRun(db, runInput({ trigger: "label" }));
    expect(again).toMatchObject({ created: false, run: { id: run.id, trigger: "mention" } });

    // Another organization's issue with the same ID is a different issue.
    const elsewhere = await createTriageRun(db, runInput({ organizationId: otherOrgId }));
    expect(elsewhere.created).toBe(true);

    // Once it finished, the issue can be triaged again.
    await setTriageRunStatus(db, run.id, "failed");
    const next = await createTriageRun(db, runInput());
    expect(next.created).toBe(true);
    expect(next.run.id).not.toBe(run.id);
  });

  it("gets a run by its agent session", async () => {
    const { run } = await createTriageRun(db, runInput());
    expect(await getTriageRunBySession(db, run.linearAgentSessionId)).toEqual(run);
    expect(await getTriageRunBySession(db, "session-unknown")).toBeNull();
  });

  it("gets the issue's active run in its organization only", async () => {
    const { run } = await createTriageRun(db, runInput());
    expect((await getActiveTriageRun(db, orgId, "issue-1"))?.id).toBe(run.id);
    expect(await getActiveTriageRun(db, otherOrgId, "issue-1")).toBeNull();
    expect(await getActiveTriageRun(db, orgId, "issue-2")).toBeNull();

    await setTriageRunStatus(db, run.id, "running");
    expect((await getActiveTriageRun(db, orgId, "issue-1"))?.id).toBe(run.id);
    for (const status of ["completed", "failed", "stopped"] as const) {
      await setTriageRunStatus(db, run.id, status);
      expect(await getActiveTriageRun(db, orgId, "issue-1")).toBeNull();
    }
  });

  it("lists the issue's runs in its organization, newest first", async () => {
    const { run: first } = await createTriageRun(db, runInput());
    await setTriageRunStatus(db, first.id, "completed");
    const { run: second } = await createTriageRun(db, runInput());
    await createTriageRun(db, runInput({ linearIssueId: "issue-2" }));
    await createTriageRun(db, runInput({ organizationId: otherOrgId }));
    expect((await listIssueTriageRuns(db, orgId, "issue-1")).map((r) => r.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(await listIssueTriageRuns(db, orgId, "issue-1", 1)).toHaveLength(1);
    expect(await listIssueTriageRuns(db, orgId, "issue-3")).toEqual([]);
  });

  it("sets and clears the current job", async () => {
    const { run } = await createTriageRun(db, runInput());
    const job = await triageJob();
    const withJob = await setTriageRunJob(db, run.id, job.id);
    expect(withJob?.currentJobId).toBe(job.id);
    expect(withJob!.updatedAt.getTime()).toBeGreaterThanOrEqual(run.updatedAt.getTime());
    expect((await setTriageRunJob(db, run.id, null))?.currentJobId).toBeNull();

    // Deleting the job clears it too.
    await setTriageRunJob(db, run.id, job.id);
    await db.delete(jobs);
    expect((await getTriageRun(db, run.id))?.currentJobId).toBeNull();

    expect(await setTriageRunJob(db, crypto.randomUUID(), null)).toBeNull();
  });

  it("sets the session of a run created before it", async () => {
    const { run } = await createTriageRun(db, runInput({ linearAgentSessionId: "pending:1" }));
    const updated = await setTriageRunSession(db, run.id, "session-real");
    expect(updated?.linearAgentSessionId).toBe("session-real");
    expect((await getTriageRunBySession(db, "session-real"))?.id).toBe(run.id);
    expect(await getTriageRunBySession(db, "pending:1")).toBeNull();
    expect(await setTriageRunSession(db, crypto.randomUUID(), "x")).toBeNull();
  });

  it("sets the status, and the last result when given", async () => {
    const { run } = await createTriageRun(db, runInput());
    const result = { summary: "Sized M", error: null, outcome: { size: "M" } };
    expect(await setTriageRunStatus(db, run.id, "completed", result)).toMatchObject({
      status: "completed",
      lastResult: result,
    });
    // Without a result, the last one stays.
    expect(await setTriageRunStatus(db, run.id, "running")).toMatchObject({
      status: "running",
      lastResult: result,
    });
    expect(await setTriageRunStatus(db, run.id, "stopped", null)).toMatchObject({
      status: "stopped",
      lastResult: null,
    });
    expect(await setTriageRunStatus(db, crypto.randomUUID(), "failed")).toBeNull();
  });

  it("starts and finishes a run for its current job only", async () => {
    const { run } = await createTriageRun(db, runInput());
    const job = await triageJob();
    const other = await triageJob();
    // No current job yet (it started before it was recorded): it becomes the current one.
    expect(await startTriageRunJob(db, run.id, job.id)).toMatchObject({
      status: "running",
      currentJobId: job.id,
    });
    expect(await startTriageRunJob(db, run.id, other.id)).toBeNull();
    expect(await startTriageRunJob(db, run.id, job.id)).toMatchObject({ status: "running" });

    expect(await finishTriageRunJob(db, run.id, other.id, "completed")).toBeNull();
    const result = { summary: "Sized M" };
    expect(await finishTriageRunJob(db, run.id, job.id, "completed", result)).toMatchObject({
      status: "completed",
      lastResult: result,
    });
    // Once finished, the same job's outcome isn't applied again.
    expect(await finishTriageRunJob(db, run.id, job.id, "failed")).toBeNull();
    expect(await startTriageRunJob(db, run.id, job.id)).toBeNull();
    expect((await getTriageRun(db, run.id))?.status).toBe("completed");
  });

  it("fails a completed job whose result is unusable", async () => {
    const job = await triageJob();
    expect(await failCompletedJob(db, job.id, "bad")).toBe(false);
    await db.update(jobs).set({ status: "completed" }).where(eq(jobs.id, job.id));
    expect(await failCompletedJob(db, job.id, "bad")).toBe(true);
    const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row).toMatchObject({ status: "failed", error: "bad" });
  });

  it("stores a reply while the run is active and requeues it once over", async () => {
    const { run } = await createTriageRun(db, runInput());
    const job = await triageJob();
    await setTriageRunJob(db, run.id, job.id);

    expect(await replyToTriageRun(db, run.id, "1: owners")).toMatchObject({
      status: "pending",
      run: { pendingReply: "1: owners", status: "queued" },
    });
    expect(await replyToTriageRun(db, run.id, " 2: B ")).toMatchObject({
      run: { pendingReply: "1: owners\n\n2: B" },
    });
    // Still active: nothing to take yet.
    expect(await takeTriageRunPendingReply(db, run.id)).toEqual({ status: "none" });

    await finishTriageRunJob(db, run.id, job.id, "completed", { summary: "M" });
    expect(await takeTriageRunPendingReply(db, run.id)).toMatchObject({
      status: "requeued",
      reply: "1: owners\n\n2: B",
      run: {
        status: "queued",
        currentJobId: null,
        pendingReply: null,
        lastResult: { summary: "M" },
      },
    });
    expect(await takeTriageRunPendingReply(db, run.id)).toEqual({ status: "none" });
  });

  it("requeues an idle run with a reply, unless another run of the issue is active", async () => {
    const { run } = await createTriageRun(db, runInput());
    await setTriageRunStatus(db, run.id, "completed");
    expect(await replyToTriageRun(db, run.id, "   ")).toEqual({ status: "none" });

    const { run: other } = await createTriageRun(db, runInput());
    expect(await replyToTriageRun(db, run.id, "answer")).toMatchObject({
      status: "conflict",
      other: { id: other.id },
    });
    expect((await getTriageRun(db, run.id))?.status).toBe("completed");

    await setTriageRunStatus(db, other.id, "failed");
    expect(await replyToTriageRun(db, run.id, "answer")).toMatchObject({
      status: "requeued",
      reply: "answer",
      run: { id: run.id, status: "queued" },
    });
  });

  it("requeues a finished run for a retry, with or without pending replies", async () => {
    const { run } = await createTriageRun(db, runInput());
    const job = await triageJob();
    await setTriageRunJob(db, run.id, job.id);
    expect(await requeueTriageRunForRetry(db, run.id)).toMatchObject({
      status: "active",
      run: { id: run.id },
    });

    await finishTriageRunJob(db, run.id, job.id, "failed");
    expect(await requeueTriageRunForRetry(db, run.id)).toMatchObject({
      status: "requeued",
      reply: "",
      run: { status: "queued", currentJobId: null },
    });

    await setTriageRunStatus(db, run.id, "stopped");
    await db.update(triageRuns).set({ pendingReply: "later" }).where(eq(triageRuns.id, run.id));
    const { run: other } = await createTriageRun(db, runInput());
    expect(await requeueTriageRunForRetry(db, run.id)).toMatchObject({
      status: "conflict",
      other: { id: other.id },
    });
    await setTriageRunStatus(db, other.id, "completed");
    expect(await requeueTriageRunForRetry(db, run.id)).toMatchObject({
      status: "requeued",
      reply: "later",
      run: { pendingReply: null },
    });
    await db.delete(triageRuns).where(eq(triageRuns.id, run.id));
    expect(await requeueTriageRunForRetry(db, run.id)).toEqual({ status: "none" });
  });

  it("stops an active run and drops its pending replies", async () => {
    const { run } = await createTriageRun(db, runInput());
    await replyToTriageRun(db, run.id, "later");
    expect(await stopTriageRun(db, run.id)).toMatchObject({ id: run.id, status: "queued" });
    expect(await getTriageRun(db, run.id)).toMatchObject({ status: "stopped", pendingReply: null });
    expect(await stopTriageRun(db, run.id)).toBeNull();
  });

  it("deletes an organization's runs with it", async () => {
    const [org] = await db.insert(organizations).values({ name: "Gone" }).returning();
    const { run } = await createTriageRun(db, runInput({ organizationId: org!.id }));
    await db.delete(organizations).where(eq(organizations.id, org!.id));
    expect(await getTriageRun(db, run.id)).toBeNull();
  });

  const runJob = async (runId: string, organizationId = orgId, type = "triage.run") =>
    (
      await insertJob(db, {
        organizationId,
        type,
        taskType: "query",
        payload: {
          trigger: { kind: "linear.triage", context: { triageRunId: runId, issue: {} } },
        },
      })
    ).job;

  it("lists an organization's runs newest first with their jobs", async () => {
    const { run: first } = await createTriageRun(db, runInput({ linearIssueId: "issue-a" }));
    const { run: second } = await createTriageRun(db, runInput({ linearIssueId: "issue-b" }));
    await setTriageRunStatus(db, second.id, "completed");
    await createTriageRun(db, runInput({ organizationId: otherOrgId }));
    const job1 = await runJob(first.id);
    const job2 = await runJob(first.id);
    // Another job type, or another organization's job, naming the run isn't one of its jobs.
    await runJob(first.id, orgId, "ralph.story");
    await runJob(first.id, otherOrgId);

    const page = await listTriageRuns(db, orgId);
    expect(page).toMatchObject({ total: 2, page: 1, pageSize: 50 });
    expect(page.runs.map((r) => r.run.id)).toEqual([second.id, first.id]);
    expect(page.runs[0]!.jobs).toEqual([]);
    expect(page.runs[1]!.jobs.map((j) => j.id)).toEqual([job2.id, job1.id]);
    expect(page.runs[1]!.jobs[0]).toMatchObject({
      triageRunId: first.id,
      status: "queued",
      agent: null,
      repository: null,
    });

    const completed = await listTriageRuns(db, orgId, { status: "completed" });
    expect(completed.total).toBe(1);
    expect(completed.runs.map((r) => r.run.id)).toEqual([second.id]);

    const paged = await listTriageRuns(db, orgId, { page: 2, pageSize: 1 });
    expect(paged).toMatchObject({ total: 2, page: 2, pageSize: 1 });
    expect(paged.runs.map((r) => r.run.id)).toEqual([first.id]);
  });

  it("loads one of the organization's runs with its jobs", async () => {
    const { run } = await createTriageRun(db, runInput());
    const job = await runJob(run.id);
    const detail = await getTriageRunDetail(db, orgId, run.id);
    expect(detail?.run.id).toBe(run.id);
    expect(detail?.jobs.map((j) => j.id)).toEqual([job.id]);
    expect(await getTriageRunDetail(db, otherOrgId, run.id)).toBeNull();
  });
});
