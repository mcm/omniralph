// Agents, enrollments and agent settings are scoped to organizations.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentEnrollment, enrollAgent, revokeAgent } from "./agent-auth.js";
import {
  getAgentOverview,
  listAgentOverview,
  markAgentDeleted,
  requestAgentUpdate,
  setAgentDesiredVersion,
  updateAgentConfig,
} from "./agents.js";
import { getDesiredAgentVersion, setDesiredAgentVersion } from "./app-settings.js";
import { closeDb, createDb, type Database } from "./client.js";
import { recordAgentHeartbeat } from "./jobs.js";
import { runMigrations } from "./migrate.js";
import { getResourceOrganizationId } from "./resource-organization.js";
import { connectRepository, pinRepositoryToAgent } from "./repositories.js";
import { agents, organizations, scmConnections } from "./schema.js";
import { filterActiveAgentIds, listPinnableAgents, seedReviewProfiles } from "./settings.js";

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

describe.skipIf(!dockerAvailable)("organization-scoped agents", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let orgA: string;
  let orgB: string;

  const enroll = async (organizationId: string, name: string) => {
    const enrollment = await createAgentEnrollment(db, { organizationId, name });
    return (await enrollAgent(db, {
      enrollmentToken: enrollment.token,
      name: "host",
      version: "1.0.0",
      capabilities: ["review"],
    }))!.agentId;
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

  it("creates the agent in the enrollment's organization", async () => {
    const agentId = await enroll(orgB, "b-agent");
    const [row] = await db.select().from(agents);
    expect(row).toMatchObject({ id: agentId, organizationId: orgB, name: "b-agent" });
  });

  it("lists, reads and updates only the organization's agents", async () => {
    const a = await enroll(orgA, "a-1");
    const b = await enroll(orgB, "b-1");
    expect((await listAgentOverview(db, orgA)).map((r) => r.id)).toEqual([a]);
    expect((await listAgentOverview(db, orgB)).map((r) => r.id)).toContain(b);
    expect((await listAgentOverview(db, orgB)).map((r) => r.id)).not.toContain(a);
    expect(await getAgentOverview(db, orgB, a)).toBeNull();
    expect((await getAgentOverview(db, orgA, a))?.id).toBe(a);

    const config = { maxConcurrency: 2, enabledCapabilities: ["review"] };
    expect(await updateAgentConfig(db, orgB, a, config)).toBeNull();
    expect(await updateAgentConfig(db, orgA, a, config)).toMatchObject({ maxConcurrency: 2 });
    expect(await setAgentDesiredVersion(db, orgB, a, "9.9.9")).toBeNull();
    expect(await setAgentDesiredVersion(db, orgA, a, "1.2.3")).toMatchObject({
      desiredVersion: "1.2.3",
    });

    expect((await listPinnableAgents(db, orgB)).map((r) => r.id)).not.toContain(a);
    expect(await filterActiveAgentIds(db, orgB, [a, b])).toEqual(new Set([b]));

    expect(await revokeAgent(db, a, { organizationId: orgB })).toBeNull();
    expect((await getAgentOverview(db, orgA, a))?.revokedAt).toBeNull();
    expect(await revokeAgent(db, a, { organizationId: orgA })).not.toBeNull();
  });

  it("soft-deletes only revoked agents of the organization and hides them", async () => {
    const a = await enroll(orgA, "a-delete");
    expect(await markAgentDeleted(db, orgA, a)).toBe(false);
    await revokeAgent(db, a, { organizationId: orgA });
    expect(await markAgentDeleted(db, orgB, a)).toBe(false);
    expect(await markAgentDeleted(db, orgA, a)).toBe(true);
    expect(await markAgentDeleted(db, orgA, a)).toBe(false);

    expect((await listAgentOverview(db, orgA)).map((r) => r.id)).not.toContain(a);
    expect(await getAgentOverview(db, orgA, a)).toBeNull();
    expect(await getResourceOrganizationId(db, "agent", a)).toBeNull();
    const [row] = await db.select().from(agents).where(eq(agents.id, a));
    expect(row?.deletedAt).toBeInstanceOf(Date);
  });

  it("keeps an update request until the agent reports it handled", async () => {
    const a = await enroll(orgA, "a-update");
    expect(await requestAgentUpdate(db, orgB, a, "2.0.0")).toBeNull();
    const first = await requestAgentUpdate(db, orgA, a, "2.0.0");
    expect(first).toMatchObject({ updateRequestVersion: "2.0.0" });
    expect(first?.updateRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first?.updateRequestedAt).toBeInstanceOf(Date);
    // Asking again replaces the pending request.
    const second = await requestAgentUpdate(db, orgA, a, "2.0.1");
    expect(second?.updateRequestId).not.toBe(first?.updateRequestId);

    const heartbeat = (handledUpdateRequestId?: string | null) =>
      recordAgentHeartbeat(db, a, { version: "1.0.0", capabilities: [], handledUpdateRequestId });
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

    await revokeAgent(db, a, { organizationId: orgA });
    expect(await requestAgentUpdate(db, orgA, a, "2.0.0")).toBeNull();
  });

  it("pins a repository only to an agent of its own organization", async () => {
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
    expect(await pinRepositoryToAgent(db, { agentId: foreign, repositoryId: repo.id })).toBe(
      "unknown_agent",
    );
    expect(await pinRepositoryToAgent(db, { agentId: own, repositoryId: repo.id })).toBe("pinned");
  });

  it("keeps the desired agent version per organization", async () => {
    await setDesiredAgentVersion(db, orgA, "1.4.0", null);
    expect(await getDesiredAgentVersion(db, orgA)).toBe("1.4.0");
    expect(await getDesiredAgentVersion(db, orgB)).toBeNull();
    await setDesiredAgentVersion(db, orgB, "2.0.0", null);
    await setDesiredAgentVersion(db, orgA, "1.5.0", null);
    expect(await getDesiredAgentVersion(db, orgA)).toBe("1.5.0");
    expect(await getDesiredAgentVersion(db, orgB)).toBe("2.0.0");
    await setDesiredAgentVersion(db, orgA, null, null);
    expect(await getDesiredAgentVersion(db, orgA)).toBeNull();
    expect(await getDesiredAgentVersion(db, orgB)).toBe("2.0.0");
  });
});
