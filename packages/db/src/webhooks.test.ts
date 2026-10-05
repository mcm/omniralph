import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Database } from "./client.js";
import { runMigrations } from "./migrate.js";
import { webhookDeliveries } from "./schema.js";
import { pruneWebhookDeliveries } from "./webhooks.js";

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

describe.skipIf(!dockerAvailable)("webhook delivery queries", () => {
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
});
