// A work item's repo choice and its events, per organization and tracker item.
import { randomBytes } from "node:crypto";
import { createTestDatabase, testDatabaseAvailable, type TestDatabase } from "../testing/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, createDb, type Database } from "./client.js";
import { connectRepository, disconnectRepository, upsertScmConnection } from "./repositories.js";
import { organizations, repositories, users, workItemEvents } from "./schema.js";
import {
  clearWorkItemRepository,
  getWorkItemOverride,
  listWorkItemEvents,
  recordWorkItemEvent,
  setWorkItemRepository,
  type WorkItemKey,
} from "./work-items.js";

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("work items", () => {
  let testDb: TestDatabase;
  let db: Database;
  let seq = 0;

  const organization = async (name: string) => {
    const [org] = await db.insert(organizations).values({ name }).returning();
    return org!.id;
  };

  const repo = async (organizationId: string, fullPath: string) => {
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
    const { id } = await connectRepository(db, {
      connectionId: connection.id,
      provider: "github",
      externalId: `repo-${seq}`,
      fullPath,
    });
    return id;
  };

  const user = async (name: string) => {
    seq += 1;
    const [row] = await db
      .insert(users)
      .values({ name, email: `user-${seq}@example.com` })
      .returning();
    return row!.id;
  };

  const item = (organizationId: string, externalId = `issue-${++seq}`): WorkItemKey => ({
    organizationId,
    tracker: "linear",
    externalId,
  });

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  describe("repo choice", () => {
    it("saves, replaces and clears an item's choice", async () => {
      const orgId = await organization("Choose");
      const portal = await repo(orgId, "acme/customer-portal");
      const api = await repo(orgId, "acme/api");
      const steve = await user("Steve");
      const key = item(orgId);
      expect(await getWorkItemOverride(db, key)).toBeNull();

      const saved = await setWorkItemRepository(db, {
        ...key,
        repositoryId: portal,
        userId: steve,
      });
      expect(saved).toMatchObject({ ...key, repositoryId: portal, chosenBy: steve });
      expect(await getWorkItemOverride(db, key)).toEqual(saved);

      // Choosing again replaces it.
      const replaced = await setWorkItemRepository(db, { ...key, repositoryId: api, userId: null });
      expect(replaced).toMatchObject({ repositoryId: api, chosenBy: null });
      expect(replaced!.chosenAt.getTime()).toBeGreaterThanOrEqual(saved!.chosenAt.getTime());

      // Another item, or the same ID in another organization, has its own choice.
      expect(await getWorkItemOverride(db, item(orgId))).toBeNull();
      expect(
        await getWorkItemOverride(db, { ...key, organizationId: await organization("Other") }),
      ).toBeNull();

      expect(await clearWorkItemRepository(db, key)).toBe(true);
      expect(await clearWorkItemRepository(db, key)).toBe(false);
      expect(await getWorkItemOverride(db, key)).toBeNull();
    });

    it("refuses another organization's or a disconnected repo", async () => {
      const orgId = await organization("Mine");
      const theirs = await repo(await organization("Theirs"), "other/api");
      const gone = await repo(orgId, "acme/gone");
      await disconnectRepository(db, orgId, gone);
      const key = item(orgId);
      for (const repositoryId of [theirs, gone]) {
        expect(await setWorkItemRepository(db, { ...key, repositoryId, userId: null })).toBeNull();
      }
      expect(await getWorkItemOverride(db, key)).toBeNull();
    });

    it("keeps the choice without a repo when the repo is deleted", async () => {
      const orgId = await organization("Deleted");
      const portal = await repo(orgId, "acme/portal");
      const key = item(orgId);
      await setWorkItemRepository(db, { ...key, repositoryId: portal, userId: null });
      await db.delete(repositories).where(eq(repositories.id, portal));
      expect(await getWorkItemOverride(db, key)).toMatchObject({ repositoryId: null });
    });
  });

  describe("events", () => {
    it("records events and lists an item's newest first", async () => {
      const orgId = await organization("Events");
      const steve = await user("Steve");
      const key = item(orgId);
      const created = await recordWorkItemEvent(db, {
        ...key,
        kind: "created",
        actorUserId: steve,
        actorName: "Steve",
        detail: { origin: "backlog" },
      });
      expect(created).toMatchObject({
        ...key,
        kind: "created",
        actorUserId: steve,
        actorName: "Steve",
        detail: { origin: "backlog" },
      });
      const triage = await recordWorkItemEvent(db, {
        ...key,
        kind: "triage_requested",
        actorUserId: null,
        actorName: "Om",
      });
      expect(triage.detail).toEqual({});
      // Another item's and another organization's events aren't listed.
      await recordWorkItemEvent(db, {
        ...item(orgId),
        kind: "canceled",
        actorUserId: null,
        actorName: "Om",
      });
      await recordWorkItemEvent(db, {
        ...key,
        organizationId: await organization("Elsewhere"),
        kind: "canceled",
        actorUserId: null,
        actorName: "Om",
      });
      // Older than the triage request, however fast the two were recorded.
      await db
        .update(workItemEvents)
        .set({ createdAt: new Date("2026-10-01T00:00:00Z") })
        .where(eq(workItemEvents.id, created.id));

      const events = await listWorkItemEvents(db, key);
      expect(events.map((e) => e.kind)).toEqual(["triage_requested", "created"]);
      expect(await listWorkItemEvents(db, key, 1)).toHaveLength(1);
    });

    it("keeps the actor's name when the user is deleted", async () => {
      const orgId = await organization("Deleted user");
      const anna = await user("Anna");
      const key = item(orgId);
      await recordWorkItemEvent(db, {
        ...key,
        kind: "repo_changed",
        actorUserId: anna,
        actorName: "Anna",
        detail: { repository: "customer-portal" },
      });
      await db.delete(users).where(eq(users.id, anna));
      expect(await listWorkItemEvents(db, key)).toEqual([
        expect.objectContaining({ actorUserId: null, actorName: "Anna", kind: "repo_changed" }),
      ]);
    });
  });
});
