// Harnesses, enrollments and harness settings are scoped to organizations.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarnessEnrollment, enrollHarness, revokeHarness } from "./harness-auth.js";
import {
  getHarnessOverview,
  listHarnessOverview,
  markHarnessDeleted,
  requestHarnessUpdate,
  setHarnessDesiredVersion,
  updateHarnessConfig,
} from "./harnesses.js";
import { getDesiredHarnessVersion, setDesiredHarnessVersion } from "./app-settings.js";
import { closeDb, createDb, type Database } from "./client.js";
import { recordHarnessHeartbeat } from "./jobs.js";
import { runMigrations } from "./migrate.js";
import { getResourceOrganizationId } from "./resource-organization.js";
import { connectRepository, pinRepositoryToHarness } from "./repositories.js";
import { harnesses, organizations, scmConnections } from "./schema.js";
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
