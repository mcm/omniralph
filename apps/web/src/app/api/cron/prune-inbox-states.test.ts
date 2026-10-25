import {
  closeDb,
  createDb,
  inboxItemStates,
  organizations,
  users,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ db: undefined as unknown as Database }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));

process.env.CRON_SECRET = "cron-secret";

const { GET: pruneRoute } = await import("./prune-inbox-states/route");

const databaseAvailable = testDatabaseAvailable();

function cronRequest(secret?: string) {
  return new Request("http://localhost/api/cron/prune-inbox-states", {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

describe.skipIf(!databaseAvailable)("GET /api/cron/prune-inbox-states", () => {
  let testDb: TestDatabase;
  let db: Database;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
  }, 120_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  it("requires CRON_SECRET", async () => {
    expect((await pruneRoute(cronRequest())).status).toBe(401);
    expect((await pruneRoute(cronRequest("wrong"))).status).toBe(401);
  });

  it("deletes Inbox states not updated for 60 days and keeps newer ones", async () => {
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    await db.insert(users).values({ id: "prune-alice" });
    const row = (itemKey: string, updatedAt: Date) => ({
      userId: "prune-alice",
      organizationId: org!.id,
      itemKey,
      state: "done" as const,
      updatedAt,
    });
    await db
      .insert(inboxItemStates)
      .values([
        row("failed:old", daysAgo(90)),
        row("failed:just-over", daysAgo(60.1)),
        row("failed:just-under", daysAgo(59.9)),
        row("failed:today", new Date()),
      ]);

    const res = await pruneRoute(cronRequest("cron-secret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pruned: 2 });
    const kept = await db.select({ key: inboxItemStates.itemKey }).from(inboxItemStates);
    expect(kept.map((r) => r.key).sort()).toEqual(["failed:just-under", "failed:today"]);
  });
});
