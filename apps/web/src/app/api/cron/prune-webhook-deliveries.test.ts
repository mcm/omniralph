import {
  closeDb,
  createDb,
  organizations,
  scmConnections,
  webhookDeliveries,
  webhookEvents,
  type Database,
} from "@omniralph/db";
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
  let organizationId: string;
  let scmConnectionId: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    organizationId = org!.id;
    const [connection] = await db
      .insert(scmConnections)
      .values({
        organizationId,
        provider: "github",
        name: "acme",
        baseUrl: "https://api.github.com",
        externalId: "1",
        encryptedCredentials: "x",
      })
      .returning();
    scmConnectionId = connection!.id;
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
    await db.delete(webhookEvents);
    const event = (deliveryId: string, receivedAt: Date) => ({
      organizationId,
      provider: "github" as const,
      scmConnectionId,
      deliveryId,
      event: "pull_request.opened",
      outcome: "ignored" as const,
      receivedAt,
    });
    await db
      .insert(webhookEvents)
      .values([
        event("fifteen-days", hoursAgo(15 * 24)),
        event("just-over-two-weeks", hoursAgo(14 * 24 + 1)),
        event("just-under-two-weeks", hoursAgo(14 * 24 - 1)),
        event("eight-days", hoursAgo(8 * 24)),
        event("today", new Date()),
      ]);
  });

  async function eventDeliveryIds(): Promise<string[]> {
    const rows = await db.select({ id: webhookEvents.deliveryId }).from(webhookEvents);
    return rows.map((r) => r.id ?? "").sort();
  }

  async function deliveryIds(): Promise<string[]> {
    const rows = await db.select({ id: webhookDeliveries.deliveryId }).from(webhookDeliveries);
    return rows.map((r) => r.id).sort();
  }

  it("deletes deliveries older than 7 days and keeps recent ones", async () => {
    const res = await pruneRoute(cronRequest("cron-secret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pruned: 2, prunedEvents: 2 });
    expect(await deliveryIds()).toEqual(["just-under-a-week", "today"]);
  });

  it("deletes the delivery log older than 14 days and keeps newer entries", async () => {
    await pruneRoute(cronRequest("cron-secret"));
    expect(await eventDeliveryIds()).toEqual(["eight-days", "just-under-two-weeks", "today"]);
  });

  it("requires CRON_SECRET", async () => {
    expect((await pruneRoute(cronRequest())).status).toBe(401);
    expect((await pruneRoute(cronRequest("wrong"))).status).toBe(401);
    expect(await deliveryIds()).toHaveLength(4);
    expect(await eventDeliveryIds()).toHaveLength(5);
  });
});
