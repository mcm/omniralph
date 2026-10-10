// The `jobs` table as a queue: claiming, leases and delayed retries.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, createDb, type Database } from "./client.js";
import { listQueuedJobsTargetingAgent } from "./agents.js";
import {
  claimJob,
  failJob,
  getJob,
  insertJob,
  renewJobLeases,
  setQueuedJobTarget,
  type NewJobInput,
} from "./jobs.js";
import { runMigrations } from "./migrate.js";
import { agents, jobs, organizations } from "./schema.js";

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

describe.skipIf(!dockerAvailable)("job queue", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let orgA: string;
  let orgB: string;
  let agentA: string;
  let agentA2: string;
  let agentB: string;

  const t0 = new Date("2026-01-01T00:00:00Z");
  const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

  const enqueue = async (
    input: Partial<NewJobInput> & { createdAt?: Date; availableAt?: Date } = {},
  ) => {
    const { job } = await insertJob(db, {
      organizationId: orgA,
      capability: "review",
      type: "review.run",
      ...input,
    });
    await db
      .update(jobs)
      .set({ createdAt: input.createdAt ?? t0, availableAt: input.availableAt ?? t0 })
      .where(eq(jobs.id, job.id));
    return job.id;
  };

  const claim = (
    agentId: string,
    now: Date,
    options: { organizationId?: string; capabilities?: string[]; enabled?: string[] } = {},
  ) =>
    claimJob(db, {
      agentId,
      organizationId: options.organizationId ?? orgA,
      capabilities: options.capabilities ?? ["review", "ralph"],
      enabledCapabilities: options.enabled ?? ["review", "ralph"],
      maxDeliveries: 3,
      now,
    });

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    const [a] = await db.insert(organizations).values({ name: "A" }).returning();
    const [b] = await db.insert(organizations).values({ name: "B" }).returning();
    orgA = a!.id;
    orgB = b!.id;
    const created = await db
      .insert(agents)
      .values([
        { organizationId: orgA, name: "a-1" },
        { organizationId: orgA, name: "a-2" },
        { organizationId: orgB, name: "b-1" },
      ])
      .returning();
    [agentA, agentA2, agentB] = created.map((r) => r.id) as [string, string, string];
  }, 180_000);

  beforeEach(async () => {
    await db.delete(jobs);
  });

  afterAll(async () => {
    if (db) await closeDb(db);
    await container?.stop();
  });

  it("returns null when nothing is claimable", async () => {
    expect(await claim(agentA, at(1))).toEqual({ claim: null, settled: [] });
  });

  it("claims the oldest job, sets it running and leases it", async () => {
    const newer = await enqueue({ createdAt: at(-10) });
    const older = await enqueue({ createdAt: at(-20) });
    const result = await claim(agentA, at(1));
    expect(result.settled).toEqual([]);
    expect(result.claim).toMatchObject({
      action: "run",
      job: {
        id: older,
        status: "running",
        agentId: agentA,
        deliveryCount: 1,
        startedAt: at(1),
        leaseExpiresAt: at(121),
      },
    });
    expect((await claim(agentA, at(2))).claim?.job.id).toBe(newer);
    expect(await claim(agentA, at(3))).toEqual({ claim: null, settled: [] });
  });

  it("claims jobs targeted at the agent first, and never another agent's", async () => {
    const shared = await enqueue({ createdAt: at(-30) });
    const mine = await enqueue({ createdAt: at(-10), targetAgentId: agentA });
    const theirs = await enqueue({ createdAt: at(-40), targetAgentId: agentA2 });
    expect((await claim(agentA, at(1))).claim?.job.id).toBe(mine);
    expect((await claim(agentA, at(1))).claim?.job.id).toBe(shared);
    expect((await claim(agentA, at(1))).claim).toBeNull();
    expect((await claim(agentA2, at(1))).claim?.job.id).toBe(theirs);
  });

  it("never claims another organization's jobs", async () => {
    const a = await enqueue();
    expect((await claim(agentB, at(1), { organizationId: orgB })).claim).toBeNull();
    const b = await enqueue({ organizationId: orgB });
    expect((await claim(agentB, at(1), { organizationId: orgB })).claim?.job.id).toBe(b);
    expect((await claim(agentA, at(1))).claim?.job.id).toBe(a);
  });

  it("only claims capabilities both asked for and enabled", async () => {
    const ralph = await enqueue({ capability: "ralph", type: "ralph.story" });
    expect((await claim(agentA, at(1), { capabilities: ["review"] })).claim).toBeNull();
    expect((await claim(agentA, at(1), { enabled: ["review"] })).claim).toBeNull();
    expect((await claim(agentA, at(1), { capabilities: [], enabled: [] })).claim).toBeNull();
    expect((await claim(agentA, at(1))).claim?.job.id).toBe(ralph);
  });

  it("doesn't claim a job before it is available", async () => {
    const id = await enqueue({ availableAt: at(30) });
    expect((await claim(agentA, at(29))).claim).toBeNull();
    expect((await claim(agentA, at(30))).claim?.job.id).toBe(id);
  });

  it("never hands one job to two concurrent claims", async () => {
    const ids = await Promise.all([1, 2, 3, 4].map(() => enqueue()));
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => claim(i % 2 ? agentA : agentA2, at(1))),
    );
    const claimed = results.flatMap((r) => (r.claim ? [r.claim.job.id] : []));
    expect(claimed.toSorted()).toEqual(ids.toSorted());
    const rows = await db.select().from(jobs);
    expect(rows.every((r) => r.deliveryCount === 1)).toBe(true);
  });

  it("takes over a running job once its lease lapsed", async () => {
    const id = await enqueue();
    await claim(agentA, at(0));
    expect((await claim(agentA2, at(120))).claim).toBeNull();
    expect((await claim(agentA2, at(121))).claim?.job).toMatchObject({
      id,
      agentId: agentA2,
      deliveryCount: 2,
      leaseExpiresAt: at(241),
    });
    // The first agent's late result is rejected.
    expect(
      await failJob(db, { jobId: id, agentId: agentA, retryable: true, maxDeliveries: 3 }),
    ).toEqual({ status: "conflict" });
  });

  it("delays a retried job by retryAfterSeconds", async () => {
    const id = await enqueue();
    await claim(agentA, at(0));
    expect(
      await failJob(db, {
        jobId: id,
        agentId: agentA,
        retryable: true,
        error: "busy",
        maxDeliveries: 3,
        retryAfterSeconds: 60,
        now: at(10),
      }),
    ).toEqual({ status: "retry" });
    expect(await getJob(db, id)).toMatchObject({
      status: "queued",
      agentId: null,
      availableAt: at(70),
      leaseExpiresAt: null,
    });
    expect((await claim(agentA2, at(69))).claim).toBeNull();
    expect((await claim(agentA2, at(70))).claim?.job).toMatchObject({ id, deliveryCount: 2 });
  });

  it("settles cancel-requested and exhausted candidates and claims the next one", async () => {
    const canceled = await enqueue({ createdAt: at(-30) });
    await db.update(jobs).set({ cancelRequested: true }).where(eq(jobs.id, canceled));
    const exhausted = await enqueue({ createdAt: at(-20) });
    await db.update(jobs).set({ deliveryCount: 3 }).where(eq(jobs.id, exhausted));
    // A crashed job on its last delivery fails on takeover.
    const crashed = await enqueue({ createdAt: at(-15) });
    await db
      .update(jobs)
      .set({ status: "running", agentId: agentA2, deliveryCount: 3, leaseExpiresAt: at(-1) })
      .where(eq(jobs.id, crashed));
    const next = await enqueue({ createdAt: at(-10) });

    const result = await claim(agentA, at(1));
    expect(result.claim?.job.id).toBe(next);
    expect(result.settled).toEqual([
      { outcome: "canceled", job: expect.objectContaining({ id: canceled, status: "canceled" }) },
      {
        outcome: "failed",
        job: expect.objectContaining({
          id: exhausted,
          status: "failed",
          error: "Gave up after 3 deliveries",
        }),
      },
      { outcome: "failed", job: expect.objectContaining({ id: crashed, status: "failed" }) },
    ]);
    expect(await claim(agentA, at(2))).toEqual({ claim: null, settled: [] });
  });

  it("renews leases only for jobs running on the agent", async () => {
    const mine = await enqueue({ createdAt: at(-20) });
    const theirs = await enqueue({ createdAt: at(-10) });
    const queued = await enqueue({ createdAt: at(0) });
    await claim(agentA, at(0));
    await claim(agentA2, at(0));

    expect((await renewJobLeases(db, agentA, [mine, theirs, queued], at(100))).toSorted()).toEqual([
      mine,
    ]);
    expect((await getJob(db, mine))?.leaseExpiresAt).toEqual(at(220));
    expect((await getJob(db, theirs))?.leaseExpiresAt).toEqual(at(120));
    expect((await getJob(db, queued))?.leaseExpiresAt).toBeNull();
    expect(await renewJobLeases(db, agentA, [], at(100))).toEqual([]);

    // The renewed job isn't taken over; the other one is.
    const result = await claim(agentA2, at(150), { capabilities: ["review"] });
    expect(result.claim?.job.id).toBe(theirs);
  });

  it("retargets only queued jobs and lists the queued jobs targeting an agent", async () => {
    const queued = await enqueue({ createdAt: at(-10), targetAgentId: agentA });
    const running = await enqueue({ createdAt: at(-20), targetAgentId: agentA });
    await claim(agentA, at(0));
    const later = await enqueue({ createdAt: at(10), targetAgentId: agentA });
    await enqueue({ targetAgentId: agentA2 });
    await enqueue();

    expect((await listQueuedJobsTargetingAgent(db, agentA)).map((j) => j.id)).toEqual([
      queued,
      later,
    ]);

    expect(await setQueuedJobTarget(db, queued, agentA2)).toBe(true);
    expect(await setQueuedJobTarget(db, later, null)).toBe(true);
    expect(await setQueuedJobTarget(db, running, null)).toBe(false);
    expect((await getJob(db, queued))?.targetAgentId).toBe(agentA2);
    expect((await getJob(db, later))?.targetAgentId).toBeNull();
    expect((await getJob(db, running))?.targetAgentId).toBe(agentA);
    expect(await listQueuedJobsTargetingAgent(db, agentA)).toEqual([]);
  });
});
