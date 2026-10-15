// The `jobs` table as a queue: claiming, leases and delayed retries.
import { createTestDatabase, testDatabaseAvailable, type TestDatabase } from "../testing/index.js";
import type { ReportedHostTool } from "@omniralph/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, createDb, type Database } from "./client.js";
import { listQueuedJobsTargetingHarness } from "./harnesses.js";
import {
  claimJob,
  failJob,
  hasClaimableJob,
  getJob,
  insertJob,
  recordHarnessHeartbeat,
  renewJobLeases,
  setQueuedJobTarget,
  type NewJobInput,
} from "./jobs.js";
import { createHostTool, recordHarnessHostTools, setHarnessHostToolPath } from "./host-tools.js";
import { harnessHostTools, harnesses, hostTools, jobs, organizations } from "./schema.js";

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("job queue", () => {
  let testDb: TestDatabase;
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
      type: "review.run",
      taskType: "review",
      pool: "short",
      ...input,
    });
    await db
      .update(jobs)
      .set({ createdAt: input.createdAt ?? t0, availableAt: input.availableAt ?? t0 })
      .where(eq(jobs.id, job.id));
    return job.id;
  };

  const claim = (
    harnessId: string,
    now: Date,
    options: {
      organizationId?: string;
      acceptedTaskTypes?: string[];
      pools?: string[];
      harnessVersion?: string | null;
    } = {},
  ) =>
    claimJob(db, {
      harnessId,
      organizationId: options.organizationId ?? orgA,
      acceptedTaskTypes: options.acceptedTaskTypes ?? ["query", "review", "coding"],
      pools: options.pools ?? ["short", "long"],
      harnessVersion: options.harnessVersion === undefined ? "1.0.0" : options.harnessVersion,
      maxDeliveries: 3,
      now,
    });

  const claimable = (
    harnessId: string,
    now: Date,
    options: { organizationId?: string; pools?: string[]; harnessVersion?: string | null } = {},
  ) =>
    hasClaimableJob(db, {
      harnessId,
      organizationId: options.organizationId ?? orgA,
      acceptedTaskTypes: ["query", "review", "coding"],
      pools: options.pools ?? ["short", "long"],
      harnessVersion: options.harnessVersion === undefined ? "1.0.0" : options.harnessVersion,
      now,
    });

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [a] = await db.insert(organizations).values({ name: "A" }).returning();
    const [b] = await db.insert(organizations).values({ name: "B" }).returning();
    orgA = a!.id;
    orgB = b!.id;
    const created = await db
      .insert(harnesses)
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
    await testDb?.stop();
  });

  it("returns null when nothing is claimable", async () => {
    expect(await claim(agentA, at(1))).toEqual({ claim: null, settled: [] });
  });

  describe("hasClaimableJob", () => {
    it("is false with nothing queued", async () => {
      expect(await claimable(agentA, at(1))).toBe(false);
    });

    it("is true once a queued job's available_at has passed, not before", async () => {
      await enqueue({ availableAt: at(10) });
      expect(await claimable(agentA, at(5))).toBe(false);
      expect(await claimable(agentA, at(10))).toBe(true);
    });

    it("is true for a running job whose lease lapsed", async () => {
      await enqueue();
      await claim(agentA2, at(0));
      expect(await claimable(agentA, at(60))).toBe(false);
      expect(await claimable(agentA, at(121))).toBe(true);
    });

    it("only counts jobs in the given pools", async () => {
      await enqueue({ pool: "long", taskType: "coding", type: "ralph.run" });
      expect(await claimable(agentA, at(1), { pools: ["short"] })).toBe(false);
      expect(await claimable(agentA, at(1), { pools: ["long"] })).toBe(true);
    });

    it("counts jobs targeted at this harness, not at another one", async () => {
      await enqueue({ targetHarnessId: agentA2 });
      expect(await claimable(agentA, at(1))).toBe(false);
      await enqueue({ targetHarnessId: agentA });
      expect(await claimable(agentA, at(1))).toBe(true);
    });

    it("ignores another organization's jobs", async () => {
      await enqueue({ organizationId: orgB });
      expect(await claimable(agentA, at(1))).toBe(false);
      expect(await claimable(agentB, at(1), { organizationId: orgB })).toBe(true);
    });

    it("applies the minimum harness version like claimJob", async () => {
      await enqueue({ minHarnessVersion: "2.0.0" });
      expect(await claimable(agentA, at(1))).toBe(false);
      expect(await claimable(agentA, at(1), { harnessVersion: null })).toBe(false);
      expect(await claimable(agentA, at(1), { harnessVersion: "2.0.0" })).toBe(true);
    });

    it("agrees with claimJob and claims nothing itself", async () => {
      const id = await enqueue();
      expect(await claimable(agentA, at(1))).toBe(true);
      expect(await getJob(db, id)).toMatchObject({ status: "queued", deliveryCount: 0 });
      expect((await claim(agentA, at(1))).claim?.job.id).toBe(id);
      expect(await claimable(agentA, at(2))).toBe(false);
    });
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
        harnessId: agentA,
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
    const mine = await enqueue({ createdAt: at(-10), targetHarnessId: agentA });
    const theirs = await enqueue({ createdAt: at(-40), targetHarnessId: agentA2 });
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

  it("only claims task types the harness accepts", async () => {
    const coding = await enqueue({
      type: "ralph.story",
      taskType: "coding",
      pool: "long",
    });
    expect(
      (await claim(agentA, at(1), { acceptedTaskTypes: ["query", "review"] })).claim,
    ).toBeNull();
    expect((await claim(agentA, at(1), { acceptedTaskTypes: [] })).claim).toBeNull();
    expect((await claim(agentA, at(1), { acceptedTaskTypes: ["coding"] })).claim?.job.id).toBe(
      coding,
    );
  });

  it("only claims jobs of the pools asked for", async () => {
    const long = await enqueue({ taskType: "coding", pool: "long", createdAt: at(-20) });
    const short = await enqueue({ taskType: "query", pool: "short", createdAt: at(-10) });
    expect((await claim(agentA, at(1), { pools: [] })).claim).toBeNull();
    expect((await claim(agentA, at(1), { pools: ["short"] })).claim?.job.id).toBe(short);
    expect((await claim(agentA, at(1), { pools: ["short"] })).claim).toBeNull();
    expect((await claim(agentA, at(1), { pools: ["long"] })).claim?.job.id).toBe(long);
  });

  it("always claims system jobs, whatever the task types and pools", async () => {
    const sync = await enqueue({
      type: "repo.sync",
      taskType: "system",
      pool: null,
    });
    expect((await claim(agentA, at(1), { acceptedTaskTypes: [], pools: [] })).claim?.job.id).toBe(
      sync,
    );
  });

  it("only claims jobs whose minimum harness version the harness meets", async () => {
    const newer = await enqueue({ minHarnessVersion: "1.10.0", createdAt: at(-30) });
    const older = await enqueue({ minHarnessVersion: "1.2.0", createdAt: at(-20) });
    const any = await enqueue({ createdAt: at(-10) });
    expect((await claim(agentA, at(1), { harnessVersion: null })).claim?.job.id).toBe(any);
    expect((await claim(agentA, at(1), { harnessVersion: "1.9.0" })).claim?.job.id).toBe(older);
    expect((await claim(agentA, at(1), { harnessVersion: "1.9.0" })).claim).toBeNull();
    // Semver, not string order; a prerelease of the minimum counts.
    expect((await claim(agentA, at(1), { harnessVersion: "1.10.0-beta.1" })).claim?.job.id).toBe(
      newer,
    );
  });

  it("only claims jobs whose installables the harness reported", async () => {
    await db
      .update(harnesses)
      .set({ reportedInstallables: [{ name: "@omniralph/code-graph", version: "1.0.0" }] })
      .where(eq(harnesses.id, agentA));
    try {
      const both = await enqueue({
        requiredInstallables: ["@omniralph/code-graph", "@omniralph/sast"],
        createdAt: at(-30),
      });
      const graph = await enqueue({
        requiredInstallables: ["@omniralph/code-graph"],
        createdAt: at(-20),
      });
      const any = await enqueue({ createdAt: at(-10) });
      // The other harness has none: it only gets the job that needs none.
      expect((await claim(agentA2, at(1))).claim?.job.id).toBe(any);
      expect((await claim(agentA2, at(1))).claim).toBeNull();
      expect((await claim(agentA, at(1))).claim?.job.id).toBe(graph);
      expect((await claim(agentA, at(1))).claim).toBeNull();
      expect((await getJob(db, both))?.status).toBe("queued");
    } finally {
      await db.update(harnesses).set({ reportedInstallables: [] }).where(eq(harnesses.id, agentA));
    }
  });

  it("only claims jobs whose host tools have an effective path on the harness", async () => {
    const tools = await db
      .insert(hostTools)
      .values([
        { organizationId: orgA, name: "opengrep" },
        { organizationId: orgA, name: "semgrep" },
        { organizationId: orgA, name: "missing" },
        { organizationId: orgB, name: "other-org" },
      ])
      .returning();
    const [opengrep, semgrep, missing, otherOrg] = tools.map((tool) => tool.id) as string[];
    await db.insert(harnessHostTools).values([
      // Discovered on PATH, nothing configured: usable.
      { harnessId: agentA, hostToolId: opengrep!, discoveredPath: "/usr/bin/opengrep" },
      // Configured and found: usable.
      {
        harnessId: agentA,
        hostToolId: semgrep!,
        configuredPath: "/opt/semgrep",
        configuredPathExists: true,
      },
      // Configured but missing: the discovered path is no fallback.
      {
        harnessId: agentA,
        hostToolId: missing!,
        configuredPath: "/opt/missing",
        configuredPathExists: false,
        discoveredPath: "/usr/bin/missing",
      },
      { harnessId: agentA2, hostToolId: opengrep! },
      { harnessId: agentB, hostToolId: otherOrg!, discoveredPath: "/usr/bin/other-org" },
    ]);
    try {
      const needsMissing = await enqueue({ requiredHostTools: ["missing"], createdAt: at(-40) });
      const needsBoth = await enqueue({
        requiredHostTools: ["opengrep", "semgrep"],
        createdAt: at(-30),
      });
      const needsOther = await enqueue({ requiredHostTools: ["other-org"], createdAt: at(-20) });
      // The second harness hasn't found opengrep.
      expect((await claim(agentA2, at(1))).claim).toBeNull();
      expect((await claim(agentA, at(1))).claim?.job.id).toBe(needsBoth);
      expect((await claim(agentA, at(1))).claim).toBeNull();
      expect((await getJob(db, needsMissing))?.status).toBe("queued");
      expect((await getJob(db, needsOther))?.status).toBe("queued");
    } finally {
      await db.delete(hostTools);
    }
  });

  it("follows each heartbeat's report of installables and host tools", async () => {
    const opengrep = await createHostTool(db, orgA, { name: "opengrep" });
    if (!opengrep.ok) throw new Error("setup");
    const fixture = { name: "@omniralph/fixture", version: "1.0.0" };
    const found = { name: "opengrep", configuredPathExists: null, discoveredPath: "/usr/bin/og" };
    const heartbeat = async (
      harnessId: string,
      installables: { name: string; version: string }[],
      tools: ReportedHostTool[],
    ) => {
      await recordHarnessHeartbeat(db, harnessId, { version: "1.0.0", installables });
      await recordHarnessHostTools(db, orgA, harnessId, tools);
    };
    const requiringBoth = (seconds: number) =>
      enqueue({
        requiredInstallables: [fixture.name],
        requiredHostTools: ["opengrep"],
        createdAt: at(seconds),
      });
    try {
      await heartbeat(agentA, [fixture], [found]);
      await heartbeat(agentA2, [], []);
      const needsBoth = await requiringBoth(-30);
      const anyForB = await enqueue({ createdAt: at(-20) });
      // Only A has both: B gets just the job that needs nothing.
      expect((await claim(agentA2, at(1))).claim?.job.id).toBe(anyForB);
      expect((await claim(agentA2, at(1))).claim).toBeNull();
      expect((await claim(agentA, at(1))).claim?.job.id).toBe(needsBoth);
      const anyForA = await enqueue({ createdAt: at(-10) });
      expect((await claim(agentA, at(1))).claim?.job.id).toBe(anyForA);

      const next = await requiringBoth(-5);
      // The host tool left out of the report, then reported as not found.
      await heartbeat(agentA, [fixture], []);
      expect((await claim(agentA, at(1))).claim).toBeNull();
      await heartbeat(agentA, [fixture], [{ ...found, discoveredPath: null }]);
      expect((await claim(agentA, at(1))).claim).toBeNull();
      // The installable left out.
      await heartbeat(agentA, [], [found]);
      expect((await claim(agentA, at(1))).claim).toBeNull();
      await heartbeat(agentA, [fixture], [found]);
      expect((await claim(agentA, at(1))).claim?.job.id).toBe(next);

      // A configured path the harness doesn't find: the discovered one is no fallback.
      const last = await requiringBoth(-1);
      await setHarnessHostToolPath(db, orgA, agentA, opengrep.hostTool.id, "/opt/missing");
      await heartbeat(
        agentA,
        [fixture],
        [{ ...found, configuredPath: "/opt/missing", configuredPathExists: false }],
      );
      expect((await claim(agentA, at(1))).claim).toBeNull();
      expect((await claim(agentA2, at(1))).claim).toBeNull();
      expect((await getJob(db, last))?.status).toBe("queued");
    } finally {
      await db.update(harnesses).set({ reportedInstallables: [] }).where(eq(harnesses.id, agentA));
      await db.delete(hostTools);
    }
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
      harnessId: agentA2,
      deliveryCount: 2,
      leaseExpiresAt: at(241),
    });
    // The first agent's late result is rejected.
    expect(
      await failJob(db, { jobId: id, harnessId: agentA, retryable: true, maxDeliveries: 3 }),
    ).toEqual({ status: "conflict" });
  });

  it("delays a retried job by retryAfterSeconds", async () => {
    const id = await enqueue();
    await claim(agentA, at(0));
    expect(
      await failJob(db, {
        jobId: id,
        harnessId: agentA,
        retryable: true,
        error: "busy",
        maxDeliveries: 3,
        retryAfterSeconds: 60,
        now: at(10),
      }),
    ).toEqual({ status: "retry" });
    expect(await getJob(db, id)).toMatchObject({
      status: "queued",
      harnessId: null,
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
      .set({ status: "running", harnessId: agentA2, deliveryCount: 3, leaseExpiresAt: at(-1) })
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

  it("fails a job beforeClaim says can never run and claims the next one", async () => {
    const broken = await enqueue({ createdAt: at(-20) });
    const next = await enqueue({ createdAt: at(-10) });
    const seen: string[] = [];
    const result = await claimJob(db, {
      harnessId: agentA,
      organizationId: orgA,
      acceptedTaskTypes: ["review"],
      pools: ["short"],
      harnessVersion: "1.0.0",
      maxDeliveries: 3,
      now: at(1),
      beforeClaim: async (job) => {
        seen.push(job.id);
        return job.id === broken ? { fail: "Unknown task builtin:gone" } : undefined;
      },
    });
    expect(seen).toEqual([broken, next]);
    expect(result.claim?.job.id).toBe(next);
    expect(result.settled).toEqual([
      {
        outcome: "failed",
        job: expect.objectContaining({
          id: broken,
          status: "failed",
          error: "Unknown task builtin:gone",
          deliveryCount: 0,
        }),
      },
    ]);
  });

  it("rolls the claim back when beforeClaim throws", async () => {
    const id = await enqueue({ createdAt: at(-10) });
    await expect(
      claimJob(db, {
        harnessId: agentA,
        organizationId: orgA,
        acceptedTaskTypes: ["review"],
        pools: ["short"],
        harnessVersion: "1.0.0",
        maxDeliveries: 3,
        now: at(1),
        beforeClaim: () => Promise.reject(new Error("KMS down")),
      }),
    ).rejects.toThrow("KMS down");
    expect(await getJob(db, id)).toMatchObject({ status: "queued", deliveryCount: 0 });
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
    const result = await claim(agentA2, at(150), { pools: ["short"] });
    expect(result.claim?.job.id).toBe(theirs);
  });

  it("retargets only queued jobs and lists the queued jobs targeting an agent", async () => {
    const queued = await enqueue({ createdAt: at(-10), targetHarnessId: agentA });
    const running = await enqueue({ createdAt: at(-20), targetHarnessId: agentA });
    await claim(agentA, at(0));
    const later = await enqueue({ createdAt: at(10), targetHarnessId: agentA });
    await enqueue({ targetHarnessId: agentA2 });
    await enqueue();

    expect((await listQueuedJobsTargetingHarness(db, agentA)).map((j) => j.id)).toEqual([
      queued,
      later,
    ]);

    expect(await setQueuedJobTarget(db, queued, agentA2)).toBe(true);
    expect(await setQueuedJobTarget(db, later, null)).toBe(true);
    expect(await setQueuedJobTarget(db, running, null)).toBe(false);
    expect((await getJob(db, queued))?.targetHarnessId).toBe(agentA2);
    expect((await getJob(db, later))?.targetHarnessId).toBeNull();
    expect((await getJob(db, running))?.targetHarnessId).toBe(agentA);
    expect(await listQueuedJobsTargetingHarness(db, agentA)).toEqual([]);
  });
});
