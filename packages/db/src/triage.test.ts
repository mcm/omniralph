import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, createDb, type Database } from "./client.js";
import { insertJob } from "./jobs.js";
import { runMigrations } from "./migrate.js";
import { jobs, organizations, triageRuns } from "./schema.js";
import {
  createTriageRun,
  getActiveTriageRun,
  getTriageRun,
  getTriageRunBySession,
  setTriageRunJob,
  setTriageRunStatus,
  type NewTriageRunInput,
} from "./triage.js";

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

describe.skipIf(!dockerAvailable)("triage queries", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let orgId: string;
  let otherOrgId: string;
  let session = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    const [other] = await db.insert(organizations).values({ name: "Other" }).returning();
    orgId = org!.id;
    otherOrgId = other!.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await container?.stop();
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
    (await insertJob(db, { organizationId: orgId, capability: "triage", type: "triage.run" })).job;

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

  it("deletes an organization's runs with it", async () => {
    const [org] = await db.insert(organizations).values({ name: "Gone" }).returning();
    const { run } = await createTriageRun(db, runInput({ organizationId: org!.id }));
    await db.delete(organizations).where(eq(organizations.id, org!.id));
    expect(await getTriageRun(db, run.id)).toBeNull();
  });
});
