import { randomUUID } from "node:crypto";
import { closeDb, createDb, organizations, recordChange, type Database } from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgUser } from "@/lib/auth/session";

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
const ORG = randomUUID();
const user: OrgUser = {
  id: randomUUID(),
  organization: { id: ORG, name: "Acme" },
  role: "member",
  name: "Ada",
  email: null,
  image: null,
  theme: null,
  showAdvanced: false,
};
vi.mock("@/lib/auth/session", () => ({
  requireUser: async () => user,
  requireSignedInUser: async () => user,
}));

const { apiHandler } = await import("@/lib/api/handler");
const { liveDeferred, liveRoute, withLiveChanges, TRANSCRIPT_COALESCE_SECONDS } =
  await import("./request");
const { CHANGE_PUBLISH_TIMEOUT_MS } = await import("./publisher");
import type { ChangeMessage, ChangePublisher } from "./publisher";

/** Runs the work scheduled after the response. */
async function runDeferred() {
  while (state.deferred.length > 0) await state.deferred.shift()!();
}

/** A publisher that keeps every batch it was asked to publish. */
function recordingPublisher() {
  const batches: ChangeMessage[][] = [];
  const publisher: ChangePublisher = {
    publish: async (messages) => void batches.push([...messages]),
  };
  return { publisher, batches };
}

describe("withLiveChanges", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    state.deferred = [];
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("publishes the de-duplicated changes after the response in one batch", async () => {
    const { publisher, batches } = recordingPublisher();
    const runId = randomUUID();
    const jobId = randomUUID();
    const result = await withLiveChanges(
      async () => {
        recordChange({}, { resource: "run", ids: [runId], runId, organizationId: ORG });
        recordChange({}, { resource: "run", ids: [runId], runId, organizationId: ORG });
        recordChange({}, { resource: "run", ids: [jobId], runId, organizationId: ORG });
        recordChange(
          {},
          { resource: "inbox_state", ids: ["done:x"], organizationId: ORG, userId: user.id },
        );
        expect(batches).toEqual([]);
        return "response";
      },
      { publisher },
    );
    expect(result).toBe("response");
    expect(batches).toEqual([]);
    await runDeferred();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([
      {
        channel: `org:${ORG}:changes`,
        event: {
          v: 1,
          resource: "run",
          ids: [runId, jobId],
          organizationId: ORG,
          runId,
          at: expect.any(String),
        },
      },
      {
        channel: `user:${user.id}:changes`,
        event: {
          v: 1,
          resource: "inbox_state",
          ids: ["done:x"],
          organizationId: ORG,
          at: expect.any(String),
        },
      },
    ]);
  });

  it("publishes nothing, and schedules nothing, without changes", async () => {
    const { publisher, batches } = recordingPublisher();
    await withLiveChanges(async () => {}, { publisher });
    expect(state.deferred).toEqual([]);
    expect(batches).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("publishes what deferred work commits when it finishes", async () => {
    const { publisher, batches } = recordingPublisher();
    const id = randomUUID();
    await withLiveChanges(
      async () => {
        state.deferred.push(
          liveDeferred(
            async () =>
              recordChange({}, { resource: "webhook_event", ids: [id], organizationId: ORG }),
            { publisher },
          ),
        );
      },
      { publisher },
    );
    await runDeferred();
    expect(batches.flat().map((m) => m.event.ids)).toEqual([[id]]);
  });

  it("publishes changes recorded after the response on their own", async () => {
    const { publisher, batches } = recordingPublisher();
    let recordedLate!: Promise<void>;
    await withLiveChanges(
      async () => {
        // Work the handler started but didn't await (it keeps the request's context).
        recordedLate = new Promise((resolve) =>
          setTimeout(() => {
            recordChange({}, { resource: "agent", ids: [user.id], organizationId: ORG });
            resolve();
          }, 10),
        );
      },
      { publisher },
    );
    expect(state.deferred).toEqual([]);
    await recordedLate;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(batches.flat().map((m) => m.event.resource)).toEqual(["agent"]);
  });
});

describe.skipIf(!testDatabaseAvailable())("publishing failures", () => {
  let testDb: TestDatabase;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    state.db = createDb(testDb.uri);
    await state.db.insert(organizations).values({ id: ORG, name: "Acme" });
  }, 180_000);

  afterAll(async () => {
    if (state.db) await closeDb(state.db);
    await testDb?.stop();
  });

  beforeEach(() => {
    state.deferred = [];
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  /** A handler that writes two rows and records two changes; answers with their names. */
  const handler = apiHandler({}, async () => {
    const names = [`Org ${randomUUID()}`, `Org ${randomUUID()}`];
    for (const name of names) {
      const [row] = await state.db.insert(organizations).values({ name }).returning();
      recordChange(state.db, { resource: "organization", ids: [row!.id], organizationId: row!.id });
      await state.db.transaction(async (tx) =>
        recordChange(tx, { resource: "repository", ids: [row!.id], organizationId: row!.id }),
      );
    }
    return { names };
  });

  async function callHandler() {
    const response = await handler(
      new Request("http://localhost/api/ui/things", { method: "POST" }),
      {
        params: Promise.resolve({}),
      },
    );
    const body = (await response.json()) as { names: string[] };
    await runDeferred();
    const rows = await Promise.all(
      body.names.map((name) =>
        state.db.select().from(organizations).where(eq(organizations.name, name)),
      ),
    );
    return { status: response.status, body, rows: rows.flat() };
  }

  const liveWarnings = () =>
    warn.mock.calls.filter((call: unknown[]) => String(call[0]).startsWith("live changes"));

  it("answers and writes as usual with ABLY_API_KEY unset, and logs it once", async () => {
    vi.stubEnv("ABLY_API_KEY", "");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { status, body, rows } = await callHandler();
    expect(status).toBe(200);
    expect(body.names).toHaveLength(2);
    expect(rows).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(liveWarnings()).toHaveLength(1);
    expect(String(liveWarnings()[0]![0])).toMatch(/Ably is off/);
  });

  it("answers and writes as usual when Ably answers 5xx, and logs it once", async () => {
    vi.stubEnv("ABLY_API_KEY", "appId.keyId:secret");
    const fetch = vi.fn(async () => new Response('{"error":{}}', { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const { status, rows } = await callHandler();
    expect(status).toBe(200);
    expect(rows).toHaveLength(2);
    // One batch request for all of the request's changes.
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://rest.ably.io/messages");
    const body = JSON.parse(init.body as string) as {
      channels: string[];
      messages: { name: string; data: string; encoding: string }[];
    }[];
    expect(body.flatMap((spec) => spec.channels)).toHaveLength(2);
    expect(body.flatMap((spec) => spec.messages)).toHaveLength(4);
    expect(body[0]!.messages[0]!).toMatchObject({ name: "change", encoding: "json" });
    expect(liveWarnings()).toHaveLength(1);
    expect(String(liveWarnings()[0]![0])).toMatch(/publishing the change events failed/);
  });

  it("answers and writes as usual when Ably times out, and logs it once", async () => {
    vi.stubEnv("ABLY_API_KEY", "appId.keyId:secret");
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const started = Date.now();
    const { status, rows } = await callHandler();
    expect(status).toBe(200);
    expect(rows).toHaveLength(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(CHANGE_PUBLISH_TIMEOUT_MS - 100);
    expect(fetch).toHaveBeenCalledOnce();
    expect(liveWarnings()).toHaveLength(1);
  }, 10_000);

  it("answers as usual when the fetch itself throws, through a live route", async () => {
    vi.stubEnv("ABLY_API_KEY", "appId.keyId:secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("fetch failed"))),
    );
    const route = liveRoute(async () => {
      recordChange({}, { resource: "agent", ids: [ORG], organizationId: ORG });
      recordChange({}, { resource: "connection", ids: [ORG], organizationId: ORG });
      return Response.json({ ok: true });
    });
    const response = await route();
    await runDeferred();
    expect(await response.json()).toEqual({ ok: true });
    expect(liveWarnings()).toHaveLength(1);
  });

  describe("transcript coalescing", () => {
    it("publishes at most a leading and a trailing event per run per second", async () => {
      const { publisher, batches } = recordingPublisher();
      const runId = randomUUID();
      const jobId = randomUUID();
      // One second's window, frozen at its start; the trailing publish waits for its end.
      const windowStart = Math.ceil(Date.now() / 1000) * 1000 + 5_000;
      let clock = windowStart;
      const sleeps: number[] = [];
      let finalActivityAt = 0;
      const options = {
        publisher,
        now: () => new Date(clock),
        sleep: async (ms: number) => {
          sleeps.push(ms);
          clock += ms;
        },
      };
      for (let i = 0; i < 50; i++) {
        clock = windowStart + i * 19; // 50 activities within one second
        finalActivityAt = clock;
        await withLiveChanges(async () => {
          recordChange({}, { resource: "transcript", ids: [jobId], runId, organizationId: ORG });
        }, options);
      }
      const pending = [...state.deferred];
      state.deferred = [];
      await Promise.all(pending.map((task) => task()));
      const events = batches.flat().map((m) => m.event);
      expect(events.length).toBeLessThanOrEqual(2);
      expect(events).toHaveLength(2);
      expect(events.every((e) => e.resource === "transcript" && e.runId === runId)).toBe(true);
      // The trailing publish goes out once the window has ended, after the final activity
      // (the deferred publishes run concurrently: either may be sent first).
      const latest = Math.max(...events.map((e) => Date.parse(e.at)));
      expect(latest).toBeGreaterThan(finalActivityAt);
      expect(latest).toBe(windowStart + TRANSCRIPT_COALESCE_SECONDS * 1000);
      expect(sleeps).toHaveLength(1);
    });

    it("publishes the next second's activity again", async () => {
      const { publisher, batches } = recordingPublisher();
      const runId = randomUUID();
      const start = Math.ceil(Date.now() / 1000) * 1000 + 60_000;
      for (const at of [start, start + 1_000, start + 2_500]) {
        await withLiveChanges(
          async () =>
            recordChange({}, { resource: "transcript", ids: [runId], runId, organizationId: ORG }),
          { publisher, now: () => new Date(at), sleep: async () => {} },
        );
      }
      await runDeferred();
      expect(batches.flat()).toHaveLength(3);
    });
  });
});
