// Applies the real migrations to a throwaway Postgres (Testcontainers).
// Skipped when no container runtime (Docker) is available.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { asc, eq } from "drizzle-orm";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Database } from "./client.js";
import { runMigrations } from "./migrate.js";
import { jobs, repositories, reviewProfiles, scmConnections } from "./schema.js";

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

describe.skipIf(!dockerAvailable)("migrations", () => {
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

  it("is idempotent", async () => {
    await expect(runMigrations(container.getConnectionUri())).resolves.toBeUndefined();
  });

  it("seeds the quick, standard and deep profiles", async () => {
    const profiles = await db
      .select({
        id: reviewProfiles.id,
        model: reviewProfiles.model,
        maxTokensPerReview: reviewProfiles.maxTokensPerReview,
        maxFiles: reviewProfiles.maxFiles,
        allowRepoExploration: reviewProfiles.allowRepoExploration,
      })
      .from(reviewProfiles)
      .orderBy(asc(reviewProfiles.maxTokensPerReview));

    expect(profiles.map((p) => [p.id, p.allowRepoExploration])).toEqual([
      ["quick", false],
      ["standard", true],
      ["deep", true],
    ]);
    for (const profile of profiles) {
      expect(profile.model).toMatch(/^claude-/);
      expect(profile.maxTokensPerReview).toBeGreaterThan(0);
      expect(profile.maxFiles).toBeGreaterThan(0);
    }
  });

  it("defaults repositories to the standard profile and default triggers", async () => {
    const [connection] = await db
      .insert(scmConnections)
      .values({
        provider: "github",
        name: "GitHub",
        baseUrl: "https://api.github.com",
        encryptedCredentials: "x",
      })
      .returning();
    const [repo] = await db
      .insert(repositories)
      .values({
        provider: "github",
        externalId: "1",
        fullPath: "mcm/omniralph",
        connectionId: connection!.id,
      })
      .returning();
    expect(repo).toMatchObject({
      profileId: "standard",
      enabled: true,
      triggers: { onOpen: true, onPush: true, drafts: false },
      pathExcludes: [],
    });
  });

  it("allows one queued/running job per dedupe key", async () => {
    const job = { capability: "review", type: "review.run", dedupeKey: "repo:1:pr:2" };
    const [first] = await db.insert(jobs).values(job).returning();
    await expect(db.insert(jobs).values(job)).rejects.toThrow();

    await db.update(jobs).set({ status: "completed" }).where(eq(jobs.id, first!.id));
    await expect(db.insert(jobs).values(job)).resolves.toBeDefined();
  });
});
