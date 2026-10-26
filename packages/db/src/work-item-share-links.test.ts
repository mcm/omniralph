// A work item's public review links: the active-link cap, lookups by token hash, revoking.
import { createTestDatabase, testDatabaseAvailable, type TestDatabase } from "../testing/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureChanges } from "./changes.js";
import { closeDb, createDb, type Database } from "./client.js";
import { organizations, users } from "./schema.js";
import {
  createWorkItemShareLink,
  findActiveWorkItemShareLink,
  getWorkItemShareLink,
  listActiveWorkItemShareLinks,
  revokeWorkItemShareLink,
} from "./work-item-share-links.js";
import { listWorkItemEvents, type WorkItemKey } from "./work-items.js";

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("work item share links", () => {
  let testDb: TestDatabase;
  let db: Database;
  let seq = 0;
  let userId: string;
  const actor = () => ({ userId, name: "Steve McMaster" });

  const item = async (): Promise<WorkItemKey> => {
    seq += 1;
    const [org] = await db
      .insert(organizations)
      .values({ name: `Share ${seq}` })
      .returning();
    return { organizationId: org!.id, tracker: "linear", externalId: `issue-${seq}` };
  };

  const create = (key: WorkItemKey, overrides: { tokenHash?: string; expiresAt?: Date } = {}) =>
    createWorkItemShareLink(db, {
      ...key,
      tokenHash: overrides.tokenHash ?? `hash-${++seq}`,
      passwordHash: null,
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 86_400_000),
      actor: actor(),
      maxActive: 3,
    });

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [user] = await db
      .insert(users)
      .values({ name: "Steve McMaster", email: "steve@example.com" })
      .returning();
    userId = user!.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  it("creates links up to the cap, recording each as an event and a work_item change", async () => {
    const key = await item();
    const { result, changes } = await captureChanges(() => create(key, { tokenHash: "first" }));
    expect(result).toMatchObject({
      status: "created",
      link: { tokenHash: "first", createdBy: userId },
    });
    expect(changes).toEqual([
      expect.objectContaining({
        resource: "work_item",
        organizationId: key.organizationId,
        ids: [`linear-${key.externalId}`],
      }),
    ]);
    await create(key);
    await create(key);
    expect(await create(key)).toEqual({ status: "limit" });
    const events = await listWorkItemEvents(db, key);
    expect(events.map((event) => event.kind)).toEqual([
      "share_link_created",
      "share_link_created",
      "share_link_created",
    ]);
    expect(events[2]).toMatchObject({ actorName: "Steve McMaster", detail: { protected: false } });

    const listed = await listActiveWorkItemShareLinks(db, key);
    expect(listed).toHaveLength(3);
    expect(listed[0]).toMatchObject({ tokenHash: "first", createdByName: "Steve McMaster" });

    // Another item's links don't count against this one.
    expect(await create(await item())).toMatchObject({ status: "created" });
  });

  it("doesn't count or find revoked and expired links", async () => {
    const key = await item();
    const created = await create(key, { tokenHash: "revoke-me" });
    if (created.status !== "created") throw new Error("setup");
    await create(key, { tokenHash: "expired", expiresAt: new Date(Date.now() - 1000) });
    expect(await findActiveWorkItemShareLink(db, "revoke-me")).toMatchObject({
      id: created.link.id,
      createdByName: "Steve McMaster",
    });
    expect(await findActiveWorkItemShareLink(db, "expired")).toBeNull();
    expect(await findActiveWorkItemShareLink(db, "unknown")).toBeNull();

    const { result: revoked, changes } = await captureChanges(() =>
      revokeWorkItemShareLink(db, { id: created.link.id, actor: actor() }),
    );
    expect(revoked?.revokedAt).toBeInstanceOf(Date);
    expect(changes.map((change) => change.resource)).toEqual(["work_item"]);
    expect((await getWorkItemShareLink(db, created.link.id))?.revokedAt).toBeInstanceOf(Date);
    expect(await findActiveWorkItemShareLink(db, "revoke-me")).toBeNull();
    expect(await listActiveWorkItemShareLinks(db, key)).toEqual([]);
    // Revoking twice writes nothing.
    expect(await revokeWorkItemShareLink(db, { id: created.link.id, actor: actor() })).toBeNull();
    expect((await listWorkItemEvents(db, key)).map((event) => event.kind)).toEqual([
      "share_link_revoked",
      "share_link_created",
      "share_link_created",
    ]);
  });
});
