import { randomBytes } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Database } from "./client.js";
import { runMigrations } from "./migrate.js";
import {
  connectionCredentials,
  connectRepository,
  disconnectRepository,
  listRepositoryOverview,
  listRepositoryOverviewPage,
  setRepositoryEnabled,
  upsertScmConnection,
} from "./repositories.js";
import { agentRepoPins, agents, reviews, scmConnections } from "./schema.js";

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

const key = randomBytes(32);

describe.skipIf(!dockerAvailable)("repository queries", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
  }, 180_000);

  afterAll(async () => {
    await db?.$client.end();
    await container?.stop();
  });

  it("upserts connections by provider, base URL and external ID, encrypting credentials", async () => {
    const input = {
      provider: "gitlab" as const,
      name: "omniralph-bot",
      baseUrl: "https://gitlab.example.com",
      externalId: "42",
      credentials: { token: "glpat-first", webhookSecret: "s1" },
    };
    const first = await upsertScmConnection(db, input, key);
    const second = await upsertScmConnection(
      db,
      { ...input, credentials: { token: "glpat-second" } },
      key,
    );
    expect(second.id).toBe(first.id);
    expect(second.encryptedCredentials).not.toContain("glpat");
    expect(connectionCredentials(second, key)).toEqual({ token: "glpat-second" });
  });

  it("lists connected repos with profile, pins and last review; disconnect keeps history", async () => {
    const connection = await upsertScmConnection(
      db,
      {
        provider: "github",
        name: "acme",
        baseUrl: "https://api.github.com",
        externalId: "1001",
        credentials: {},
      },
      key,
    );
    const repo = await connectRepository(db, {
      connectionId: connection.id,
      provider: "github",
      externalId: "555",
      fullPath: "acme/web",
    });
    const [agent] = await db.insert(agents).values({ name: "coder-1" }).returning();
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

    const [row] = (await listRepositoryOverview(db)).filter((r) => r.id === repo.id);
    expect(row).toMatchObject({
      provider: "github",
      fullPath: "acme/web",
      enabled: true,
      connectionName: "acme",
      profileId: "standard",
      pinnedAgents: [{ id: agent!.id, name: "coder-1" }],
      lastReviewAt: reviewedAt,
    });

    expect(await setRepositoryEnabled(db, repo.id, false)).toBe(true);
    expect((await listRepositoryOverview(db)).find((r) => r.id === repo.id)?.enabled).toBe(false);

    const disconnected = await disconnectRepository(db, repo.id);
    expect(disconnected).toMatchObject({ enabled: false, webhookId: null });
    expect(disconnected?.disconnectedAt).toBeInstanceOf(Date);
    expect((await listRepositoryOverview(db)).some((r) => r.id === repo.id)).toBe(false);
    expect(
      await db.select().from(agentRepoPins).where(eq(agentRepoPins.repositoryId, repo.id)),
    ).toEqual([]);
    expect(await db.select().from(reviews).where(eq(reviews.repositoryId, repo.id))).toHaveLength(
      2,
    );
    expect(await setRepositoryEnabled(db, repo.id, true)).toBe(false);

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
    const connection = await upsertScmConnection(
      db,
      {
        provider: "gitlab",
        name: "paged",
        baseUrl: "https://gitlab.paged.example",
        externalId: "7",
        credentials: {},
      },
      key,
    );
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
    await disconnectRepository(db, repos[4]!.id);

    const all = (await listRepositoryOverview(db)).map((r) => r.id);
    const pages = [];
    for (let page = 1; page <= Math.ceil(all.length / 2); page++) {
      const result = await listRepositoryOverviewPage(db, { page, pageSize: 2 });
      expect(result).toMatchObject({ total: all.length, page, pageSize: 2 });
      pages.push(...result.repositories.map((r) => r.id));
    }
    expect(pages).toEqual(all);
    expect(all).not.toContain(repos[4]!.id);
    const paged = (await listRepositoryOverview(db))
      .filter((r) => r.connectionId === connection.id)
      .map((r) => r.fullPath);
    expect(paged).toEqual(["paged/a", "paged/b", "paged/c", "paged/e"]);

    const past = await listRepositoryOverviewPage(db, { page: 99, pageSize: 2 });
    expect(past).toMatchObject({ repositories: [], total: all.length, page: 99 });
    await db.delete(scmConnections).where(eq(scmConnections.id, connection.id));
  });
});
