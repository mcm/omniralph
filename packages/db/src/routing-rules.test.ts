// Routing rules are an organization's ordered list, saved whole.
import { randomBytes, randomUUID } from "node:crypto";
import type { RoutingQuery } from "@omniralph/shared";
import { createTestDatabase, testDatabaseAvailable, type TestDatabase } from "../testing/index.js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Database } from "./client.js";
import { connectRepository, deleteScmConnection, upsertScmConnection } from "./repositories.js";
import { listRoutingRules, replaceRoutingRules } from "./routing-rules.js";
import { organizations, repositories, routingRules } from "./schema.js";
import { seedReviewProfiles } from "./settings.js";

const databaseAvailable = testDatabaseAvailable();

const key = randomBytes(32);

const labels = (...values: string[]): RoutingQuery => ({
  combinator: "and",
  rules: [{ field: "labels", operator: "containsAny", value: values }],
});

describe.skipIf(!databaseAvailable)("routing rules", () => {
  let testDb: TestDatabase;
  let db: Database;
  let seq = 0;

  const organization = async (name: string) => {
    const [org] = await db.insert(organizations).values({ name }).returning();
    await seedReviewProfiles(db, org!.id);
    return org!.id;
  };

  /** A connection of the organization with one repository per path. */
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
      key,
    ))!;
    const ids = [];
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
    return { connectionId: connection.id, ids };
  };

  const summary = async (organizationId: string) =>
    (await listRoutingRules(db, organizationId)).map((r) => ({
      position: r.position,
      repositoryId: r.repositoryId,
      query: r.query,
    }));

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  it("replaces the whole list in order, and reorders", async () => {
    const orgId = await organization("Replace");
    const {
      ids: [web, api],
    } = await repos(orgId, "acme/web", "acme/api");

    expect(await listRoutingRules(db, orgId)).toEqual([]);
    const first = await replaceRoutingRules(db, orgId, [
      { repositoryId: web!, query: labels("frontend") },
      { repositoryId: api!, query: labels("backend") },
    ]);
    expect(first.ok && first.rules.map((r) => r.position)).toEqual([0, 1]);
    expect(await summary(orgId)).toEqual([
      { position: 0, repositoryId: web, query: labels("frontend") },
      { position: 1, repositoryId: api, query: labels("backend") },
    ]);

    // Reordering (and adding) saves the new order from position 0.
    await replaceRoutingRules(db, orgId, [
      { repositoryId: api!, query: labels("backend") },
      { repositoryId: web!, query: labels("design") },
      { repositoryId: web!, query: labels("frontend") },
    ]);
    expect(await summary(orgId)).toEqual([
      { position: 0, repositoryId: api, query: labels("backend") },
      { position: 1, repositoryId: web, query: labels("design") },
      { position: 2, repositoryId: web, query: labels("frontend") },
    ]);

    // An empty list removes every rule.
    expect(await replaceRoutingRules(db, orgId, [])).toEqual({ ok: true, rules: [] });
    expect(await listRoutingRules(db, orgId)).toEqual([]);
  });

  it("changes nothing when a repository isn't the organization's", async () => {
    const orgId = await organization("Mine");
    const otherId = await organization("Theirs");
    const {
      ids: [mine],
    } = await repos(orgId, "acme/mine");
    const {
      ids: [theirs],
    } = await repos(otherId, "other/theirs");
    await replaceRoutingRules(db, orgId, [{ repositoryId: mine!, query: labels("a") }]);

    expect(
      await replaceRoutingRules(db, orgId, [
        { repositoryId: mine!, query: labels("b") },
        { repositoryId: theirs!, query: labels("c") },
        { repositoryId: randomUUID(), query: labels("d") },
      ]),
    ).toEqual({ ok: false, error: "unknown_repository", indexes: [1, 2] });
    expect(await summary(orgId)).toEqual([{ position: 0, repositoryId: mine, query: labels("a") }]);
  });

  it("keeps each organization's list to itself", async () => {
    const a = await organization("A");
    const b = await organization("B");
    const {
      ids: [repoA],
    } = await repos(a, "a/repo");
    const {
      ids: [repoB],
    } = await repos(b, "b/repo");
    await replaceRoutingRules(db, a, [{ repositoryId: repoA!, query: labels("a") }]);
    await replaceRoutingRules(db, b, [{ repositoryId: repoB!, query: labels("b") }]);
    await replaceRoutingRules(db, a, []);

    expect(await listRoutingRules(db, a)).toEqual([]);
    expect(await summary(b)).toEqual([{ position: 0, repositoryId: repoB, query: labels("b") }]);
  });

  it("runs concurrent saves one after the other", async () => {
    const orgId = await organization("Concurrent");
    const {
      ids: [web, api],
    } = await repos(orgId, "acme/web", "acme/api");
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        replaceRoutingRules(db, orgId, [
          { repositoryId: web!, query: labels(`web-${i}`) },
          { repositoryId: api!, query: labels(`api-${i}`) },
        ]),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const saved = await summary(orgId);
    expect(saved.map((r) => r.position)).toEqual([0, 1]);
  });

  it("deletes a repository's rules with it", async () => {
    const orgId = await organization("Cascade");
    const {
      connectionId,
      ids: [web, api, docs],
    } = await repos(orgId, "acme/web", "acme/api", "acme/docs");
    await replaceRoutingRules(db, orgId, [
      { repositoryId: web!, query: labels("a") },
      { repositoryId: api!, query: labels("b") },
      { repositoryId: docs!, query: labels("c") },
    ]);

    await db.delete(repositories).where(eq(repositories.id, api!));
    expect((await summary(orgId)).map((r) => r.repositoryId)).toEqual([web, docs]);

    // Removing the connection removes its repositories, and so their rules.
    await deleteScmConnection(db, orgId, connectionId);
    expect(await listRoutingRules(db, orgId)).toEqual([]);
    expect(
      await db.select().from(routingRules).where(eq(routingRules.organizationId, orgId)),
    ).toEqual([]);
  });
});
