import { closeDb, createDb, webhookDeliveries, type Database } from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ db: undefined as unknown as Database }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));

process.env.CRON_SECRET = "cron-secret";

const { GET: pruneRoute } = await import("./prune-webhook-deliveries/route");

const databaseAvailable = testDatabaseAvailable();

function cronRequest(secret?: string) {
  return new Request("http://localhost/api/cron/prune-webhook-deliveries", {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000);

describe.skipIf(!databaseAvailable)("GET /api/cron/prune-webhook-deliveries", () => {
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

  beforeEach(async () => {
    await db.delete(webhookDeliveries);
    await db.insert(webhookDeliveries).values([
      { provider: "github", deliveryId: "eight-days", createdAt: hoursAgo(8 * 24) },
      { provider: "gitlab", deliveryId: "just-over-a-week", createdAt: hoursAgo(7 * 24 + 1) },
      { provider: "github", deliveryId: "just-under-a-week", createdAt: hoursAgo(7 * 24 - 1) },
      { provider: "gitlab", deliveryId: "today", createdAt: new Date() },
    ]);
  });

  async function deliveryIds(): Promise<string[]> {
    const rows = await db.select({ id: webhookDeliveries.deliveryId }).from(webhookDeliveries);
    return rows.map((r) => r.id).sort();
  }

  it("deletes deliveries older than 7 days and keeps recent ones", async () => {
    const res = await pruneRoute(cronRequest("cron-secret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pruned: 2 });
    expect(await deliveryIds()).toEqual(["just-under-a-week", "today"]);
  });

  it("requires CRON_SECRET", async () => {
    expect((await pruneRoute(cronRequest())).status).toBe(401);
    expect((await pruneRoute(cronRequest("wrong"))).status).toBe(401);
    expect(await deliveryIds()).toHaveLength(4);
  });
});
