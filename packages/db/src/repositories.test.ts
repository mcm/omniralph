import { randomBytes } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Database } from "./client.js";
import { runMigrations } from "./migrate.js";
import {
  connectionCredentials,
  connectRepository,
  disconnectRepository,
  getRepository,
  getRepositoryWithConnection,
  getScmConnection,
  listRepositoryOverview,
  listRepositoryOverviewPage,
  listScmConnections,
  setRepositoryEnabled,
  upsertScmConnection,
} from "./repositories.js";
import {
  agentRepoPins,
  agents,
  organizations,
  reviewProfiles,
  reviews,
  scmConnections,
} from "./schema.js";
import {
  getReviewProfile,
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
      enabled: true,
      connectionName: "acme",
      profileId: "standard",
      pinnedAgents: [{ id: agent!.id, name: "coder-1" }],
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
      enabled: true,
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
    expect((await getRepository(db, repo.id))?.enabled).toBe(true);

    // Profiles are per organization: same slugs, separate rows.
    expect((await listReviewProfiles(db, otherId)).map((p) => p.id).sort()).toEqual([
      "deep",
      "quick",
      "standard",
    ]);
    await updateReviewProfile(db, otherId, "deep", {
      model: "claude-haiku-4-5",
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
      model: "claude-haiku-4-5",
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
});
