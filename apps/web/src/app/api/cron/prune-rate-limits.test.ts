import { createDb, rateLimits, runMigrations, type Database } from "@omniralph/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ db: undefined as unknown as Database }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));

process.env.CRON_SECRET = "cron-secret";

const { GET: pruneRoute } = await import("./prune-rate-limits/route");
const {
  AGENT_RATE_LIMITS,
  AUTH_FAILURE_LIMIT,
  AUTH_FAILURE_WINDOW_SECONDS,
  AUTH_LOCKOUT_SECONDS,
  RATE_LIMIT_RETENTION_SECONDS,
  authLockoutRemaining,
  hitRateLimit,
  recordAuthFailure,
} = await import("@/lib/rate-limit");

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

function cronRequest(secret?: string) {
  return new Request("http://localhost/api/cron/prune-rate-limits", {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000);

describe.skipIf(!dockerAvailable)("GET /api/cron/prune-rate-limits", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    state.db = db;
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await db.delete(rateLimits);
  });

  async function keys(): Promise<string[]> {
    const rows = await db.select({ key: rateLimits.key }).from(rateLimits);
    return rows.map((r) => r.key).sort();
  }

  it("keeps windows longer than every lockout and failure window", () => {
    expect(RATE_LIMIT_RETENTION_SECONDS).toBe(60 * 60);
    expect(RATE_LIMIT_RETENTION_SECONDS).toBeGreaterThan(AUTH_LOCKOUT_SECONDS);
    expect(RATE_LIMIT_RETENTION_SECONDS).toBeGreaterThan(AUTH_FAILURE_WINDOW_SECONDS);
  });

  it("deletes windows older than 1 hour and keeps current ones", async () => {
    await db.insert(rateLimits).values([
      { key: "token:ip:old", windowStart: minutesAgo(61), count: 5 },
      { key: "auth_lockout:ip:old", windowStart: minutesAgo(24 * 60), count: 1 },
      { key: "token:ip:recent", windowStart: minutesAgo(59), count: 2 },
    ]);
    // Live counters written the way the agent API writes them.
    await hitRateLimit(db, AGENT_RATE_LIMITS.enrollPerIp("203.0.113.1"));
    for (let i = 0; i < AUTH_FAILURE_LIMIT; i += 1) {
      await recordAuthFailure(db, "203.0.113.2");
    }
    expect(await authLockoutRemaining(db, "203.0.113.2")).toBeGreaterThan(0);

    const res = await pruneRoute(cronRequest("cron-secret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pruned: 2 });

    expect(await keys()).toEqual([
      "auth_failed:ip:203.0.113.2",
      "auth_lockout:ip:203.0.113.2",
      "enroll:ip:203.0.113.1",
      "token:ip:recent",
    ]);
    // The lockout and the failure count survive the sweep.
    expect(await authLockoutRemaining(db, "203.0.113.2")).toBeGreaterThan(0);
    const [failed] = await db
      .select({ count: rateLimits.count })
      .from(rateLimits)
      .where(eq(rateLimits.key, "auth_failed:ip:203.0.113.2"));
    expect(failed?.count).toBe(AUTH_FAILURE_LIMIT);
  });

  it("requires CRON_SECRET", async () => {
    await db.insert(rateLimits).values({ key: "x", windowStart: minutesAgo(120), count: 1 });
    expect((await pruneRoute(cronRequest())).status).toBe(401);
    expect((await pruneRoute(cronRequest("wrong"))).status).toBe(401);
    expect(await keys()).toEqual(["x"]);
  });
});
