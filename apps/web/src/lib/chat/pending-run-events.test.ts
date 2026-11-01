import { randomBytes, randomUUID } from "node:crypto";
import {
  chatRunEvents,
  closeDb,
  createDb,
  createRun,
  ensureChatThread,
  hasPendingRunEvents,
  mapThreadRun,
  markRunEventsProcessed,
  organizations,
  saveChatConnection,
  type ChatThread,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestRedis, testRedisAvailable, type TestRedis } from "@/lib/hot-state/testing";
import type { ChatTarget } from "@/lib/ralph/conversation";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  /** Chat bot initialisations (`defaultWakeDeps`). */
  inits: 0,
  /** Cron catch-up runs. */
  runs: 0,
  /** Runs during the next catch-up, e.g. a writer committing meanwhile. */
  during: undefined as (() => Promise<void>) | undefined,
  /** Whether the next catch-up relays the pending events (else they stay pending). */
  relay: true,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/chat/agent/wake", () => ({
  defaultWakeDeps: async () => {
    state.inits += 1;
    return { db: state.db };
  },
  // Relays every pending event, as wake-ups that all went well.
  processPendingRunEvents: async ({ db }: { db: Database }) => {
    state.runs += 1;
    const pending = await db.select().from(chatRunEvents).where(isNull(chatRunEvents.processedAt));
    await state.during?.();
    state.during = undefined;
    if (!state.relay) return { locked: pending.length };
    for (const event of pending) {
      await markRunEventsProcessed(db, event.organizationId, [event.id]);
    }
    return { processed: pending.length };
  },
}));

process.env.CRON_SECRET = "cron-secret";
const { EPOCH_KEY, closeRedis, getRedis } = await import("@/lib/hot-state");
const { markRunEventsPending } = await import("./pending-run-events");
const { recordChatRunEvent } = await import("./run-events");
const { GET } = await import("@/app/api/cron/chat-run-events/route");

const databaseAvailable = testDatabaseAvailable();
const redisAvailable = await testRedisAvailable();

const PENDING_KEY = "chat-run-events:pending";

const cron = async () =>
  (await GET(
    new Request("http://localhost/api/cron/chat-run-events", {
      headers: { authorization: "Bearer cron-secret" },
    }),
  ).then((res) => res.json())) as Record<string, unknown>;

describe.skipIf(!databaseAvailable || !redisAvailable)("chat run events marker", () => {
  let testDb: TestDatabase;
  let testRedis: TestRedis;
  let db: Database;
  let organizationId: string;
  let thread: ChatThread;
  /** Postgres calls made through `state.db` (the route's `getDb()`). */
  let postgresCalls = 0;
  /** While set, any Postgres call through `state.db` throws. */
  let noPostgres = false;

  beforeAll(async () => {
    [testDb, testRedis] = await Promise.all([createTestDatabase(), startTestRedis()]);
    db = createDb(testDb.uri);
    const queryMethods = new Set([
      "select",
      "selectDistinct",
      "insert",
      "update",
      "delete",
      "execute",
      "transaction",
      "query",
    ]);
    state.db = new Proxy(db, {
      get(target, property, receiver) {
        if (typeof property === "string" && queryMethods.has(property)) {
          if (noPostgres) throw new Error(`Postgres queried while idle (${property})`);
          postgresCalls += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const [org] = await db.insert(organizations).values({ name: "Chatco" }).returning();
    organizationId = org!.id;
    const connection = await saveChatConnection(
      db,
      {
        organizationId,
        platform: "discord",
        externalId: "G1",
        name: "Chatco",
        credentials: null,
        installedByUserId: null,
      },
      randomBytes(32),
    );
    if (connection === "other_organization") throw new Error("connected elsewhere");
    thread = (await ensureChatThread(db, {
      connectionId: connection.id,
      externalThreadId: "discord:G1:CH1:T1",
      channelId: "discord:G1:CH1",
      startedByExternalUserId: "D-ADA",
    }))!;
  }, 180_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await closeRedis();
    if (db) await closeDb(db);
    await Promise.all([testDb?.stop(), testRedis?.stop()]);
  });

  beforeEach(async () => {
    vi.stubEnv("REDIS_URL", testRedis.url);
    await closeRedis();
    await getRedis().flushdb();
    await db.delete(chatRunEvents);
    state.inits = 0;
    state.runs = 0;
    state.during = undefined;
    state.relay = true;
    noPostgres = false;
  });

  /** Records a run event of a new coding run mapped to the thread, as a run's sink does. */
  async function recordEvent(): Promise<void> {
    const { run } = await createRun(db, {
      organizationId,
      trackerIssueId: `issue-${randomUUID()}`,
      trackerIdentifier: "TOOL-1",
      trackerSessionId: `session-${randomUUID()}`,
      kind: "children",
      repositoryId: null,
      status: "running",
    });
    await mapThreadRun(db, { organizationId, chatThreadId: thread.id, ralphRunId: run.id });
    const target = { channel: { db }, thread, allowedHosts: [] } as unknown as ChatTarget;
    expect(
      await recordChatRunEvent(target, {
        organizationId,
        run: { ralphRunId: run.id },
        kind: "response",
        body: { text: "Done." },
        key: "response",
      }),
    ).toBe(true);
  }

  /** Brings Redis to idle: a run that left nothing pending. */
  async function idle() {
    await cron();
    expect(await getRedis().exists(EPOCH_KEY)).toBe(1);
    expect(await getRedis().exists(PENDING_KEY)).toBe(0);
    state.inits = 0;
    state.runs = 0;
  }

  it("skips without querying Postgres or initialising the chat bot while idle", async () => {
    await idle();
    noPostgres = true;
    expect(await cron()).toEqual({ skipped: true });
    expect(await cron()).toEqual({ skipped: true });
    expect(state.runs).toBe(0);
    expect(state.inits).toBe(0);
  });

  it("runs once an event is recorded, then clears the marker once it's relayed", async () => {
    await idle();
    await recordEvent();
    expect(await getRedis().exists(PENDING_KEY)).toBe(1);
    expect(await cron()).toEqual({ processed: 1 });
    expect(state.inits).toBe(1);
    expect(await getRedis().exists(PENDING_KEY)).toBe(0);
    expect(await hasPendingRunEvents(db, { maxAttempts: 5 })).toBe(false);
    noPostgres = true;
    expect(await cron()).toEqual({ skipped: true });
    expect(state.runs).toBe(1);
  });

  it("keeps the marker while events stay pending", async () => {
    await idle();
    await recordEvent();
    state.relay = false;
    await cron();
    await cron();
    expect(state.runs).toBe(2);
    expect(await getRedis().exists(PENDING_KEY)).toBe(1);
    state.relay = true;
    expect(await cron()).toEqual({ processed: 1 });
    expect(await getRedis().exists(PENDING_KEY)).toBe(0);
  });

  it("doesn't lose an event recorded during a run", async () => {
    await idle();
    await recordEvent();
    // Recorded after the run read its events: it stays pending.
    state.during = recordEvent;
    expect(await cron()).toEqual({ processed: 1 });
    expect(await getRedis().exists(PENDING_KEY)).toBe(1);
    expect(await cron()).toEqual({ processed: 1 });
    expect(await getRedis().exists(PENDING_KEY)).toBe(0);
  });

  it("keeps a marker set during a run that left nothing pending", async () => {
    await idle();
    await markRunEventsPending();
    state.during = markRunEventsPending;
    await cron();
    expect(await getRedis().exists(PENDING_KEY)).toBe(1);
    await cron();
    expect(state.runs).toBe(2);
    expect(await getRedis().exists(PENDING_KEY)).toBe(0);
  });

  it("processes pending events after Redis was flushed", async () => {
    await idle();
    await recordEvent();
    await getRedis().flushdb();
    expect(await cron()).toEqual({ processed: 1 });
    expect(state.runs).toBe(1);
    expect(await getRedis().exists(PENDING_KEY)).toBe(0);
  });

  it("processes pending events on every run without Redis", async () => {
    vi.stubEnv("REDIS_URL", "");
    await closeRedis();
    await recordEvent();
    expect(await cron()).toEqual({ processed: 1 });
    postgresCalls = 0;
    expect(await cron()).toEqual({ processed: 0 });
    expect(state.runs).toBe(2);
    expect(postgresCalls).toBeGreaterThan(0);
  });

  it("processes pending events while Redis is down", async () => {
    await idle();
    await recordEvent();
    vi.stubEnv("REDIS_URL", "redis://127.0.0.1:1");
    await closeRedis();
    expect(await cron()).toEqual({ processed: 1 });
  });
});
