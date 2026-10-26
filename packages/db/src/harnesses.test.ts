// Harnesses, enrollments and harness settings are scoped to organizations.
import { createTestDatabase, testDatabaseAvailable, type TestDatabase } from "../testing/index.js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createHarnessEnrollment,
  enrollHarness,
  getHarnessEnrollmentStatus,
  revokeHarness,
} from "./harness-auth.js";
import {
  findJobPage,
  getHarnessOverview,
  resolveHarnessConfig,
  listJobs,
  listHarnessInstallJobs,
  listHarnessPinSyncJobs,
  listActiveHarnessIds,
  listHarnessOverview,
  listReportedInstallables,
  listReportedModels,
  listRepositoryCodingHarnessIds,
  markHarnessDeleted,
  requestHarnessUpdate,
  setHarnessDesiredVersion,
  updateHarnessConfig,
} from "./harnesses.js";
import {
  getDesiredHarnessVersion,
  setDefaultMaxConcurrency,
  setDesiredHarnessVersion,
} from "./app-settings.js";
import { closeDb, createDb, type Database } from "./client.js";
import { recordHarnessHeartbeat } from "./jobs.js";
import { getResourceOrganizationId } from "./resource-organization.js";
import { connectRepository, pinRepositoryToHarness } from "./repositories.js";
import { harnesses, jobs, organizations, scmConnections } from "./schema.js";
import { filterActiveHarnessIds, listPinnableHarnesses } from "./settings.js";

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("organization-scoped harnesses", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgA: string;
  let orgB: string;

  const enroll = async (organizationId: string, name: string) => {
    const enrollment = await createHarnessEnrollment(db, { organizationId, name });
    return (await enrollHarness(db, {
      enrollmentToken: enrollment.token,
      name: "host",
      version: "1.0.0",
    }))!.harnessId;
  };

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [a] = await db.insert(organizations).values({ name: "A" }).returning();
    const [b] = await db.insert(organizations).values({ name: "B" }).returning();
    orgA = a!.id;
    orgB = b!.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  it("creates the harness in the enrollment's organization", async () => {
    const harnessId = await enroll(orgB, "b-agent");
    const [row] = await db.select().from(harnesses);
    expect(row).toMatchObject({ id: harnessId, organizationId: orgB, name: "b-agent" });
  });

  it("reports which harness redeemed an enrollment, only to its organization", async () => {
    const enrollment = await createHarnessEnrollment(db, { organizationId: orgB, name: "b-new" });
    expect(await getHarnessEnrollmentStatus(db, orgB, enrollment.id)).toEqual({
      id: enrollment.id,
      expiresAt: enrollment.expiresAt,
      harness: null,
    });
    expect(await getHarnessEnrollmentStatus(db, orgA, enrollment.id)).toBeNull();
    const { harnessId } = (await enrollHarness(db, {
      enrollmentToken: enrollment.token,
      name: "host",
      version: "1.0.0",
    }))!;
    expect(await getHarnessEnrollmentStatus(db, orgB, enrollment.id)).toMatchObject({
      harness: { id: harnessId, name: "b-new" },
    });
    expect(await getHarnessEnrollmentStatus(db, orgA, enrollment.id)).toBeNull();
  });

  it("lists, reads and updates only the organization's harnesses", async () => {
    const a = await enroll(orgA, "a-1");
    const b = await enroll(orgB, "b-1");
    expect((await listHarnessOverview(db, orgA)).map((r) => r.id)).toEqual([a]);
    expect((await listHarnessOverview(db, orgB)).map((r) => r.id)).toContain(b);
    expect((await listHarnessOverview(db, orgB)).map((r) => r.id)).not.toContain(a);
    expect(await getHarnessOverview(db, orgB, a)).toBeNull();
    expect((await getHarnessOverview(db, orgA, a))?.id).toBe(a);

    const config = { maxConcurrency: 2, poolLimits: { long: 1 } };
    expect(await updateHarnessConfig(db, orgB, a, config)).toBeNull();
    expect(await updateHarnessConfig(db, orgA, a, config)).toMatchObject({
      maxConcurrency: 2,
      poolLimits: { long: 1 },
    });
    expect(await setHarnessDesiredVersion(db, orgB, a, "9.9.9")).toBeNull();
    expect(await setHarnessDesiredVersion(db, orgA, a, "1.2.3")).toMatchObject({
      desiredVersion: "1.2.3",
    });

    expect((await listPinnableHarnesses(db, orgB)).map((r) => r.id)).not.toContain(a);
    expect(await filterActiveHarnessIds(db, orgB, [a, b])).toEqual(new Set([b]));

    expect(await revokeHarness(db, a, { organizationId: orgB })).toBeNull();
    expect((await getHarnessOverview(db, orgA, a))?.revokedAt).toBeNull();
    expect(await revokeHarness(db, a, { organizationId: orgA })).not.toBeNull();
  });

  it("resolves a harness's own max concurrency, else its organization's, and its reported task types", async () => {
    const [org] = await db.insert(organizations).values({ name: "Defaults" }).returning();
    const organizationId = org!.id;
    const inheriting = await enroll(organizationId, "inheriting");
    const own = await enroll(organizationId, "own");
    await db
      .update(harnesses)
      .set({ maxConcurrency: 2, reportedAcceptedTaskTypes: ["review"] })
      .where(eq(harnesses.id, own));
    const config = async (harnessId: string) => {
      const [row] = await db.select().from(harnesses).where(eq(harnesses.id, harnessId));
      return resolveHarnessConfig(db, row!);
    };
    const effective = async (harnessId: string) =>
      (await getHarnessOverview(db, organizationId, harnessId))?.effective;

    // No organization setting and nothing reported: every task type, 5 at once.
    const builtIn = { acceptedTaskTypes: ["query", "review", "coding"], maxConcurrency: 5 };
    expect(await config(inheriting)).toEqual(builtIn);
    expect(await effective(inheriting)).toEqual(builtIn);
    const ownConfig = { acceptedTaskTypes: ["review"], maxConcurrency: 2 };
    expect(await config(own)).toEqual(ownConfig);

    await setDefaultMaxConcurrency(db, organizationId, 8, null);
    const changed = { acceptedTaskTypes: ["query", "review", "coding"], maxConcurrency: 8 };
    expect(await config(inheriting)).toEqual(changed);
    expect(await effective(inheriting)).toEqual(changed);
    expect(await config(own)).toEqual(ownConfig);
    expect(await effective(own)).toEqual(ownConfig);
    // Another organization keeps the built-in defaults.
    expect(await config(await enroll(orgB, "b-defaults"))).toEqual(builtIn);
  });

  it("saves an override and switches each field back to inheriting with null", async () => {
    const [org] = await db.insert(organizations).values({ name: "Overrides" }).returning();
    const organizationId = org!.id;
    const a = await enroll(organizationId, "override");
    await setDefaultMaxConcurrency(db, organizationId, 7, null);
    const overview = async () => (await getHarnessOverview(db, organizationId, a))!;

    expect(
      await updateHarnessConfig(db, organizationId, a, { maxConcurrency: 2, poolLimits: {} }),
    ).toMatchObject({ maxConcurrency: 2 });
    expect((await overview()).effective).toEqual({
      acceptedTaskTypes: ["query", "review", "coding"],
      maxConcurrency: 2,
    });

    // Back to the organization's max concurrency.
    expect(
      await updateHarnessConfig(db, organizationId, a, { maxConcurrency: null, poolLimits: {} }),
    ).toMatchObject({ maxConcurrency: null });
    const inheriting = await overview();
    expect(inheriting.effective).toEqual({
      acceptedTaskTypes: ["query", "review", "coding"],
      maxConcurrency: 7,
    });
    expect(inheriting.defaults).toEqual({ maxConcurrency: 7 });
  });

  it("soft-deletes only revoked harnesses of the organization and hides them", async () => {
    const a = await enroll(orgA, "a-delete");
    expect(await markHarnessDeleted(db, orgA, a)).toBe(false);
    await revokeHarness(db, a, { organizationId: orgA });
    expect(await markHarnessDeleted(db, orgB, a)).toBe(false);
    expect(await markHarnessDeleted(db, orgA, a)).toBe(true);
    expect(await markHarnessDeleted(db, orgA, a)).toBe(false);

    expect((await listHarnessOverview(db, orgA)).map((r) => r.id)).not.toContain(a);
    expect(await getHarnessOverview(db, orgA, a)).toBeNull();
    expect(await getResourceOrganizationId(db, "harness", a)).toBeNull();
    const [row] = await db.select().from(harnesses).where(eq(harnesses.id, a));
    expect(row?.deletedAt).toBeInstanceOf(Date);
  });

  it("replaces the reported models with each heartbeat's", async () => {
    const a = await enroll(orgA, "a-models");
    const opus = { value: "opus", displayName: "Opus" };
    const heartbeat = (models?: { value: string; displayName: string }[]) =>
      recordHarnessHeartbeat(db, a, { version: "1.0.0", models });
    expect((await heartbeat([opus]))?.reportedModels).toEqual([opus]);
    expect((await getHarnessOverview(db, orgA, a))?.reportedModels).toEqual([opus]);
    // An older harness, or one whose login can't list them, reports none.
    expect((await heartbeat())?.reportedModels).toEqual([]);
  });

  describe("listReportedModels", () => {
    const opus = { value: "opus", displayName: "Opus" };
    const sonnet = { value: "sonnet", displayName: "Sonnet" };
    const haiku = { value: "haiku", displayName: "Haiku" };
    const fable = { value: "claude-fable-5-1", displayName: "Fable 5.1" };
    let org: string;
    let first: string;
    let second: string;
    let revoked: string;

    beforeAll(async () => {
      const [row] = await db.insert(organizations).values({ name: "Models" }).returning();
      org = row!.id;
      first = await enroll(org, "models-1");
      second = await enroll(org, "models-2");
      revoked = await enroll(org, "models-revoked");
      const other = await enroll(orgB, "models-other-org");
      await recordHarnessHeartbeat(db, first, { version: "1.0.0", models: [opus, sonnet] });
      await recordHarnessHeartbeat(db, second, { version: "1.0.0", models: [sonnet, haiku] });
      await recordHarnessHeartbeat(db, revoked, { version: "1.0.0", models: [fable] });
      await recordHarnessHeartbeat(db, other, { version: "1.0.0", models: [fable] });
      await revokeHarness(db, revoked, { organizationId: org });
    });

    it("de-duplicates overlapping models, sorted by display name, with their harnesses", async () => {
      expect(await listReportedModels(db, org)).toEqual([
        { ...haiku, harnessIds: [second] },
        { ...opus, harnessIds: [first] },
        { ...sonnet, harnessIds: [first, second] },
      ]);
    });

    it("filters by harness, ignoring other organizations' harnesses", async () => {
      expect(await listReportedModels(db, org, { harnessIds: [second] })).toEqual([
        { ...haiku, harnessIds: [second] },
        { ...sonnet, harnessIds: [second] },
      ]);
      expect(await listReportedModels(db, org, { harnessIds: [] })).toEqual([]);
      const [other] = await listHarnessOverview(db, orgB);
      expect(await listReportedModels(db, org, { harnessIds: [other!.id] })).toEqual([]);
    });

    it("ignores revoked harnesses, even when asked for them", async () => {
      expect(await listReportedModels(db, org, { harnessIds: [revoked] })).toEqual([]);
      expect((await listReportedModels(db, org)).map((m) => m.value)).not.toContain(fable.value);
    });
  });

  describe("listReportedInstallables", () => {
    const hello = (version: string) => ({ name: "@omniralph/hello", version });
    const graph = { name: "@omniralph/code-graph", version: "2.0.0" };
    let org: string;
    let first: string;
    let second: string;
    let revoked: string;

    beforeAll(async () => {
      const [row] = await db.insert(organizations).values({ name: "Installables" }).returning();
      org = row!.id;
      first = await enroll(org, "installables-1");
      second = await enroll(org, "installables-2");
      revoked = await enroll(org, "installables-revoked");
      await recordHarnessHeartbeat(db, first, { version: "1.0.0", installables: [hello("1.0.0")] });
      await recordHarnessHeartbeat(db, second, {
        version: "1.0.0",
        installables: [hello("1.1.0"), graph],
      });
      await recordHarnessHeartbeat(db, revoked, {
        version: "1.0.0",
        installables: [{ name: "@omniralph/gone", version: "1.0.0" }],
      });
      await revokeHarness(db, revoked, { organizationId: org });
      const install = (
        name: string,
        mcpServers: unknown,
        finishedAt: Date,
        status: "completed" | "failed" = "completed",
      ) => ({
        organizationId: org,
        type: "install",
        taskType: "system" as const,
        status,
        targetHarnessId: second,
        payload: { name },
        result: { name, version: "1.0.0", changed: true, mcpServers },
        finishedAt,
      });
      await db
        .insert(jobs)
        .values([
          install("@omniralph/hello", ["old"], new Date("2026-10-01T00:00:00Z")),
          install("@omniralph/hello", ["greet"], new Date("2026-10-02T00:00:00Z")),
          install("@omniralph/hello", ["broken"], new Date("2026-10-03T00:00:00Z"), "failed"),
          install("@omniralph/gone", ["gone"], new Date("2026-10-02T00:00:00Z")),
        ]);
    });

    it("lists reported installables by name with their harnesses and latest MCP servers", async () => {
      expect(await listReportedInstallables(db, org)).toEqual([
        { name: graph.name, harnessIds: [second], mcpServers: [] },
        { name: "@omniralph/hello", harnessIds: [first, second], mcpServers: ["greet"] },
      ]);
      expect(await listActiveHarnessIds(db, org)).toEqual([first, second]);
    });

    it("lists nothing for an organization without harnesses", async () => {
      const [row] = await db.insert(organizations).values({ name: "No harnesses" }).returning();
      expect(await listReportedInstallables(db, row!.id)).toEqual([]);
      expect(await listActiveHarnessIds(db, row!.id)).toEqual([]);
    });
  });

  it("lists a repository's coding harnesses: its pinned ones, else those accepting coding", async () => {
    const [row] = await db.insert(organizations).values({ name: "Coding harnesses" }).returning();
    const org = row!.id;
    const [connection] = await db
      .insert(scmConnections)
      .values({
        organizationId: org,
        provider: "github",
        name: "coding",
        baseUrl: "https://api.github.com",
        encryptedCredentials: "x",
      })
      .returning();
    const repo = await connectRepository(db, {
      connectionId: connection!.id,
      provider: "github",
      externalId: "coding-1",
      fullPath: "acme/coding",
    });
    const inheriting = await enroll(org, "coding-a-inherits");
    const reviewOnly = await enroll(org, "coding-b-review-only");
    const revoked = await enroll(org, "coding-c-revoked");
    await recordHarnessHeartbeat(db, reviewOnly, {
      version: "1.0.0",
      acceptedTaskTypes: ["review"],
    });
    // A pin to a harness that was revoked since counts as none.
    await pinRepositoryToHarness(db, { harnessId: revoked, repositoryId: repo.id });
    await revokeHarness(db, revoked, { organizationId: org });
    await enroll(orgB, "coding-other-org");

    // Unpinned: every active harness that accepts coding (the task types it reports, all
    // until it reports any).
    const unpinned = (harnessIds: string[]) => ({ pinned: false, harnessIds });
    expect(await listRepositoryCodingHarnessIds(db, org, repo.id)).toEqual(unpinned([inheriting]));
    await recordHarnessHeartbeat(db, inheriting, {
      version: "1.0.0",
      acceptedTaskTypes: ["query"],
    });
    expect(await listRepositoryCodingHarnessIds(db, org, repo.id)).toEqual(unpinned([]));
    await recordHarnessHeartbeat(db, inheriting, {
      version: "1.0.0",
      acceptedTaskTypes: ["review", "coding"],
    });
    expect(await listRepositoryCodingHarnessIds(db, org, repo.id)).toEqual(unpinned([inheriting]));

    // Pinned: its active pinned harnesses, whatever they accept.
    await pinRepositoryToHarness(db, { harnessId: reviewOnly, repositoryId: repo.id });
    expect(await listRepositoryCodingHarnessIds(db, org, repo.id)).toEqual({
      pinned: true,
      harnessIds: [reviewOnly],
    });
  });

  it("stores the reported accepted task types, keeping them when a heartbeat has none", async () => {
    const a = await enroll(orgA, "a-task-types");
    const reported = async () => (await getHarnessOverview(db, orgA, a))!;
    expect((await reported()).reportedAcceptedTaskTypes).toBeNull();
    expect((await reported()).effective.acceptedTaskTypes).toEqual(["query", "review", "coding"]);
    const heartbeat = (acceptedTaskTypes?: string[]) =>
      recordHarnessHeartbeat(db, a, { version: "1.0.0", acceptedTaskTypes });
    expect((await heartbeat(["coding", "query"]))?.reportedAcceptedTaskTypes).toEqual([
      "coding",
      "query",
    ]);
    // Effective task types are in task type order.
    expect((await reported()).effective.acceptedTaskTypes).toEqual(["query", "coding"]);
    // An older agent reports none: the last report stays.
    expect((await heartbeat())?.reportedAcceptedTaskTypes).toEqual(["coding", "query"]);
    expect((await heartbeat(["review"]))?.reportedAcceptedTaskTypes).toEqual(["review"]);
  });

  it("replaces the reported installables with each heartbeat's", async () => {
    const a = await enroll(orgA, "a-installables");
    expect((await getHarnessOverview(db, orgA, a))?.reportedInstallables).toEqual([]);
    const hello = { name: "@omniralph/hello", version: "1.0.0" };
    const graph = { name: "@omniralph/code-graph", version: "0.3.1" };
    const heartbeat = (installables?: { name: string; version: string }[]) =>
      recordHarnessHeartbeat(db, a, { version: "1.0.0", installables });
    expect((await heartbeat([hello, graph]))?.reportedInstallables).toEqual([hello, graph]);
    expect((await heartbeat([{ ...hello, version: "1.1.0" }]))?.reportedInstallables).toEqual([
      { ...hello, version: "1.1.0" },
    ]);
    expect((await getHarnessOverview(db, orgA, a))?.reportedInstallables).toEqual([
      { ...hello, version: "1.1.0" },
    ]);
    expect((await heartbeat([]))?.reportedInstallables).toEqual([]);
    await heartbeat([hello]);
    // An older harness reports none: nothing is known to be installed.
    expect((await heartbeat())?.reportedInstallables).toEqual([]);
  });

  it("lists a harness's recent install jobs, newest first, within its organization", async () => {
    const a = await enroll(orgA, "a-install-jobs");
    const other = await enroll(orgA, "a-install-other");
    const now = new Date("2026-10-12T12:00:00Z");
    const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
    const job = (values: Partial<typeof jobs.$inferInsert>) => ({
      organizationId: orgA,
      type: "install",
      taskType: "system" as const,
      targetHarnessId: a,
      payload: { name: "@omniralph/hello" },
      ...values,
    });
    await db.insert(jobs).values([
      job({
        status: "completed",
        payload: { name: "@omniralph/hello", version: "1.0.0" },
        result: { name: "@omniralph/hello", version: "1.0.0", changed: true },
        createdAt: hoursAgo(2),
        finishedAt: hoursAgo(2),
      }),
      job({
        status: "failed",
        payload: { name: "@omniralph/graph" },
        error: "not allowed",
        createdAt: hoursAgo(1),
      }),
      job({ createdAt: hoursAgo(25) }),
      job({ targetHarnessId: other, createdAt: hoursAgo(1) }),
      job({ type: "repo.sync", createdAt: hoursAgo(1) }),
    ]);

    const listed = await listHarnessInstallJobs(db, orgA, a, hoursAgo(24));
    expect(listed).toEqual([
      expect.objectContaining({
        status: "failed",
        name: "@omniralph/graph",
        version: null,
        installedVersion: null,
        error: "not allowed",
      }),
      expect.objectContaining({
        status: "completed",
        name: "@omniralph/hello",
        version: "1.0.0",
        installedVersion: "1.0.0",
        error: null,
      }),
    ]);
    expect(await listHarnessInstallJobs(db, orgB, a, hoursAgo(24))).toEqual([]);
  });

  it("lists the latest sync job of each repository pinned to a harness", async () => {
    const a = await enroll(orgA, "a-sync-jobs");
    const other = await enroll(orgA, "a-sync-other");
    const [connection] = await db
      .insert(scmConnections)
      .values({
        organizationId: orgA,
        provider: "github",
        name: "sync",
        baseUrl: "https://api.github.com",
        externalId: "sync-jobs",
        encryptedCredentials: "x",
      })
      .returning();
    const repo = async (externalId: string) =>
      (
        await connectRepository(db, {
          connectionId: connection!.id,
          provider: "github",
          externalId,
          fullPath: `acme/sync-${externalId}`,
        })
      ).id;
    const [first, second] = [await repo("sync-1"), await repo("sync-2")];
    const now = new Date("2026-10-12T12:00:00Z");
    const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
    const job = (values: Partial<typeof jobs.$inferInsert>) => ({
      organizationId: orgA,
      type: "repo.sync",
      taskType: "system" as const,
      targetHarnessId: a,
      repositoryId: first,
      ...values,
    });
    const inserted = await db
      .insert(jobs)
      .values([
        job({ status: "failed", error: "clone failed", createdAt: hoursAgo(3) }),
        job({ status: "running", createdAt: hoursAgo(1) }),
        job({ repositoryId: second, status: "completed", createdAt: hoursAgo(2) }),
        job({ repositoryId: second, createdAt: hoursAgo(200) }),
        job({ targetHarnessId: other, createdAt: hoursAgo(0.5) }),
        job({ type: "install", createdAt: hoursAgo(0.5) }),
      ])
      .returning();

    const listed = await listHarnessPinSyncJobs(db, orgA, a, hoursAgo(24));
    expect(listed.map((j) => [j.repositoryId, j.id, j.status]).sort()).toEqual(
      [
        [first, inserted[1]!.id, "running"],
        [second, inserted[2]!.id, "completed"],
      ].sort(),
    );
    expect(await listHarnessPinSyncJobs(db, orgB, a, hoursAgo(24))).toEqual([]);
  });

  it("pages an organization's jobs and finds the page that shows a job", async () => {
    const [org] = await db.insert(organizations).values({ name: "Paged jobs" }).returning();
    const base = new Date("2026-10-01T00:00:00Z").getTime();
    const inserted = await db
      .insert(jobs)
      .values(
        Array.from({ length: 5 }, (_, i) => ({
          organizationId: org!.id,
          type: "repo.sync",
          taskType: "system" as const,
          status: i === 0 ? ("failed" as const) : ("completed" as const),
          createdAt: new Date(base + i * 60_000),
        })),
      )
      .returning({ id: jobs.id });
    const newestFirst = inserted.map((j) => j.id).reverse();

    const first = await listJobs(db, org!.id, { page: 1, pageSize: 2 });
    expect(first.total).toBe(5);
    expect(first.jobs.map((j) => j.id)).toEqual(newestFirst.slice(0, 2));
    const last = await listJobs(db, org!.id, { page: 3, pageSize: 2 });
    expect(last.jobs.map((j) => j.id)).toEqual(newestFirst.slice(4));
    const failed = await listJobs(db, org!.id, { statuses: ["failed"], pageSize: 2 });
    expect(failed.total).toBe(1);

    expect(await findJobPage(db, org!.id, newestFirst[0]!, 2)).toBe(1);
    expect(await findJobPage(db, org!.id, newestFirst[2]!, 2)).toBe(2);
    expect(await findJobPage(db, org!.id, newestFirst[4]!, 2)).toBe(3);
    expect(await findJobPage(db, orgB, newestFirst[4]!, 2)).toBeNull();
    expect(await findJobPage(db, org!.id, "not-a-uuid", 2)).toBeNull();
  });

  it("keeps an update request until the harness reports it handled", async () => {
    const a = await enroll(orgA, "a-update");
    expect(await requestHarnessUpdate(db, orgB, a, "2.0.0")).toBeNull();
    const first = await requestHarnessUpdate(db, orgA, a, "2.0.0");
    expect(first).toMatchObject({ updateRequestVersion: "2.0.0" });
    expect(first?.updateRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first?.updateRequestedAt).toBeInstanceOf(Date);
    // Asking again replaces the pending request.
    const second = await requestHarnessUpdate(db, orgA, a, "2.0.1");
    expect(second?.updateRequestId).not.toBe(first?.updateRequestId);

    const heartbeat = (handledUpdateRequestId?: string | null) =>
      recordHarnessHeartbeat(db, a, { version: "1.0.0", handledUpdateRequestId });
    expect(await heartbeat()).toMatchObject({ updateRequestId: second!.updateRequestId });
    // An older request is handled: the new one stays.
    expect(await heartbeat(first!.updateRequestId)).toMatchObject({
      updateRequestId: second!.updateRequestId,
      updateRequestVersion: "2.0.1",
    });
    expect(await heartbeat(second!.updateRequestId)).toMatchObject({
      updateRequestId: null,
      updateRequestVersion: null,
      updateRequestedAt: null,
    });

    await revokeHarness(db, a, { organizationId: orgA });
    expect(await requestHarnessUpdate(db, orgA, a, "2.0.0")).toBeNull();
  });

  it("pins a repository only to a harness of its own organization", async () => {
    const [connection] = await db
      .insert(scmConnections)
      .values({
        organizationId: orgA,
        provider: "github",
        name: "acme",
        baseUrl: "https://api.github.com",
        encryptedCredentials: "x",
      })
      .returning();
    const repo = await connectRepository(db, {
      connectionId: connection!.id,
      provider: "github",
      externalId: "1",
      fullPath: "acme/web",
    });
    const own = await enroll(orgA, "a-pin");
    const foreign = await enroll(orgB, "b-pin");
    expect(await pinRepositoryToHarness(db, { harnessId: foreign, repositoryId: repo.id })).toBe(
      "unknown_agent",
    );
    expect(await pinRepositoryToHarness(db, { harnessId: own, repositoryId: repo.id })).toBe(
      "pinned",
    );
  });

  it("keeps the desired harness version per organization", async () => {
    await setDesiredHarnessVersion(db, orgA, "1.4.0", null);
    expect(await getDesiredHarnessVersion(db, orgA)).toBe("1.4.0");
    expect(await getDesiredHarnessVersion(db, orgB)).toBeNull();
    await setDesiredHarnessVersion(db, orgB, "2.0.0", null);
    await setDesiredHarnessVersion(db, orgA, "1.5.0", null);
    expect(await getDesiredHarnessVersion(db, orgA)).toBe("1.5.0");
    expect(await getDesiredHarnessVersion(db, orgB)).toBe("2.0.0");
    await setDesiredHarnessVersion(db, orgA, null, null);
    expect(await getDesiredHarnessVersion(db, orgA)).toBeNull();
    expect(await getDesiredHarnessVersion(db, orgB)).toBe("2.0.0");
  });
});
