import { createTestDatabase, testDatabaseAvailable, type TestDatabase } from "../testing/index.js";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, createDb, type Database } from "./client.js";
import { webhookDeliveries } from "./schema.js";
import {
  claimWebhookDelivery,
  pruneWebhookDeliveries,
  releaseWebhookDelivery,
} from "./webhooks.js";

const databaseAvailable = testDatabaseAvailable();

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

describe.skipIf(!databaseAvailable)("webhook delivery queries", () => {
  let testDb: TestDatabase;
  let db: Database;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    await db.delete(webhookDeliveries);
  });

  it("prunes deliveries recorded before the cutoff and keeps later ones", async () => {
    await db.insert(webhookDeliveries).values([
      { provider: "github", deliveryId: "old-gh", createdAt: daysAgo(8) },
      { provider: "gitlab", deliveryId: "old-gl", createdAt: daysAgo(30) },
      { provider: "github", deliveryId: "recent", createdAt: daysAgo(6) },
    ]);

    expect(await pruneWebhookDeliveries(db, daysAgo(7))).toBe(2);
    const rows = await db.select({ id: webhookDeliveries.deliveryId }).from(webhookDeliveries);
    expect(rows.map((r) => r.id)).toEqual(["recent"]);
  });

  it("uses the created_at index", async () => {
    const plan = await db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const result = await tx.execute(
        sql`explain delete from webhook_deliveries where created_at < now() - interval '7 days'`,
      );
      return result.rows.map((r) => String(Object.values(r)[0])).join("\n");
    });
    expect(plan).toContain("webhook_deliveries_created_at_idx");
  });

  it("claims Linear deliveries (no repository) once until released", async () => {
    const ref = { provider: "linear" as const, deliveryId: "linear-1" };
    expect(await claimWebhookDelivery(db, ref)).toBe(true);
    expect(await claimWebhookDelivery(db, ref)).toBe(false);
    // Same delivery ID from another provider is a different delivery.
    expect(await claimWebhookDelivery(db, { provider: "github", deliveryId: "linear-1" })).toBe(
      true,
    );
    await releaseWebhookDelivery(db, ref);
    expect(await claimWebhookDelivery(db, ref)).toBe(true);
  });
});
