import { randomBytes, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setAllowedTaskTypeDefaults } from "./app-settings.js";
import { closeDb, createDb, type Database } from "./client.js";
import { runMigrations } from "./migrate.js";
import {
  connectionCredentials,
  connectRepository,
  deleteScmConnection,
  disconnectRepository,
  effectiveRepositorySwitches,
  findScmConnectionsByExternalId,
  getRepository,
  getRepositoryWithConnection,
  getScmConnection,
  listConnectionRepositories,
  listRepositoryOverview,
  listRepositoryOverviewPage,
  listScmConnections,
  resolveRepositorySwitches,
  setRepositoryEnabled,
  setRepositorySwitches,
  upsertScmConnection,
} from "./repositories.js";
import {
  harnessRepoPins,
  harnesses,
  jobs,
  organizations,
  repositories,
  reviewProfiles,
  reviews,
  scmConnections,
} from "./schema.js";
import {
  getReviewProfile,
  listProfileRepositories,
  listReviewProfiles,
  seedReviewProfiles,
  updateRepositorySettings,
  updateReviewProfile,
} from "./settings.js";

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

const key = randomBytes(32);

describe.skipIf(!dockerAvailable)("repository queries", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let orgId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    await seedReviewProfiles(db, org!.id);
    orgId = org!.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await container?.stop();
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

  it("resolves effective switches: own value when set, else the organization's task types", async () => {
    const inheriting = { enabled: null, ralphEnabled: null, queryEnabled: null };
    expect(effectiveRepositorySwitches(inheriting, ["query", "review", "coding"])).toEqual({
      review: true,
      coding: true,
      query: true,
    });
    expect(effectiveRepositorySwitches(inheriting, ["review"])).toEqual({
      review: true,
      coding: false,
      query: false,
    });
    // An explicit value wins in either direction.
    expect(
      effectiveRepositorySwitches({ enabled: false, ralphEnabled: true, queryEnabled: null }, [
        "review",
        "query",
      ]),
    ).toEqual({ review: false, coding: true, query: true });

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
    // A new repository inherits everything; with no organization settings, all is on.
    expect(repo).toMatchObject({ enabled: null, ralphEnabled: null, queryEnabled: null });
    expect(await resolveRepositorySwitches(db, repo)).toEqual({
      review: true,
      coding: true,
      query: true,
    });
    try {
      await setAllowedTaskTypeDefaults(db, orgId, ["query"], null);
      expect(await resolveRepositorySwitches(db, repo)).toEqual({
        review: false,
        coding: false,
        query: true,
      });
      expect((await listConnectionRepositories(db, connection.id))[0]?.effective).toEqual({
        review: false,
        coding: false,
        query: true,
      });
      expect(await setRepositoryEnabled(db, orgId, repo.id, true)).toBe(true);
      expect((await listRepositoryOverview(db, orgId)).find((r) => r.id === repo.id)).toMatchObject(
        {
          enabled: true,
          ralphEnabled: false,
          queryEnabled: true,
          overrides: { review: true, coding: null, query: null },
        },
      );

      // Each switch saves on, off or null (inherit); omitted ones stay as they are.
      expect(await setRepositorySwitches(db, orgId, repo.id, { coding: true, query: false })).toBe(
        true,
      );
      expect((await listRepositoryOverview(db, orgId)).find((r) => r.id === repo.id)).toMatchObject(
        {
          enabled: true,
          ralphEnabled: true,
          queryEnabled: false,
          overrides: { review: true, coding: true, query: false },
        },
      );
      expect(
        await setRepositorySwitches(db, orgId, repo.id, {
          review: null,
          coding: null,
          query: null,
        }),
      ).toBe(true);
      expect(await getRepository(db, repo.id)).toMatchObject({
        enabled: null,
        ralphEnabled: null,
        queryEnabled: null,
      });
      expect(await setRepositoryEnabled(db, orgId, repo.id, null)).toBe(true);
      // Another organization can't change it.
      expect(await setRepositorySwitches(db, randomUUID(), repo.id, { review: false })).toBe(false);
      expect((await getRepository(db, repo.id))?.enabled).toBeNull();
    } finally {
      await setAllowedTaskTypeDefaults(db, orgId, null, null);
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
      .insert(harnesses)
      .values({ organizationId: orgId, name: "coder-1" })
      .returning();
    await db.insert(harnessRepoPins).values({ harnessId: agent!.id, repositoryId: repo.id });
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
      enabled: true,
      connectionName: "acme",
      profileId: "standard",
      pinnedHarnesses: [{ id: agent!.id, name: "coder-1" }],
      lastReviewAt: reviewedAt,
    });

    expect(await setRepositoryEnabled(db, orgId, repo.id, false)).toBe(true);
    expect((await listRepositoryOverview(db, orgId)).find((r) => r.id === repo.id)?.enabled).toBe(
      false,
    );

    const disconnected = await disconnectRepository(db, orgId, repo.id);
    expect(disconnected).toMatchObject({ enabled: false, webhookId: null });
    expect(disconnected?.disconnectedAt).toBeInstanceOf(Date);
    expect((await listRepositoryOverview(db, orgId)).some((r) => r.id === repo.id)).toBe(false);
    expect(
      await db.select().from(harnessRepoPins).where(eq(harnessRepoPins.repositoryId, repo.id)),
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
      // Inherits the organization's allowed task types again.
      enabled: null,
      disconnectedAt: null,
      fullPath: "acme/web-renamed",
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

    await db
      .update(repositories)
      .set({ profileId: "deep" })
      .where(eq(repositories.id, repos[1]!.id));
    const byProfile = (await listProfileRepositories(db, orgId)).filter((r) =>
      r.fullPath.startsWith("paged/"),
    );
    expect(byProfile.map((r) => [r.fullPath, r.profileId])).toEqual([
      ["paged/a", "deep"],
      ["paged/b", "standard"],
      ["paged/c", "standard"],
      ["paged/e", "standard"],
    ]);
    await db.delete(scmConnections).where(eq(scmConnections.id, connection.id));
  });

  it("keeps connections, repositories and profiles inside their organization", async () => {
    const [other] = await db.insert(organizations).values({ name: "Other" }).returning();
    const otherId = other!.id;
    await seedReviewProfiles(db, otherId);
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
    expect((await getRepository(db, repo.id))?.enabled).toBeNull();

    // Profiles are per organization: same slugs, separate rows.
    expect((await listReviewProfiles(db, otherId)).map((p) => p.id).sort()).toEqual([
      "deep",
      "quick",
      "standard",
    ]);
    await updateReviewProfile(db, otherId, "deep", {
      model: "claude-haiku-5-5",
      maxTokensPerReview: 1000,
      maxFiles: 1,
      allowRepoExploration: false,
    });
    expect((await getReviewProfile(db, orgId, "deep"))?.maxTokensPerReview).toBe(500_000);

    // A repository can only use a profile of its own organization.
    await db.insert(reviewProfiles).values({
      organizationId: otherId,
      id: "custom",
      name: "Custom",
      model: "claude-haiku-5-5",
      maxTokensPerReview: 1000,
      maxFiles: 1,
      allowRepoExploration: false,
    });
    const settings = {
      profileId: "custom",
      triggers: { onOpen: true, onPush: true, drafts: false },
      pathExcludes: [],
      customInstructions: null,
    };
    await expect(updateRepositorySettings(db, orgId, repo.id, settings)).rejects.toThrow();
    expect(await updateRepositorySettings(db, otherId, repo.id, settings)).toBeNull();
    expect(
      await updateRepositorySettings(db, orgId, repo.id, { ...settings, profileId: "deep" }),
    ).toMatchObject({ profileId: "deep" });
    await db.delete(scmConnections).where(eq(scmConnections.id, connection.id));
  });
  it("removes a connection with its repositories so another organization can connect it", async () => {
    const [other] = await db.insert(organizations).values({ name: "Removal" }).returning();
    const otherId = other!.id;
    await seedReviewProfiles(db, otherId);
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
      .insert(harnesses)
      .values({ organizationId: orgId, name: "removal-agent" })
      .returning();
    await db.insert(harnessRepoPins).values({ harnessId: agent!.id, repositoryId: repo.id });
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
        pool: "short",
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
      await db.select().from(harnessRepoPins).where(eq(harnessRepoPins.harnessId, agent!.id)),
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
