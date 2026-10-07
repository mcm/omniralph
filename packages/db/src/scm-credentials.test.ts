import { randomBytes } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Database } from "./client.js";
import { decrypt } from "./crypto.js";
import { runMigrations } from "./migrate.js";
import { organizations, repositories, scmConnections, scmCredentialCache } from "./schema.js";
import { seedReviewProfiles } from "./settings.js";
import { createScmCredentialCache } from "./scm-credentials.js";

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

describe.skipIf(!dockerAvailable)("scm credential cache", () => {
  const key = randomBytes(32);
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let connectionId: string;
  let repositoryId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    await seedReviewProfiles(db, org!.id);
    const organizationId = org!.id;
    const [connection] = await db
      .insert(scmConnections)
      .values({
        organizationId,
        provider: "gitlab",
        name: "GitLab",
        baseUrl: "https://gitlab.example.com",
        encryptedCredentials: "x",
      })
      .returning();
    connectionId = connection!.id;
    const [repo] = await db
      .insert(repositories)
      .values({
        organizationId,
        provider: "gitlab",
        externalId: "99",
        fullPath: "acme/widgets",
        connectionId,
      })
      .returning();
    repositoryId = repo!.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await container?.stop();
  });

  it("stores tokens encrypted and replaces them on rotation", async () => {
    const cache = createScmCredentialCache(db, connectionId, key);
    const repo = { fullPath: "acme/widgets", externalId: "99" };
    expect(await cache.get(repo, "read_repository")).toBeNull();

    const first = {
      token: "glpat-1",
      expiresAt: new Date("2026-10-05T00:00:00Z"),
      externalId: "301",
    };
    await cache.set(repo, "read_repository", first);
    expect(await cache.get(repo, "read_repository")).toEqual(first);
    // Looked up by path when the project ID isn't known.
    expect(await cache.get({ fullPath: "acme/widgets" }, "read_repository")).toEqual(first);

    const [row] = await db
      .select()
      .from(scmCredentialCache)
      .where(eq(scmCredentialCache.repositoryId, repositoryId));
    expect(row?.encryptedToken).not.toContain("glpat-1");
    expect(decrypt(row!.encryptedToken, key)).toBe("glpat-1");

    const second = {
      token: "glpat-2",
      expiresAt: new Date("2026-10-06T00:00:00Z"),
      externalId: "302",
    };
    await cache.set(repo, "read_repository", second);
    expect(await cache.get(repo, "read_repository")).toEqual(second);
    expect(await db.select().from(scmCredentialCache)).toHaveLength(1);
  });

  it("ignores repositories outside the connection", async () => {
    const cache = createScmCredentialCache(db, connectionId, key);
    expect(await cache.get({ fullPath: "other/repo" }, "read_repository")).toBeNull();
    await expect(
      cache.set({ fullPath: "other/repo" }, "read_repository", {
        token: "t",
        expiresAt: new Date(),
        externalId: null,
      }),
    ).rejects.toThrow(/not connected/);
  });
});
