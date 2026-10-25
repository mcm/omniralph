import { randomBytes } from "node:crypto";
import { closeDb, createDb, insertJob, jobs, organizations, type Database } from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  deferred: [] as (() => Promise<void>)[],
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  after: (task: () => Promise<void>) => void state.deferred.push(task),
}));

process.env.CRON_SECRET = "cron-secret";
process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const { GET: expireJobs } = await import("./expire-jobs/route");

describe.skipIf(!testDatabaseAvailable())("GET /api/cron/expire-jobs", () => {
  let testDb: TestDatabase;
  let orgId: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    state.db = createDb(testDb.uri);
    const [org] = await state.db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
  }, 180_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    if (state.db) await closeDb(state.db);
    await testDb?.stop();
  });

  it("publishes the expired attempts as live changes after responding", async () => {
    vi.stubEnv("ABLY_API_KEY", "appId.keyId:secret");
    const fetch = vi.fn(async () => new Response("{}", { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    const { job } = await insertJob(state.db, {
      organizationId: orgId,
      type: "repo.sync",
      taskType: "system",
      pool: null,
    });
    await state.db
      .update(jobs)
      .set({ createdAt: new Date(Date.now() - 2 * 24 * 3600_000) })
      .where(eq(jobs.id, job.id));

    const response = await expireJobs(
      new Request("http://localhost/api/cron/expire-jobs", {
        headers: { authorization: "Bearer cron-secret" },
      }),
    );
    expect(await response.json()).toEqual({ expired: 1 });
    expect(fetch).not.toHaveBeenCalled();
    for (const task of state.deferred.splice(0)) await task();

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://rest.ably.io/messages");
    const [spec] = JSON.parse(init.body as string) as {
      channels: string[];
      messages: { name: string; data: string }[];
    }[];
    expect(spec!.channels).toEqual([`org:${orgId}:changes`]);
    expect(spec!.messages.map((m) => JSON.parse(m.data))).toEqual([
      {
        v: 1,
        resource: "run",
        ids: [job.id],
        organizationId: orgId,
        at: expect.any(String),
      },
    ]);
  });
});
