// A repository's work item match: one per repository, saved or cleared on its own.
import { randomBytes } from "node:crypto";
import { createTestDatabase, testDatabaseAvailable, type TestDatabase } from "../testing/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Database } from "./client.js";
import { connectRepository, disconnectRepository, upsertScmConnection } from "./repositories.js";
import { organizations, repositories, workItemMatches } from "./schema.js";
import {
  deleteWorkItemMatch,
  getWorkItemMatch,
  listOtherWorkItemMatches,
  listWorkItemMatches,
  listWorkItemTargets,
  saveWorkItemMatch,
  type WorkItemMatchFields,
} from "./work-item-matches.js";
import { eq } from "drizzle-orm";

const databaseAvailable = testDatabaseAvailable();

const match = (fields: Partial<WorkItemMatchFields> = {}): WorkItemMatchFields => ({
  tracker: "linear",
  team: "ENG",
  project: null,
  withoutProject: false,
  labels: [],
  ...fields,
});

describe.skipIf(!databaseAvailable)("work item matches", () => {
  let testDb: TestDatabase;
  let db: Database;
  let seq = 0;

  const organization = async (name: string) => {
    const [org] = await db.insert(organizations).values({ name }).returning();
    return org!.id;
  };

  const repos = async (organizationId: string, ...paths: string[]) => {
    seq += 1;
    const connection = (await upsertScmConnection(
      db,
      {
        organizationId,
        provider: "github",
        name: `acme-${seq}`,
        baseUrl: "https://api.github.com",
        externalId: `conn-${seq}`,
        credentials: {},
      },
      randomBytes(32),
    ))!;
    const ids: string[] = [];
    for (const fullPath of paths) {
      seq += 1;
      const repo = await connectRepository(db, {
        connectionId: connection.id,
        provider: "github",
        externalId: `repo-${seq}`,
        fullPath,
      });
      ids.push(repo.id);
    }
    return ids;
  };

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  it("saves, replaces and clears a repository's match", async () => {
    const orgId = await organization("Save");
    const [api] = await repos(orgId, "acme/api");
    expect(await getWorkItemMatch(db, orgId, api!)).toBeNull();

    const saved = await saveWorkItemMatch(db, {
      organizationId: orgId,
      repositoryId: api!,
      userId: null,
      match: match({ project: "Portal", labels: ["backend"] }),
    });
    expect(saved).toMatchObject({ team: "ENG", project: "Portal", labels: ["backend"] });

    // Saving again replaces it; "no project" always stores no project name.
    await saveWorkItemMatch(db, {
      organizationId: orgId,
      repositoryId: api!,
      userId: null,
      match: match({ team: "OPS", project: "Ignored", withoutProject: true }),
    });
    expect(await getWorkItemMatch(db, orgId, api!)).toMatchObject({
      team: "OPS",
      project: null,
      withoutProject: true,
      labels: [],
    });
    expect(await db.select().from(workItemMatches)).toHaveLength(1);

    expect(await deleteWorkItemMatch(db, orgId, api!)).toBe(true);
    expect(await deleteWorkItemMatch(db, orgId, api!)).toBe(false);
    expect(await getWorkItemMatch(db, orgId, api!)).toBeNull();
  });

  it("refuses another organization's or a disconnected repository", async () => {
    const orgId = await organization("Mine");
    const otherId = await organization("Theirs");
    const [theirs] = await repos(otherId, "other/api");
    const [gone] = await repos(orgId, "acme/gone");
    await disconnectRepository(db, orgId, gone!);
    for (const repositoryId of [theirs!, gone!]) {
      expect(
        await saveWorkItemMatch(db, {
          organizationId: orgId,
          repositoryId,
          userId: null,
          match: match(),
        }),
      ).toBeNull();
    }
    expect(await getWorkItemMatch(db, otherId, theirs!)).toBeNull();
  });

  it("lists the connected repositories' matches and the other ones", async () => {
    const orgId = await organization("List");
    const [web, api, docs] = await repos(orgId, "acme/web", "acme/api", "acme/docs");
    for (const repositoryId of [web!, api!, docs!]) {
      await saveWorkItemMatch(db, {
        organizationId: orgId,
        repositoryId,
        userId: null,
        match: match(),
      });
    }
    await db
      .update(repositories)
      .set({ disconnectedAt: new Date() })
      .where(eq(repositories.id, docs!));
    expect((await listWorkItemMatches(db, orgId)).map((m) => m.repositoryId)).toEqual([api, web]);
    expect(await listOtherWorkItemMatches(db, orgId, api!)).toEqual([
      expect.objectContaining({ repositoryId: web, fullPath: "acme/web" }),
    ]);
  });

  it("lists New work item's targets: connected repos with Coding on and a match", async () => {
    const orgId = await organization("Targets");
    const [web, api, docs, bare] = await repos(
      orgId,
      "acme/web",
      "acme/api",
      "acme/docs",
      "acme/bare",
    );
    for (const repositoryId of [web!, api!, docs!]) {
      await saveWorkItemMatch(db, {
        organizationId: orgId,
        repositoryId,
        userId: null,
        match: match({ project: repositoryId === web ? "Portal" : null }),
      });
    }
    await db
      .update(repositories)
      .set({ codingEnabled: true })
      .where(eq(repositories.organizationId, orgId));
    await db.update(repositories).set({ codingEnabled: false }).where(eq(repositories.id, api!));
    await db
      .update(repositories)
      .set({ disconnectedAt: new Date() })
      .where(eq(repositories.id, docs!));
    // `bare` has Coding on but no match.
    expect(bare).toBeDefined();
    expect(await listWorkItemTargets(db, orgId)).toEqual([
      {
        repository: { id: web, provider: "github", fullPath: "acme/web" },
        match: expect.objectContaining({ team: "ENG", project: "Portal" }),
      },
    ]);
    expect(await listWorkItemTargets(db, await organization("Empty"))).toEqual([]);
  });

  it('refuses a project name with "no project", and deletes with the repository', async () => {
    const orgId = await organization("Check");
    const [api] = await repos(orgId, "acme/api");
    await expect(
      db.insert(workItemMatches).values({
        organizationId: orgId,
        repositoryId: api!,
        tracker: "linear",
        team: "ENG",
        project: "Portal",
        withoutProject: true,
      }),
    ).rejects.toThrow();
    await saveWorkItemMatch(db, {
      organizationId: orgId,
      repositoryId: api!,
      userId: null,
      match: match(),
    });
    await db.delete(repositories).where(eq(repositories.id, api!));
    expect(await listWorkItemMatches(db, orgId)).toEqual([]);
  });
});
