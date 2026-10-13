// Harnesses, enrollments and harness settings are scoped to organizations.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarnessEnrollment, enrollHarness, revokeHarness } from "./harness-auth.js";
import {
  findJobPage,
  getHarnessOverview,
  resolveHarnessConfig,
  listJobs,
  listHarnessInstallJobs,
  listHarnessOverview,
  markHarnessDeleted,
  requestHarnessUpdate,
  setHarnessDesiredVersion,
  updateHarnessConfig,
} from "./harnesses.js";
import {
  getDesiredHarnessVersion,
  setAllowedTaskTypeDefaults,
  setDefaultMaxConcurrency,
  setDesiredHarnessVersion,
} from "./app-settings.js";
import { closeDb, createDb, type Database } from "./client.js";
import { recordHarnessHeartbeat } from "./jobs.js";
import { runMigrations } from "./migrate.js";
import { getResourceOrganizationId } from "./resource-organization.js";
import { connectRepository, pinRepositoryToHarness } from "./repositories.js";
import { harnesses, jobs, organizations, scmConnections } from "./schema.js";
import { filterActiveHarnessIds, listPinnableHarnesses, seedReviewProfiles } from "./settings.js";

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

describe.skipIf(!dockerAvailable)("organization-scoped harnesses", () => {
  let container: StartedPostgreSqlContainer;
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
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    const [a] = await db.insert(organizations).values({ name: "A" }).returning();
    const [b] = await db.insert(organizations).values({ name: "B" }).returning();
    orgA = a!.id;
    orgB = b!.id;
    await seedReviewProfiles(db, orgA);
    await seedReviewProfiles(db, orgB);
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await container?.stop();
  });

  it("creates the harness in the enrollment's organization", async () => {
    const harnessId = await enroll(orgB, "b-agent");
    const [row] = await db.select().from(harnesses);
    expect(row).toMatchObject({ id: harnessId, organizationId: orgB, name: "b-agent" });
  });

  it("lists, reads and updates only the organization's harnesses", async () => {
    const a = await enroll(orgA, "a-1");
    const b = await enroll(orgB, "b-1");
    expect((await listHarnessOverview(db, orgA)).map((r) => r.id)).toEqual([a]);
    expect((await listHarnessOverview(db, orgB)).map((r) => r.id)).toContain(b);
    expect((await listHarnessOverview(db, orgB)).map((r) => r.id)).not.toContain(a);
    expect(await getHarnessOverview(db, orgB, a)).toBeNull();
    expect((await getHarnessOverview(db, orgA, a))?.id).toBe(a);

    const config = {
      maxConcurrency: 2,
      acceptedTaskTypes: ["query" as const, "coding" as const, "query" as const],
      poolLimits: { long: 1 },
    };
    expect(await updateHarnessConfig(db, orgB, a, config)).toBeNull();
    expect(await updateHarnessConfig(db, orgA, a, config)).toMatchObject({
      maxConcurrency: 2,
      acceptedTaskTypes: ["query", "coding"],
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

  it("resolves a harness's own values, else its organization's defaults", async () => {
    const [org] = await db.insert(organizations).values({ name: "Defaults" }).returning();
    const organizationId = org!.id;
    const inheriting = await enroll(organizationId, "inheriting");
    const own = await enroll(organizationId, "own");
    await db
      .update(harnesses)
      .set({ maxConcurrency: 2, acceptedTaskTypes: ["review"] })
      .where(eq(harnesses.id, own));
    const config = async (harnessId: string) => {
      const [row] = await db.select().from(harnesses).where(eq(harnesses.id, harnessId));
      return resolveHarnessConfig(db, row!);
    };
    const effective = async (harnessId: string) =>
      (await getHarnessOverview(db, organizationId, harnessId))?.effective;

    // No organization settings: every task type, 5 at once.
    const builtIn = { acceptedTaskTypes: ["query", "review", "coding"], maxConcurrency: 5 };
    expect(await config(inheriting)).toEqual(builtIn);
    expect(await effective(inheriting)).toEqual(builtIn);
    const ownConfig = { acceptedTaskTypes: ["review"], maxConcurrency: 2 };
    expect(await config(own)).toEqual(ownConfig);

    await setDefaultMaxConcurrency(db, organizationId, 8, null);
    await setAllowedTaskTypeDefaults(db, organizationId, ["query"], null);
    const changed = { acceptedTaskTypes: ["query"], maxConcurrency: 8 };
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
      await updateHarnessConfig(db, organizationId, a, {
        maxConcurrency: 2,
        acceptedTaskTypes: ["review"],
        poolLimits: {},
      }),
    ).toMatchObject({ maxConcurrency: 2, acceptedTaskTypes: ["review"] });
    expect((await overview()).effective).toEqual({
      acceptedTaskTypes: ["review"],
      maxConcurrency: 2,
    });

    // Back to the organization's max concurrency, keeping the task types override.
    expect(
      await updateHarnessConfig(db, organizationId, a, {
        maxConcurrency: null,
        acceptedTaskTypes: ["review"],
        poolLimits: {},
      }),
    ).toMatchObject({ maxConcurrency: null, acceptedTaskTypes: ["review"] });
    expect(
      await updateHarnessConfig(db, organizationId, a, {
        maxConcurrency: null,
        acceptedTaskTypes: null,
        poolLimits: {},
      }),
    ).toMatchObject({ maxConcurrency: null, acceptedTaskTypes: null });
    const inheriting = await overview();
    expect(inheriting.effective).toEqual({
      acceptedTaskTypes: ["query", "review", "coding"],
      maxConcurrency: 7,
    });
    expect(inheriting.defaults).toEqual(inheriting.effective);
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
