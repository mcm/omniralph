import { createTestDatabase, testDatabaseAvailable, type TestDatabase } from "../testing/index.js";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { captureChanges } from "./changes.js";
import { closeDb, createDb, type Database } from "./client.js";
import { organizations, scmConnections, webhookEvents } from "./schema.js";
import {
  getWebhookEvent,
  getWebhookEventSourceOrganizationId,
  listWebhookEventReplays,
  listWebhookEvents,
  pruneWebhookEvents,
  recordWebhookEvent,
  updateWebhookEventOutcome,
  webhookEventPayload,
  WEBHOOK_EVENT_PAYLOAD_MAX_BYTES,
} from "./webhook-events.js";

const databaseAvailable = testDatabaseAvailable();

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

describe("webhookEventPayload", () => {
  it("keeps a body up to the limit and drops a larger one", () => {
    const fits = JSON.stringify({ x: "a".repeat(WEBHOOK_EVENT_PAYLOAD_MAX_BYTES - 10) });
    expect(Buffer.byteLength(fits)).toBeLessThanOrEqual(WEBHOOK_EVENT_PAYLOAD_MAX_BYTES);
    expect(webhookEventPayload(fits).payloadTruncated).toBe(false);
    // Counted in bytes, not characters.
    const multibyte = JSON.stringify({ x: "é".repeat(WEBHOOK_EVENT_PAYLOAD_MAX_BYTES / 2) });
    expect(webhookEventPayload(multibyte)).toEqual({ payload: null, payloadTruncated: true });
  });
});

describe.skipIf(!databaseAvailable)("webhook event queries", () => {
  let testDb: TestDatabase;
  let db: Database;
  let organizationId: string;
  let connectionId: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
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
    connectionId = connection!.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    await db.delete(webhookEvents);
  });

  const record = (deliveryId: string) =>
    recordWebhookEvent(db, {
      organizationId,
      provider: "github",
      source: { scmConnectionId: connectionId },
      deliveryId,
      event: "pull_request.opened",
      rawBody: "{}",
      outcome: "ignored",
    });

  it("creates the table with its foreign keys and indexes", async () => {
    const indexes = await db.execute(
      sql`select indexname from pg_indexes where tablename = 'webhook_events' order by indexname`,
    );
    expect(indexes.rows.map((r) => r.indexname)).toEqual([
      "webhook_events_integration_received_at_idx",
      "webhook_events_pkey",
      "webhook_events_received_at_idx",
      "webhook_events_scm_connection_received_at_idx",
    ]);
    const fks = await db.execute(
      sql`select conname, confdeltype from pg_constraint
          where conrelid = 'webhook_events'::regclass and contype = 'f' order by conname`,
    );
    expect(fks.rows.map((r) => [r.conname, r.confdeltype])).toEqual([
      ["webhook_events_integration_id_integrations_id_fk", "c"],
      ["webhook_events_organization_id_organizations_id_fk", "c"],
      ["webhook_events_replay_of_id_webhook_events_id_fk", "n"],
      ["webhook_events_replayed_by_users_id_fk", "n"],
      ["webhook_events_repository_id_repositories_id_fk", "n"],
      ["webhook_events_scm_connection_id_scm_connections_id_fk", "c"],
    ]);
  });

  it("pages newest first without skipping rows received in the same instant", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await record(`d${i}`));
    // Three in the same microsecond: the ID breaks the tie.
    const at = new Date();
    await db
      .update(webhookEvents)
      .set({ receivedAt: at })
      .where(sql`${webhookEvents.deliveryId} in ('d1', 'd2', 'd3')`);
    const expected = (
      await listWebhookEvents(db, { source: { scmConnectionId: connectionId }, limit: 100 })
    ).events.map((e) => e.id);
    expect(new Set(expected)).toEqual(new Set(ids));

    const seen: string[] = [];
    let cursor = null;
    for (;;) {
      const page: Awaited<ReturnType<typeof listWebhookEvents>> = await listWebhookEvents(db, {
        source: { scmConnectionId: connectionId },
        cursor,
        limit: 2,
      });
      seen.push(...page.events.map((e) => e.id));
      if (!page.next) break;
      cursor = page.next;
    }
    expect(seen).toEqual(expected);
  });

  it("records a change with the event's and connection's IDs, also when the outcome settles", async () => {
    const { result: id, changes } = await captureChanges(() => record("c1"));
    expect(changes).toEqual([
      expect.objectContaining({
        resource: "webhook_event",
        ids: [id, connectionId],
        organizationId,
      }),
    ]);
    const runId = crypto.randomUUID();
    const settled = await captureChanges(() =>
      updateWebhookEventOutcome(db, id, {
        outcome: "started_run",
        run: { id: runId, kind: "review" },
      }),
    );
    expect(settled.changes).toEqual([
      expect.objectContaining({ resource: "webhook_event", ids: [id, connectionId], runId }),
    ]);
    expect(await getWebhookEvent(db, id)).toMatchObject({
      outcome: "started_run",
      run: { id: runId, kind: "review" },
      reasonCode: null,
    });
  });

  it("lists a delivery's replays newest first, and a replay's change names the original", async () => {
    const original = await record("r0");
    const replay = (deliveryId: string) =>
      recordWebhookEvent(db, {
        organizationId,
        provider: "github",
        source: { scmConnectionId: connectionId },
        deliveryId,
        event: "pull_request.opened",
        rawBody: "{}",
        outcome: "ignored",
        replayOfId: original,
      });
    const { result: first, changes } = await captureChanges(() => replay("r0"));
    expect(changes).toEqual([
      expect.objectContaining({
        resource: "webhook_event",
        ids: [first, original, connectionId],
      }),
    ]);
    const second = await replay("r0");
    await record("other");
    expect((await listWebhookEventReplays(db, original)).map((e) => e.id)).toEqual([second, first]);
    expect(await listWebhookEventReplays(db, second)).toEqual([]);
  });

  it("finds the organization of a connection", async () => {
    expect(await getWebhookEventSourceOrganizationId(db, { scmConnectionId: connectionId })).toBe(
      organizationId,
    );
    expect(
      await getWebhookEventSourceOrganizationId(db, { integrationId: connectionId }),
    ).toBeNull();
  });

  it("prunes events received before the cutoff, in batches", async () => {
    for (let i = 0; i < 7; i++) await record(`old-${i}`);
    await db
      .update(webhookEvents)
      .set({ receivedAt: daysAgo(15) })
      .where(sql`${webhookEvents.deliveryId} like 'old-%'`);
    const recent = await record("recent");
    expect(await pruneWebhookEvents(db, daysAgo(14), 3)).toBe(7);
    const rows = await db.select({ id: webhookEvents.id }).from(webhookEvents);
    expect(rows.map((r) => r.id)).toEqual([recent]);
    expect(await pruneWebhookEvents(db, daysAgo(14), 3)).toBe(0);
    expect(await db.select().from(webhookEvents).where(eq(webhookEvents.id, recent))).toHaveLength(
      1,
    );
  });
});
