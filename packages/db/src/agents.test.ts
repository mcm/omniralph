// Agents, enrollments and agent settings are scoped to organizations.
import { createTestDatabase, testDatabaseAvailable, type TestDatabase } from "../testing/index.js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAgentEnrollment,
  enrollAgent,
  getAgentEnrollmentStatus,
  revokeAgent,
} from "./agent-auth.js";
import {
  findJobPage,
  getAgentOverview,
  listJobs,
  listAgentInstallJobs,
  listAgentPinSyncJobs,
  listActiveAgentIds,
  listAgentOverview,
  listReportedInstallables,
  listReportedModels,
  listRepositoryCodingAgentIds,
  markAgentDeleted,
  requestAgentUpdate,
} from "./agents.js";
import { getDesiredAgentVersion, setDesiredAgentVersion } from "./app-settings.js";
import { captureChanges } from "./changes.js";
import { closeDb, createDb, type Database } from "./client.js";
import { recordAgentHeartbeat } from "./jobs.js";
import { getResourceOrganizationId } from "./resource-organization.js";
import { connectRepository, pinRepositoryToAgent } from "./repositories.js";
import { agents, jobs, organizations, scmConnections } from "./schema.js";
import { filterActiveAgentIds, listPinnableAgents } from "./settings.js";

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("organization-scoped agents", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgA: string;
  let orgB: string;

  const enroll = async (organizationId: string, name: string) => {
    const enrollment = await createAgentEnrollment(db, { organizationId, name });
    return (await enrollAgent(db, {
      enrollmentToken: enrollment.token,
      name: "host",
      version: "1.0.0",
    }))!.agentId;
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

  it("creates the agent in the enrollment's organization", async () => {
    const agentId = await enroll(orgB, "b-agent");
    const [row] = await db.select().from(agents);
    expect(row).toMatchObject({ id: agentId, organizationId: orgB, name: "b-agent" });
  });

  it("reports which agent redeemed an enrollment, only to its organization", async () => {
    const enrollment = await createAgentEnrollment(db, { organizationId: orgB, name: "b-new" });
    expect(await getAgentEnrollmentStatus(db, orgB, enrollment.id)).toEqual({
      id: enrollment.id,
      expiresAt: enrollment.expiresAt,
      agent: null,
    });
    expect(await getAgentEnrollmentStatus(db, orgA, enrollment.id)).toBeNull();
    const { agentId } = (await enrollAgent(db, {
      enrollmentToken: enrollment.token,
      name: "host",
      version: "1.0.0",
    }))!;
    expect(await getAgentEnrollmentStatus(db, orgB, enrollment.id)).toMatchObject({
      agent: { id: agentId, name: "b-new" },
    });
    expect(await getAgentEnrollmentStatus(db, orgA, enrollment.id)).toBeNull();
  });

  it("lists, reads and updates only the organization's agents", async () => {
    const a = await enroll(orgA, "a-1");
    const b = await enroll(orgB, "b-1");
    expect((await listAgentOverview(db, orgA)).map((r) => r.id)).toEqual([a]);
    expect((await listAgentOverview(db, orgB)).map((r) => r.id)).toContain(b);
    expect((await listAgentOverview(db, orgB)).map((r) => r.id)).not.toContain(a);
    expect(await getAgentOverview(db, orgB, a)).toBeNull();
    expect((await getAgentOverview(db, orgA, a))?.id).toBe(a);

    expect((await listPinnableAgents(db, orgB)).map((r) => r.id)).not.toContain(a);
    expect(await filterActiveAgentIds(db, orgB, [a, b])).toEqual(new Set([b]));

    expect(await revokeAgent(db, a, { organizationId: orgB })).toBeNull();
    expect((await getAgentOverview(db, orgA, a))?.revokedAt).toBeNull();
    expect(await revokeAgent(db, a, { organizationId: orgA })).not.toBeNull();
  });

  it("runs the task types an agent reports, every one until it reports any", async () => {
    const [org] = await db.insert(organizations).values({ name: "Defaults" }).returning();
    const organizationId = org!.id;
    const unreported = await enroll(organizationId, "unreported");
    const narrowed = await enroll(organizationId, "narrowed");
    await db
      .update(agents)
      .set({ reportedAcceptedTaskTypes: ["review", "query"] })
      .where(eq(agents.id, narrowed));
    const effective = async (agentId: string) =>
      (await getAgentOverview(db, organizationId, agentId))?.effective;

    expect(await effective(unreported)).toEqual({
      acceptedTaskTypes: ["query", "review", "coding"],
    });
    // In `TASK_TYPES` order.
    expect(await effective(narrowed)).toEqual({ acceptedTaskTypes: ["query", "review"] });
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

  it("replaces the reported models with each heartbeat's", async () => {
    const a = await enroll(orgA, "a-models");
    const opus = { value: "opus", displayName: "Opus" };
    const heartbeat = (models?: { value: string; displayName: string }[]) =>
      recordAgentHeartbeat(db, a, { version: "1.0.0", models });
    expect((await heartbeat([opus]))?.reportedModels).toEqual([opus]);
    expect((await getAgentOverview(db, orgA, a))?.reportedModels).toEqual([opus]);
    // An older agent, or one whose login can't list them, reports none.
    expect((await heartbeat())?.reportedModels).toEqual([]);
  });

  it("stores the reported local settings and announces the agent only when they change", async () => {
    const a = await enroll(orgA, "a-local");
    type Local = {
      maxConcurrency: number;
      poolLimits: { short: number; long: number };
      versionPin: string | null;
      installablesAllow: string[];
    };
    const local: Local = {
      maxConcurrency: 4,
      poolLimits: { short: 4, long: 3 },
      versionPin: null,
      installablesAllow: ["@omniralph/*"],
    };
    const heartbeat = (report?: Local) =>
      captureChanges(() => recordAgentHeartbeat(db, a, { version: "1.0.0", local: report }));
    const agentChanges = (changes: { resource: string }[]) =>
      changes.filter((change) => change.resource === "agent");

    const first = await heartbeat(local);
    expect(first.result).toMatchObject({
      reportedMaxConcurrency: 4,
      reportedPoolLimits: { short: 4, long: 3 },
      reportedVersionPin: null,
      reportedInstallablesAllow: ["@omniralph/*"],
    });
    expect(agentChanges(first.changes)).toHaveLength(1);
    // A steady heartbeat announces nothing.
    expect(agentChanges((await heartbeat(local)).changes)).toEqual([]);
    for (const changed of [
      { ...local, maxConcurrency: 6 },
      { ...local, maxConcurrency: 6, poolLimits: { short: 6, long: 2 } },
      { ...local, maxConcurrency: 6, poolLimits: { short: 6, long: 2 }, versionPin: "2.0.3" },
      {
        maxConcurrency: 6,
        poolLimits: { short: 6, long: 2 },
        versionPin: "2.0.3",
        installablesAllow: [],
      },
    ] satisfies Local[]) {
      const { result, changes } = await heartbeat(changed);
      expect(agentChanges(changes)).toHaveLength(1);
      expect(result).toMatchObject({
        reportedMaxConcurrency: changed.maxConcurrency,
        reportedPoolLimits: changed.poolLimits,
        reportedVersionPin: changed.versionPin,
        reportedInstallablesAllow: changed.installablesAllow,
      });
    }
    // A heartbeat without the report keeps the last one.
    expect((await heartbeat()).result?.reportedMaxConcurrency).toBe(6);
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
      await recordAgentHeartbeat(db, first, { version: "1.0.0", models: [opus, sonnet] });
      await recordAgentHeartbeat(db, second, { version: "1.0.0", models: [sonnet, haiku] });
      await recordAgentHeartbeat(db, revoked, { version: "1.0.0", models: [fable] });
      await recordAgentHeartbeat(db, other, { version: "1.0.0", models: [fable] });
      await revokeAgent(db, revoked, { organizationId: org });
    });

    it("de-duplicates overlapping models, sorted by display name, with their agents", async () => {
      expect(await listReportedModels(db, org)).toEqual([
        { ...haiku, agentIds: [second] },
        { ...opus, agentIds: [first] },
        { ...sonnet, agentIds: [first, second] },
      ]);
    });

    it("filters by agent, ignoring other organizations' agents", async () => {
      expect(await listReportedModels(db, org, { agentIds: [second] })).toEqual([
        { ...haiku, agentIds: [second] },
        { ...sonnet, agentIds: [second] },
      ]);
      expect(await listReportedModels(db, org, { agentIds: [] })).toEqual([]);
      const [other] = await listAgentOverview(db, orgB);
      expect(await listReportedModels(db, org, { agentIds: [other!.id] })).toEqual([]);
    });

    it("ignores revoked agents, even when asked for them", async () => {
      expect(await listReportedModels(db, org, { agentIds: [revoked] })).toEqual([]);
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
      await recordAgentHeartbeat(db, first, { version: "1.0.0", installables: [hello("1.0.0")] });
      await recordAgentHeartbeat(db, second, {
        version: "1.0.0",
        installables: [hello("1.1.0"), graph],
      });
      await recordAgentHeartbeat(db, revoked, {
        version: "1.0.0",
        installables: [{ name: "@omniralph/gone", version: "1.0.0" }],
      });
      await revokeAgent(db, revoked, { organizationId: org });
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
        targetAgentId: second,
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

    it("lists reported installables by name with their agents and latest MCP servers", async () => {
      expect(await listReportedInstallables(db, org)).toEqual([
        { name: graph.name, agentIds: [second], mcpServers: [] },
        { name: "@omniralph/hello", agentIds: [first, second], mcpServers: ["greet"] },
      ]);
      expect(await listActiveAgentIds(db, org)).toEqual([first, second]);
    });

    it("lists nothing for an organization without agents", async () => {
      const [row] = await db.insert(organizations).values({ name: "No agents" }).returning();
      expect(await listReportedInstallables(db, row!.id)).toEqual([]);
      expect(await listActiveAgentIds(db, row!.id)).toEqual([]);
    });
  });

  it("lists a repository's coding agents: its pinned ones, else those accepting coding", async () => {
    const [row] = await db.insert(organizations).values({ name: "Coding agents" }).returning();
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
    await recordAgentHeartbeat(db, reviewOnly, {
      version: "1.0.0",
      acceptedTaskTypes: ["review"],
    });
    // A pin to an agent that was revoked since counts as none.
    await pinRepositoryToAgent(db, { agentId: revoked, repositoryId: repo.id });
    await revokeAgent(db, revoked, { organizationId: org });
    await enroll(orgB, "coding-other-org");

    // Unpinned: every active agent that accepts coding (the task types it reports, all
    // until it reports any).
    const unpinned = (agentIds: string[]) => ({ pinned: false, agentIds });
    expect(await listRepositoryCodingAgentIds(db, org, repo.id)).toEqual(unpinned([inheriting]));
    await recordAgentHeartbeat(db, inheriting, {
      version: "1.0.0",
      acceptedTaskTypes: ["query"],
    });
    expect(await listRepositoryCodingAgentIds(db, org, repo.id)).toEqual(unpinned([]));
    await recordAgentHeartbeat(db, inheriting, {
      version: "1.0.0",
      acceptedTaskTypes: ["review", "coding"],
    });
    expect(await listRepositoryCodingAgentIds(db, org, repo.id)).toEqual(unpinned([inheriting]));

    // Pinned: its active pinned agents, whatever they accept.
    await pinRepositoryToAgent(db, { agentId: reviewOnly, repositoryId: repo.id });
    expect(await listRepositoryCodingAgentIds(db, org, repo.id)).toEqual({
      pinned: true,
      agentIds: [reviewOnly],
    });
  });

  it("stores the reported accepted task types, keeping them when a heartbeat has none", async () => {
    const a = await enroll(orgA, "a-task-types");
    const reported = async () => (await getAgentOverview(db, orgA, a))!;
    expect((await reported()).reportedAcceptedTaskTypes).toBeNull();
    expect((await reported()).effective.acceptedTaskTypes).toEqual(["query", "review", "coding"]);
    const heartbeat = (acceptedTaskTypes?: string[]) =>
      recordAgentHeartbeat(db, a, { version: "1.0.0", acceptedTaskTypes });
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
    expect((await getAgentOverview(db, orgA, a))?.reportedInstallables).toEqual([]);
    const hello = { name: "@omniralph/hello", version: "1.0.0" };
    const graph = { name: "@omniralph/code-graph", version: "0.3.1" };
    const heartbeat = (installables?: { name: string; version: string }[]) =>
      recordAgentHeartbeat(db, a, { version: "1.0.0", installables });
    expect((await heartbeat([hello, graph]))?.reportedInstallables).toEqual([hello, graph]);
    expect((await heartbeat([{ ...hello, version: "1.1.0" }]))?.reportedInstallables).toEqual([
      { ...hello, version: "1.1.0" },
    ]);
    expect((await getAgentOverview(db, orgA, a))?.reportedInstallables).toEqual([
      { ...hello, version: "1.1.0" },
    ]);
    expect((await heartbeat([]))?.reportedInstallables).toEqual([]);
    await heartbeat([hello]);
    // An older agent reports none: nothing is known to be installed.
    expect((await heartbeat())?.reportedInstallables).toEqual([]);
  });

  it("lists an agent's recent install jobs, newest first, within its organization", async () => {
    const a = await enroll(orgA, "a-install-jobs");
    const other = await enroll(orgA, "a-install-other");
    const now = new Date("2026-10-12T12:00:00Z");
    const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
    const job = (values: Partial<typeof jobs.$inferInsert>) => ({
      organizationId: orgA,
      type: "install",
      taskType: "system" as const,
      targetAgentId: a,
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
      job({ targetAgentId: other, createdAt: hoursAgo(1) }),
      job({ type: "repo.sync", createdAt: hoursAgo(1) }),
    ]);

    const listed = await listAgentInstallJobs(db, orgA, a, hoursAgo(24));
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
    expect(await listAgentInstallJobs(db, orgB, a, hoursAgo(24))).toEqual([]);
  });

  it("lists the latest sync job of each repository pinned to an agent", async () => {
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
      targetAgentId: a,
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
        job({ targetAgentId: other, createdAt: hoursAgo(0.5) }),
        job({ type: "install", createdAt: hoursAgo(0.5) }),
      ])
      .returning();

    const listed = await listAgentPinSyncJobs(db, orgA, a, hoursAgo(24));
    expect(listed.map((j) => [j.repositoryId, j.id, j.status]).sort()).toEqual(
      [
        [first, inserted[1]!.id, "running"],
        [second, inserted[2]!.id, "completed"],
      ].sort(),
    );
    expect(await listAgentPinSyncJobs(db, orgB, a, hoursAgo(24))).toEqual([]);
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
      recordAgentHeartbeat(db, a, { version: "1.0.0", handledUpdateRequestId });
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
