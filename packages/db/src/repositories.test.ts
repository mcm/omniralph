import { randomBytes, randomUUID } from "node:crypto";
import { createTestDatabase, testDatabaseAvailable, type TestDatabase } from "../testing/index.js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureChanges } from "./changes.js";
import { closeDb, createDb, type Database } from "./client.js";
import {
  connectionCredentials,
  connectRepository,
  deleteScmConnection,
  disconnectRepository,
  findScmConnectionsByExternalId,
  getRepository,
  getRepositoryWithConnection,
  getScmConnection,
  listRepositoryOverview,
  listRepositoryOverviewPage,
  listScmConnections,
  repositorySwitches,
  setRepositoryDefaultBranch,
  setRepositoryEnabled,
  setRepositorySwitches,
  upsertScmConnection,
  WorkItemMatchRequiredError,
} from "./repositories.js";
import { deleteWorkItemMatch, saveWorkItemMatch } from "./work-item-matches.js";
import { pinnedAgentFor } from "./jobs.js";
import { revokeAgent } from "./agent-auth.js";
import { loadRepositoryStatusFacts } from "./repository-status.js";
import {
  agentRepoPins,
  agents,
  jobs,
  organizations,
  repositories,
  reviews,
  scmConnections,
  workItemMatches,
} from "./schema.js";
import { updateRepositorySettings } from "./settings.js";

const databaseAvailable = testDatabaseAvailable();

const key = randomBytes(32);

describe.skipIf(!databaseAvailable)("repository queries", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  it("upserts connections by provider, base URL and external ID, encrypting credentials", async () => {
    const input = {
      organizationId: orgId,
      provider: "gitlab" as const,
      name: "omniralph-bot",
      baseUrl: "https://gitlab.example.com",
      externalId: "42",
      credentials: { token: "glpat-first", webhookSecret: "s1" },
    };
    const first = (await upsertScmConnection(db, input, key))!;
    const second = (await upsertScmConnection(
      db,
      { ...input, credentials: { token: "glpat-second" } },
      key,
    ))!;
    expect(second.id).toBe(first.id);
    expect(second.encryptedCredentials).not.toContain("glpat");
    expect(connectionCredentials(second, key)).toEqual({ token: "glpat-second" });
  });

  it("stores a repo's default branch only when it changed, recording a repository change", async () => {
    const [connection] = await db
      .insert(scmConnections)
      .values({
        organizationId: orgId,
        provider: "gitlab",
        name: "default-branch",
        baseUrl: "https://gitlab.example.com",
        externalId: "default-branch",
        encryptedCredentials: "x",
      })
      .returning();
    const repo = await connectRepository(db, {
      connectionId: connection!.id,
      provider: "gitlab",
      externalId: "4211",
      fullPath: "managed-services/customer-portal",
    });
    expect(repo.defaultBranch).toBeNull();

    const first = await captureChanges(() => setRepositoryDefaultBranch(db, repo.id, "main"));
    expect(first.result).toBe(true);
    expect(first.changes).toEqual([
      expect.objectContaining({ resource: "repository", ids: [repo.id], organizationId: orgId }),
    ]);
    expect((await getRepository(db, repo.id))?.defaultBranch).toBe("main");

    const repeat = await captureChanges(() => setRepositoryDefaultBranch(db, repo.id, "main"));
    expect(repeat).toEqual({ result: false, changes: [] });

    const renamed = await captureChanges(() => setRepositoryDefaultBranch(db, repo.id, "trunk"));
    expect(renamed.result).toBe(true);
    expect(renamed.changes).toHaveLength(1);
    expect((await getRepository(db, repo.id))?.defaultBranch).toBe("trunk");

    expect(await setRepositoryDefaultBranch(db, randomUUID(), "main")).toBe(false);
  });

  it("saves each switch on or off, whatever the organization's task types; Coding needs a work item match", async () => {
    const connection = (await upsertScmConnection(
      db,
      {
        organizationId: orgId,
        provider: "github",
        name: "switches",
        baseUrl: "https://api.github.com",
        externalId: "3003",
        credentials: {},
      },
      key,
    ))!;
    const repo = await connectRepository(db, {
      connectionId: connection.id,
      provider: "github",
      externalId: "1",
      fullPath: "acme/switches",
    });
    // A new repository has Reviews and Ask on and Coding off.
    expect(repositorySwitches(repo)).toEqual({ reviews: true, coding: false, ask: true });
    try {
      expect(repositorySwitches((await getRepository(db, repo.id))!)).toEqual({
        reviews: true,
        coding: false,
        ask: true,
      });
      expect(await setRepositoryEnabled(db, orgId, repo.id, false)).toBe(true);
      expect((await listRepositoryOverview(db, orgId)).find((r) => r.id === repo.id)).toMatchObject(
        { reviewsEnabled: false, codingEnabled: false, askEnabled: true },
      );

      // Coding can't be turned on without a work item match; nothing is saved.
      await expect(
        setRepositorySwitches(db, orgId, repo.id, { reviews: true, coding: true, ask: false }),
      ).rejects.toMatchObject({ action: "turn_on_coding", repositoryId: repo.id });
      expect(repositorySwitches((await getRepository(db, repo.id))!)).toEqual({
        reviews: false,
        coding: false,
        ask: true,
      });

      // With a match it can; omitted switches stay as they are.
      await saveWorkItemMatch(db, {
        organizationId: orgId,
        repositoryId: repo.id,
        userId: null,
        match: { tracker: "linear", team: "ENG", project: null, withoutProject: false, labels: [] },
      });
      expect(await setRepositorySwitches(db, orgId, repo.id, { coding: true, ask: false })).toEqual(
        { reviews: false, coding: true, ask: false },
      );
      // The match can't be removed while Coding is on.
      await expect(deleteWorkItemMatch(db, orgId, repo.id)).rejects.toMatchObject({
        action: "remove_match",
      });
      expect(await setRepositorySwitches(db, orgId, repo.id, { coding: false })).toEqual({
        reviews: false,
        coding: false,
        ask: false,
      });
      expect(await deleteWorkItemMatch(db, orgId, repo.id)).toBe(true);
      expect(await deleteWorkItemMatch(db, orgId, repo.id)).toBe(false);

      // A repository that had Coding on before work item matches keeps it until switched off.
      await db
        .update(repositories)
        .set({ codingEnabled: true })
        .where(eq(repositories.id, repo.id));
      expect(await setRepositorySwitches(db, orgId, repo.id, { coding: true, ask: true })).toEqual({
        reviews: false,
        coding: true,
        ask: true,
      });
      expect(await setRepositorySwitches(db, orgId, repo.id, { coding: false })).toMatchObject({
        coding: false,
      });
      await expect(setRepositorySwitches(db, orgId, repo.id, { coding: true })).rejects.toThrow(
        WorkItemMatchRequiredError,
      );

      // Another organization can't change it.
      expect(await setRepositorySwitches(db, randomUUID(), repo.id, { reviews: true })).toBeNull();
      expect(await setRepositorySwitches(db, randomUUID(), repo.id, { coding: true })).toBeNull();
      expect((await getRepository(db, repo.id))?.reviewsEnabled).toBe(false);
    } finally {
      await db.delete(scmConnections).where(eq(scmConnections.id, connection.id));
    }
  });

  it("lists connected repos with profile, pins and last review; disconnect keeps history", async () => {
    const connection = (await upsertScmConnection(
      db,
      {
        organizationId: orgId,
        provider: "github",
        name: "acme",
        baseUrl: "https://api.github.com",
        externalId: "1001",
        credentials: {},
      },
      key,
    ))!;
    const repo = await connectRepository(db, {
      connectionId: connection.id,
      provider: "github",
      externalId: "555",
      fullPath: "acme/web",
    });
    const [agent] = await db
      .insert(agents)
      .values({ organizationId: orgId, name: "coder-1" })
      .returning();
    await db.insert(agentRepoPins).values({ agentId: agent!.id, repositoryId: repo.id });
    const reviewedAt = new Date("2026-10-01T12:00:00Z");
    await db.insert(reviews).values([
      {
        repositoryId: repo.id,
        prNumber: 1,
        headSha: "a",
        baseSha: "b",
        trigger: "webhook",
        budget: 1,
        createdAt: new Date("2026-09-01T00:00:00Z"),
      },
      {
        repositoryId: repo.id,
        prNumber: 2,
        headSha: "c",
        baseSha: "d",
        trigger: "webhook",
        budget: 1,
        createdAt: reviewedAt,
      },
    ]);

    const [row] = (await listRepositoryOverview(db, orgId)).filter((r) => r.id === repo.id);
    expect(row).toMatchObject({
      provider: "github",
      fullPath: "acme/web",
      reviewsEnabled: true,
      connectionName: "acme",
      reviewDepth: "standard",
      pinnedAgents: [{ id: agent!.id, name: "coder-1" }],
      lastReviewAt: reviewedAt,
    });

    expect(await setRepositoryEnabled(db, orgId, repo.id, false)).toBe(true);
    expect(
      (await listRepositoryOverview(db, orgId)).find((r) => r.id === repo.id)?.reviewsEnabled,
    ).toBe(false);

    const disconnected = await disconnectRepository(db, orgId, repo.id);
    expect(disconnected).toMatchObject({ reviewsEnabled: false, webhookId: null });
    expect(disconnected?.disconnectedAt).toBeInstanceOf(Date);
    expect((await listRepositoryOverview(db, orgId)).some((r) => r.id === repo.id)).toBe(false);
    expect(
      await db.select().from(agentRepoPins).where(eq(agentRepoPins.repositoryId, repo.id)),
    ).toEqual([]);
    expect(await db.select().from(reviews).where(eq(reviews.repositoryId, repo.id))).toHaveLength(
      2,
    );
    expect(await setRepositoryEnabled(db, orgId, repo.id, true)).toBe(false);

    // Reconnecting revives the same row (and its history).
    const again = await connectRepository(db, {
      connectionId: connection.id,
      provider: "github",
      externalId: "555",
      fullPath: "acme/web-renamed",
    });
    expect(again).toMatchObject({
      id: repo.id,
      // Reviews are on again.
      reviewsEnabled: true,
      disconnectedAt: null,
      fullPath: "acme/web-renamed",
    });
    await db.delete(scmConnections).where(eq(scmConnections.id, connection.id));
  });

  it("sends a pinned repo's jobs to an online agent first, then the least busy", async () => {
    const connection = (await upsertScmConnection(
      db,
      {
        organizationId: orgId,
        provider: "github",
        name: "pins",
        baseUrl: "https://api.github.com",
        externalId: "3003",
        credentials: {},
      },
      key,
    ))!;
    const repo = await connectRepository(db, {
      connectionId: connection.id,
      provider: "github",
      externalId: "777",
      fullPath: "acme/pinned",
    });
    expect(await pinnedAgentFor(db, orgId, repo.id)).toBeNull();
    const agent = async (name: string, values: Partial<typeof agents.$inferInsert>) => {
      const [row] = await db
        .insert(agents)
        .values({ organizationId: orgId, name, ...values })
        .returning();
      await db.insert(agentRepoPins).values({ agentId: row!.id, repositoryId: repo.id });
      return row!.id;
    };
    // Offline with the most recent row heartbeat (its row is exact).
    await agent("offline", { lastHeartbeatAt: new Date(), liveOnline: false });
    // Online with a row heartbeat up to a day old (it's only written once a day).
    const busy = await agent("busy", {
      lastHeartbeatAt: new Date(Date.now() - 3600_000),
      liveOnline: true,
    });
    expect(await pinnedAgentFor(db, orgId, repo.id)).toBe(busy);
    await db.insert(jobs).values({
      organizationId: orgId,
      type: "review.run",
      taskType: "review",
      agentId: busy,
      status: "running",
    });
    const idle = await agent("idle", {
      lastHeartbeatAt: new Date(Date.now() - 7200_000),
      liveOnline: true,
    });
    expect(await pinnedAgentFor(db, orgId, repo.id)).toBe(idle);
  });

  it("treats a revoked agent's kept pins as none until it's back", async () => {
    const connection = (await upsertScmConnection(
      db,
      {
        organizationId: orgId,
        provider: "github",
        name: "revoked-pins",
        baseUrl: "https://api.github.com",
        externalId: "4004",
        credentials: {},
      },
      key,
    ))!;
    const repo = await connectRepository(db, {
      connectionId: connection.id,
      provider: "github",
      externalId: "888",
      fullPath: "acme/revoked-pins",
    });
    const [agent] = await db
      .insert(agents)
      .values({ organizationId: orgId, name: "revoked-1", liveOnline: true })
      .returning();
    await db.insert(agentRepoPins).values({ agentId: agent!.id, repositoryId: repo.id });
    const facts = () =>
      loadRepositoryStatusFacts(db, { organizationIds: [orgId], repositoryIds: [repo.id] });
    const listed = async () =>
      (await listRepositoryOverview(db, orgId)).find((r) => r.id === repo.id)!.pinnedAgents;

    await revokeAgent(db, agent!.id);
    expect(await pinnedAgentFor(db, orgId, repo.id)).toBeNull();
    expect((await facts()).pins.get(repo.id)).toBeUndefined();
    expect(await listed()).toEqual([]);

    // Re-enrolled (no longer revoked): the same pin counts again.
    await db.update(agents).set({ revokedAt: null }).where(eq(agents.id, agent!.id));
    expect(await pinnedAgentFor(db, orgId, repo.id)).toBe(agent!.id);
    expect((await facts()).pins.get(repo.id)).toEqual([agent!.id]);
    expect(await listed()).toEqual([{ id: agent!.id, name: "revoked-1" }]);
  });

  it("turns everything off and deletes the match on disconnect; reconnecting starts with Coding off", async () => {
    const connection = (await upsertScmConnection(
      db,
      {
        organizationId: orgId,
        provider: "gitlab",
        name: "bot @ gitlab.example.com",
        baseUrl: "https://gitlab.example.com",
        externalId: "7001",
        credentials: {},
      },
      key,
    ))!;
    const input = {
      connectionId: connection.id,
      provider: "gitlab",
      externalId: "102",
      fullPath: "managed-services/customer-portal",
    } as const;
    const repo = await connectRepository(db, input);
    expect(repo).toMatchObject({ reviewsEnabled: true, askEnabled: true, codingEnabled: false });
    await saveWorkItemMatch(db, {
      organizationId: orgId,
      repositoryId: repo.id,
      userId: null,
      match: { tracker: "linear", team: "SOC", project: null, withoutProject: false, labels: [] },
    });
    await setRepositorySwitches(db, orgId, repo.id, { coding: true });
    // Connecting a repository that's still connected keeps its switches.
    expect(await connectRepository(db, input)).toMatchObject({
      askEnabled: true,
      codingEnabled: true,
    });

    const { changes } = await captureChanges(() => disconnectRepository(db, orgId, repo.id));
    expect(changes).toContainEqual(
      expect.objectContaining({ resource: "repository", ids: [repo.id] }),
    );
    expect(await getRepository(db, repo.id)).toMatchObject({
      reviewsEnabled: false,
      codingEnabled: false,
      askEnabled: false,
    });
    expect(
      await db.select().from(workItemMatches).where(eq(workItemMatches.repositoryId, repo.id)),
    ).toEqual([]);

    expect(await connectRepository(db, input)).toMatchObject({
      id: repo.id,
      reviewsEnabled: true,
      askEnabled: true,
      codingEnabled: false,
      disconnectedAt: null,
    });
    await db.delete(scmConnections).where(eq(scmConnections.id, connection.id));
  });

  it("pages connected repositories in path order, skipping disconnected ones", async () => {
    const connection = (await upsertScmConnection(
      db,
      {
        organizationId: orgId,
        provider: "gitlab",
        name: "paged",
        baseUrl: "https://gitlab.paged.example",
        externalId: "7",
        credentials: {},
      },
      key,
    ))!;
    const repos = [];
    for (const [i, path] of ["paged/c", "paged/a", "paged/e", "paged/b", "paged/d"].entries()) {
      repos.push(
        await connectRepository(db, {
          connectionId: connection.id,
          provider: "gitlab",
          externalId: String(100 + i),
          fullPath: path,
        }),
      );
    }
    await disconnectRepository(db, orgId, repos[4]!.id);

    const all = (await listRepositoryOverview(db, orgId)).map((r) => r.id);
    const pages = [];
    for (let page = 1; page <= Math.ceil(all.length / 2); page++) {
      const result = await listRepositoryOverviewPage(db, orgId, { page, pageSize: 2 });
      expect(result).toMatchObject({ total: all.length, page, pageSize: 2 });
      pages.push(...result.repositories.map((r) => r.id));
    }
    expect(pages).toEqual(all);
    expect(all).not.toContain(repos[4]!.id);
    const paged = (await listRepositoryOverview(db, orgId))
      .filter((r) => r.connectionId === connection.id)
      .map((r) => r.fullPath);
    expect(paged).toEqual(["paged/a", "paged/b", "paged/c", "paged/e"]);

    const past = await listRepositoryOverviewPage(db, orgId, { page: 99, pageSize: 2 });
    expect(past).toMatchObject({ repositories: [], total: all.length, page: 99 });

    // A search keeps the paths containing it, ignoring case; LIKE wildcards match literally.
    const found = await listRepositoryOverviewPage(db, orgId, { search: "PAGED/", pageSize: 3 });
    expect(found.total).toBe(4);
    expect(found.repositories.map((r) => r.fullPath)).toEqual(["paged/a", "paged/b", "paged/c"]);
    const one = await listRepositoryOverviewPage(db, orgId, { search: " ed/e " });
    expect(one.repositories.map((r) => r.fullPath)).toEqual(["paged/e"]);
    expect((await listRepositoryOverviewPage(db, orgId, { search: "paged_" })).total).toBe(0);
    expect((await listRepositoryOverviewPage(db, orgId, { search: "%" })).total).toBe(0);

    await db
      .update(repositories)
      .set({ reviewDepth: "deep" })
      .where(eq(repositories.id, repos[1]!.id));
    const byDepth = (await listRepositoryOverview(db, orgId)).filter((r) =>
      r.fullPath.startsWith("paged/"),
    );
    expect(byDepth.map((r) => [r.fullPath, r.reviewDepth])).toEqual([
      ["paged/a", "deep"],
      ["paged/b", "standard"],
      ["paged/c", "standard"],
      ["paged/e", "standard"],
    ]);
    await db.delete(scmConnections).where(eq(scmConnections.id, connection.id));
  });

  it("keeps connections and repositories inside their organization", async () => {
    const [other] = await db.insert(organizations).values({ name: "Other" }).returning();
    const otherId = other!.id;
    const input = {
      provider: "github" as const,
      name: "acme",
      baseUrl: "https://api.github.com",
      externalId: "3003",
      credentials: {},
    };
    const connection = (await upsertScmConnection(db, { ...input, organizationId: orgId }, key))!;
    // The installation belongs to `orgId`: another organization can't take it over.
    expect(
      await upsertScmConnection(db, { ...input, organizationId: otherId, name: "taken" }, key),
    ).toBeNull();
    expect((await getScmConnection(db, orgId, connection.id))?.name).toBe("acme");
    expect(await getScmConnection(db, otherId, connection.id)).toBeNull();
    expect((await listScmConnections(db, otherId)).map((c) => c.id)).not.toContain(connection.id);

    const repo = await connectRepository(db, {
      connectionId: connection.id,
      provider: "github",
      externalId: "777",
      fullPath: "acme/scoped",
    });
    expect(repo.organizationId).toBe(orgId);
    expect(await getRepository(db, repo.id, orgId)).not.toBeNull();
    expect(await getRepository(db, repo.id, otherId)).toBeNull();
    expect(await getRepositoryWithConnection(db, repo.id, otherId)).toBeNull();
    expect((await listRepositoryOverview(db, otherId)).map((r) => r.id)).not.toContain(repo.id);
    expect(await setRepositoryEnabled(db, otherId, repo.id, false)).toBe(false);
    expect(await disconnectRepository(db, otherId, repo.id)).toBeNull();
    expect((await getRepository(db, repo.id))?.reviewsEnabled).toBe(true);

    // Another organization can't change the repository's depth.
    const settings = {
      depth: "deep" as const,
      triggers: { onOpen: true, onPush: true, drafts: false },
      pathExcludes: [],
      customInstructions: null,
    };
    expect(await updateRepositorySettings(db, otherId, repo.id, settings)).toBeNull();
    expect((await getRepository(db, repo.id))?.reviewDepth).toBe("standard");
    expect(await updateRepositorySettings(db, orgId, repo.id, settings)).toMatchObject({
      reviewDepth: "deep",
    });
    await db.delete(scmConnections).where(eq(scmConnections.id, connection.id));
  });
  it("removes a connection with its repositories so another organization can connect it", async () => {
    const [other] = await db.insert(organizations).values({ name: "Removal" }).returning();
    const otherId = other!.id;
    const input = {
      provider: "github" as const,
      name: "acme",
      baseUrl: "https://api.github.com",
      externalId: "4004",
      credentials: {},
    };
    const connection = (await upsertScmConnection(db, { ...input, organizationId: orgId }, key))!;
    const repo = await connectRepository(db, {
      connectionId: connection.id,
      provider: "github",
      externalId: "888",
      fullPath: "acme/removed",
    });
    const [agent] = await db
      .insert(agents)
      .values({ organizationId: orgId, name: "removal-agent" })
      .returning();
    await db.insert(agentRepoPins).values({ agentId: agent!.id, repositoryId: repo.id });
    await db.insert(reviews).values({
      repositoryId: repo.id,
      prNumber: 1,
      headSha: "a",
      baseSha: "b",
      trigger: "webhook",
      budget: 1,
    });
    const [job] = await db
      .insert(jobs)
      .values({
        organizationId: orgId,
        type: "review.run",
        taskType: "review",
        repositoryId: repo.id,
      })
      .returning();
    expect((await findScmConnectionsByExternalId(db, "github", "4004")).map((c) => c.id)).toEqual([
      connection.id,
    ]);

    // Only the connection's organization can remove it.
    expect(await deleteScmConnection(db, otherId, connection.id)).toBeNull();
    expect(await getScmConnection(db, orgId, connection.id)).not.toBeNull();

    expect((await deleteScmConnection(db, orgId, connection.id))?.id).toBe(connection.id);
    expect(await getScmConnection(db, orgId, connection.id)).toBeNull();
    expect(await db.select().from(repositories).where(eq(repositories.id, repo.id))).toEqual([]);
    expect(await db.select().from(reviews).where(eq(reviews.repositoryId, repo.id))).toEqual([]);
    expect(
      await db.select().from(agentRepoPins).where(eq(agentRepoPins.agentId, agent!.id)),
    ).toEqual([]);
    // Jobs are kept (as history), without their repository.
    const [kept] = await db.select().from(jobs).where(eq(jobs.id, job!.id));
    expect(kept?.repositoryId).toBeNull();
    expect(await findScmConnectionsByExternalId(db, "github", "4004")).toEqual([]);
    expect(await deleteScmConnection(db, orgId, connection.id)).toBeNull();

    // The installation is free again: another organization can connect it.
    const moved = (await upsertScmConnection(db, { ...input, organizationId: otherId }, key))!;
    expect(moved.organizationId).toBe(otherId);
    expect((await listScmConnections(db, otherId)).map((c) => c.id)).toEqual([moved.id]);
    expect((await listScmConnections(db, orgId)).map((c) => c.id)).not.toContain(moved.id);
    const reconnected = await connectRepository(db, {
      connectionId: moved.id,
      provider: "github",
      externalId: "888",
      fullPath: "acme/removed",
    });
    expect(reconnected.organizationId).toBe(otherId);
    expect(reconnected.id).not.toBe(repo.id);
    await db.delete(scmConnections).where(eq(scmConnections.id, moved.id));
  });
});
