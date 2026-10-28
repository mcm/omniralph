import {
  captureChanges,
  closeDb,
  createDb,
  modelPrices,
  organizations,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { asc, sql } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ db: undefined as unknown as Database }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));

process.env.CRON_SECRET = "cron-secret";

const { GET } = await import("./model-prices/route");
const { changeMessage } = await import("@/lib/live/publisher");
const { GATEWAY_MODELS_URL } = await import("@/lib/cost/prices");

const model = (id: string, pricing: unknown, extra: Record<string, unknown> = {}) => ({
  id,
  object: "model",
  created: 1_760_000_000,
  owned_by: "anthropic",
  name: id.replace("anthropic/", ""),
  type: "language",
  pricing,
  ...extra,
});

const OPUS = {
  input: "0.000004",
  output: "0.00002",
  input_cache_read: "0.0000002",
  input_cache_write: "0.000005",
};

/** The Gateway's list (Oct 25): Anthropic models and their variants, and other providers'. */
const list = (opus: Record<string, unknown> = OPUS) => ({
  object: "list",
  data: [
    model("anthropic/claude-opus-5.5", opus),
    // Long-context pricing above 100,000 prompt tokens.
    model("anthropic/claude-haiku-5.5", {
      input: "0.000001",
      output: "0.000005",
      input_cache_read: "0.0000001",
      input_cache_write: "0.00000125",
      input_tiers: [
        { cost: "0.000001", min: 0, max: 100_000 },
        { cost: "0.000002", min: 100_000 },
      ],
      output_tiers: [
        { cost: "0.000005", min: 0, max: 100_000 },
        { cost: "0.0000075", min: 100_000 },
      ],
    }),
    model("anthropic/claude-opus-5.5-fast", { ...OPUS, input: "0.000024", output: "0.00012" }),
    model("anthropic/claude-opus-5.5-batch", { ...OPUS, input: "0.000002", output: "0.00001" }),
    model("anthropic/claude-embed", OPUS, { type: "embedding" }),
    model("openai/gpt-5", OPUS, { owned_by: "openai" }),
    // Pricing that doesn't parse is skipped, not fatal.
    model("anthropic/claude-mystery", { input: "free" }),
  ],
});

let respond: () => Response = () => HttpResponse.json(list());
let requests: Request[] = [];
const server = setupServer(
  http.get(GATEWAY_MODELS_URL, ({ request }) => {
    requests.push(request);
    return respond();
  }),
);

describe.skipIf(!testDatabaseAvailable())("GET /api/cron/model-prices", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgs: string[];

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    const created = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Beta" }])
      .returning();
    orgs = created.map((o) => o.id);
    server.listen({ onUnhandledFrame: "error" });
  }, 120_000);

  afterAll(async () => {
    server.close();
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  afterEach(async () => {
    await db.delete(modelPrices);
    respond = () => HttpResponse.json(list());
    requests = [];
  });

  async function runCron(secret = "cron-secret") {
    const { result, changes } = await captureChanges(() =>
      GET(
        new Request("http://localhost/api/cron/model-prices", {
          headers: { authorization: `Bearer ${secret}` },
        }),
      ),
    );
    return {
      status: result.status,
      body: (await result.json()) as unknown,
      events: changes.map((change) => changeMessage(change).event),
    };
  }

  const stored = () =>
    db
      .select({
        modelId: modelPrices.modelId,
        inputUsd: modelPrices.inputUsd,
        outputUsd: modelPrices.outputUsd,
        cacheReadUsd: modelPrices.cacheReadUsd,
        cacheWriteUsd: modelPrices.cacheWriteUsd,
        baseTierMaxTokens: modelPrices.baseTierMaxTokens,
        validFrom: sql<string>`${modelPrices.validFrom}::text`,
        open: sql<boolean>`${modelPrices.validTo} is null`,
      })
      .from(modelPrices)
      .orderBy(asc(modelPrices.modelId), asc(modelPrices.checkedAt));

  it("requires CRON_SECRET", async () => {
    expect((await runCron("wrong")).status).toBe(401);
    expect(requests).toEqual([]);
  });

  it("stores Anthropic language models' base prices without credentials, and announces them", async () => {
    const { status, body, events } = await runCron();
    expect(status).toBe(200);
    expect(body).toEqual({ inserted: 3, changed: 0, unchanged: 0 });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get("authorization")).toBeNull();
    expect(await stored()).toEqual([
      {
        modelId: "anthropic/claude-haiku-5.5",
        inputUsd: "0.000001",
        outputUsd: "0.000005",
        cacheReadUsd: "0.0000001",
        cacheWriteUsd: "0.00000125",
        baseTierMaxTokens: 100_000,
        validFrom: "-infinity",
        open: true,
      },
      {
        modelId: "anthropic/claude-opus-5.5",
        inputUsd: "0.000004",
        outputUsd: "0.00002",
        cacheReadUsd: "0.0000002",
        cacheWriteUsd: "0.000005",
        baseTierMaxTokens: null,
        validFrom: "-infinity",
        open: true,
      },
      // Stored, but no attempt's model maps to a fast variant.
      expect.objectContaining({ modelId: "anthropic/claude-opus-5.5-fast" }),
    ]);
    expect(events.map((e) => [e.resource, e.organizationId]).sort()).toEqual(
      orgs.map((id) => ["model_prices", id]).sort(),
    );
  });

  it("only checks unchanged prices and publishes nothing", async () => {
    await runCron();
    const { body, events } = await runCron();
    expect(body).toEqual({ inserted: 0, changed: 0, unchanged: 3 });
    expect(events).toEqual([]);
  });

  it("closes a changed price and opens a new one", async () => {
    await runCron();
    respond = () => HttpResponse.json(list({ ...OPUS, output: "0.000025" }));
    const { body, events } = await runCron();
    expect(body).toEqual({ inserted: 0, changed: 1, unchanged: 2 });
    expect(events).toHaveLength(orgs.length);
    const opus = (await stored()).filter((row) => row.modelId === "anthropic/claude-opus-5.5");
    expect(opus.map((row) => [row.outputUsd, row.open, row.validFrom === "-infinity"])).toEqual([
      ["0.00002", false, true],
      ["0.000025", true, false],
    ]);
  });

  it("changes nothing and answers 502 when the fetch or its parse fails", async () => {
    await runCron();
    const before = await stored();
    for (const failure of [
      () => HttpResponse.json({ error: "unavailable" }, { status: 503 }),
      () => HttpResponse.json({ object: "list", models: [] }),
      () => new HttpResponse("not json", { headers: { "content-type": "text/plain" } }),
      () => HttpResponse.error(),
    ]) {
      respond = failure;
      vi.spyOn(console, "error").mockImplementationOnce(() => {});
      const { status, events } = await runCron();
      expect(status).toBe(502);
      expect(events).toEqual([]);
      expect(await stored()).toEqual(before);
    }
  });
});
