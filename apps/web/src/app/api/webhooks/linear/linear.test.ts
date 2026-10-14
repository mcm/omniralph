import { randomBytes, randomUUID } from "node:crypto";
import {
  closeDb,
  createDb,
  integrations,
  organizations,
  saveIntegration,
  webhookDeliveries,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HandledLinearEvent, LinearEventContext } from "@/lib/linear/events";
import { signBody } from "@/lib/linear/webhook";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  handled: [] as Array<{ event: unknown; context: unknown }>,
  acknowledged: [] as string[],
  fail: false,
  deferred: [] as Array<() => Promise<void>>,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/linear/events", () => ({
  acknowledgeLinearEvent: async (event: HandledLinearEvent) => {
    state.acknowledged.push(event.kind);
  },
  handleLinearEvent: async (event: HandledLinearEvent, context: LinearEventContext) => {
    state.handled.push({
      event,
      context: { organizationId: context.organizationId, workspaceId: context.workspaceId },
    });
    if (state.fail) throw new Error("handler failed");
  },
}));
// Run `after()` tasks when the test flushes them, as Next.js does after responding.
vi.mock("next/server", () => ({
  after: (task: () => Promise<void>) => {
    state.deferred.push(task);
  },
}));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
const SECRET = "linear-webhook-secret";
process.env.LINEAR_WEBHOOK_SECRET = SECRET;

const { POST } = await import("./route");
const { handleLinearWebhook, linearDeliveryKey } = await import("@/lib/linear/ingest");

const databaseAvailable = testDatabaseAvailable();

const createdPayload = (overrides: Record<string, unknown> = {}) => ({
  type: "AgentSessionEvent",
  action: "created",
  organizationId: "org-1",
  webhookTimestamp: Date.now(),
  agentSession: { id: "session-1", issue: { id: "issue-1", identifier: "TOOL-1" } },
  ...overrides,
});

function deliver(
  payload: unknown,
  opts: { deliveryId?: string | null; signature?: string | null; raw?: string } = {},
) {
  const body = opts.raw ?? JSON.stringify(payload);
  const headers = new Headers({ "content-type": "application/json" });
  const signature = opts.signature === undefined ? signBody(body, SECRET) : opts.signature;
  if (signature !== null) headers.set("linear-signature", signature);
  const deliveryId = opts.deliveryId === undefined ? randomUUID() : opts.deliveryId;
  if (deliveryId !== null) headers.set("linear-delivery", deliveryId);
  return POST(
    new Request("https://omniralph.example.com/api/webhooks/linear", {
      method: "POST",
      headers,
      body,
    }),
  );
}

async function flush() {
  const tasks = state.deferred.splice(0);
  for (const task of tasks) await task();
}

describe.skipIf(!databaseAvailable)("POST /api/webhooks/linear", () => {
  let testDb: TestDatabase;
  let orgId: string;
  let otherOrgId: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    state.db = createDb(testDb.uri);
    const [org, other] = await state.db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Other" }])
      .returning();
    orgId = org!.id;
    otherOrgId = other!.id;
  }, 180_000);

  afterAll(async () => {
    if (state.db) await closeDb(state.db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    await state.db.delete(webhookDeliveries);
    await state.db.delete(integrations);
    await saveIntegration(state.db, {
      organizationId: orgId,
      provider: "linear",
      externalId: "org-1",
      name: "Acme",
      credentials: { accessToken: "t" },
      installedByUserId: null,
    });
    state.handled = [];
    state.acknowledged = [];
    state.deferred = [];
    state.fail = false;
    process.env.LINEAR_WEBHOOK_SECRET = SECRET;
  });

  it("accepts a created session and hands it to the handler after responding", async () => {
    const res = await deliver(createdPayload());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "accepted", kind: "session_created" });
    // Acknowledged before the response, handled after it.
    expect(state.acknowledged).toEqual(["session_created"]);
    expect(state.handled).toEqual([]);
    await flush();
    expect(state.handled).toEqual([
      {
        event: {
          kind: "session_created",
          sessionId: "session-1",
          issueId: "issue-1",
          issueIdentifier: "TOOL-1",
          promptContext: undefined,
          commentBody: undefined,
          creatorName: undefined,
        },
        context: { organizationId: orgId, workspaceId: "org-1" },
      },
    ]);
  });

  it("classifies prompts and issue state changes, and ignores other events", async () => {
    const prompted = await deliver(
      createdPayload({
        action: "prompted",
        agentActivity: { content: { body: "keep going" } },
      }),
    );
    expect(await prompted.json()).toEqual({ status: "accepted", kind: "session_prompted" });
    const issue = await deliver({
      type: "Issue",
      action: "update",
      organizationId: "org-1",
      webhookTimestamp: Date.now(),
      updatedFrom: { stateId: "s-old" },
      data: { id: "issue-9", identifier: "TOOL-9", state: { type: "completed" } },
    });
    expect(await issue.json()).toEqual({ status: "accepted", kind: "issue_state" });
    const comment = await deliver({
      type: "Comment",
      action: "create",
      organizationId: "org-1",
      webhookTimestamp: Date.now(),
    });
    expect(await comment.json()).toEqual({ status: "ignored", reason: "type Comment" });
    await flush();
    expect(state.handled.map((h) => (h.event as { kind: string }).kind)).toEqual([
      "session_prompted",
      "issue_state",
    ]);
    // Ignored events aren't recorded as deliveries.
    expect(await state.db.select().from(webhookDeliveries)).toHaveLength(2);
  });

  it("rejects bad or missing signatures", async () => {
    expect((await deliver(createdPayload(), { signature: null })).status).toBe(401);
    expect((await deliver(createdPayload(), { signature: signBody("x", SECRET) })).status).toBe(
      401,
    );
    const tampered = await deliver(createdPayload(), {
      signature: signBody(JSON.stringify(createdPayload({ organizationId: "evil" })), SECRET),
    });
    expect(tampered.status).toBe(401);
    expect(await tampered.json()).toEqual({ error: "invalid_signature" });
    await flush();
    expect(state.handled).toEqual([]);
  });

  it("rejects timestamps skewed by more than 60s", async () => {
    for (const skew of [-61_000, 61_000]) {
      const res = await deliver(createdPayload({ webhookTimestamp: Date.now() + skew }));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "stale_timestamp" });
    }
    await flush();
    expect(state.handled).toEqual([]);
  });

  it("rejects everything when LINEAR_WEBHOOK_SECRET is unset", async () => {
    delete process.env.LINEAR_WEBHOOK_SECRET;
    expect((await deliver(createdPayload())).status).toBe(503);
  });

  it("dedupes redeliveries by Linear-Delivery", async () => {
    const id = randomUUID();
    expect(await (await deliver(createdPayload(), { deliveryId: id })).json()).toMatchObject({
      status: "accepted",
    });
    expect(await (await deliver(createdPayload(), { deliveryId: id })).json()).toEqual({
      status: "duplicate",
    });
    await flush();
    expect(state.handled).toHaveLength(1);
    expect(state.acknowledged).toEqual(["session_created"]);
    const rows = await state.db.select().from(webhookDeliveries);
    expect(rows).toMatchObject([{ provider: "linear", deliveryId: id, repositoryId: null }]);
  });

  it("dedupes a delivery without Linear-Delivery by a hash of its body", async () => {
    const payload = createdPayload();
    const raw = JSON.stringify(payload);
    expect(await (await deliver(payload, { deliveryId: null })).json()).toMatchObject({
      status: "accepted",
    });
    expect(await (await deliver(payload, { deliveryId: null })).json()).toEqual({
      status: "duplicate",
    });
    // A different body (e.g. a later timestamp) is a different delivery.
    const other = createdPayload({ webhookTimestamp: payload.webhookTimestamp + 1 });
    expect(await (await deliver(other, { deliveryId: null })).json()).toMatchObject({
      status: "accepted",
    });
    // A blank header counts as missing.
    expect(await (await deliver(payload, { deliveryId: "  " })).json()).toEqual({
      status: "duplicate",
    });
    await flush();
    expect(state.handled).toHaveLength(2);
    const rows = await state.db.select().from(webhookDeliveries);
    expect(rows.map((r) => r.deliveryId)).toContain(linearDeliveryKey(null, raw));
    expect(linearDeliveryKey(null, raw)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(linearDeliveryKey(" id-1 ", raw)).toBe("id-1");
  });

  it("releases a body-hash delivery when the handler fails, so a replay is handled", async () => {
    const payload = createdPayload();
    state.fail = true;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await deliver(payload, { deliveryId: null });
      await flush();
    } finally {
      consoleError.mockRestore();
    }
    state.fail = false;
    expect(await (await deliver(payload, { deliveryId: null })).json()).toMatchObject({
      status: "accepted",
    });
  });

  it("responds within the acknowledgement budget and handles the event after the slow ack", async () => {
    const order: string[] = [];
    let finishAck!: () => void;
    const deferred: Array<() => Promise<void>> = [];
    const body = JSON.stringify(createdPayload());
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const started = Date.now();
      const res = await handleLinearWebhook(
        new Request("https://omniralph.example.com/api/webhooks/linear", {
          method: "POST",
          headers: { "linear-signature": signBody(body, SECRET), "linear-delivery": randomUUID() },
          body,
        }),
        {
          db: state.db,
          secret: SECRET,
          acknowledgeTimeoutMs: 50,
          acknowledge: () =>
            new Promise<void>((resolve) => {
              finishAck = () => {
                order.push("acknowledged");
                resolve();
              };
            }),
          handle: async () => {
            order.push("handled");
          },
          defer: (task) => {
            deferred.push(task);
          },
        },
      );
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(await res.json()).toEqual({ status: "accepted", kind: "session_created" });
      expect(consoleError).toHaveBeenCalledWith(expect.stringMatching(/timed out/));

      const running = Promise.all(deferred.map((task) => task()));
      await new Promise((r) => setTimeout(r, 10));
      expect(order).toEqual([]);
      finishAck();
      await running;
      expect(order).toEqual(["acknowledged", "handled"]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("releases the delivery when the handler fails, so a redelivery is handled", async () => {
    const id = randomUUID();
    state.fail = true;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await deliver(createdPayload(), { deliveryId: id });
      await flush();
    } finally {
      consoleError.mockRestore();
    }
    state.fail = false;
    expect(await (await deliver(createdPayload(), { deliveryId: id })).json()).toMatchObject({
      status: "accepted",
    });
    await flush();
    expect(state.handled).toHaveLength(2);
  });

  it("hands an event to the organization that connected its workspace", async () => {
    await saveIntegration(state.db, {
      organizationId: otherOrgId,
      provider: "linear",
      externalId: "org-2",
      name: "Other",
      credentials: { accessToken: "t2" },
      installedByUserId: null,
    });
    expect(await (await deliver(createdPayload({ organizationId: "org-2" }))).json()).toMatchObject(
      { status: "accepted" },
    );
    expect(await (await deliver(createdPayload())).json()).toMatchObject({ status: "accepted" });
    await flush();
    expect(state.handled.map((h) => h.context)).toEqual([
      { organizationId: otherOrgId, workspaceId: "org-2" },
      { organizationId: orgId, workspaceId: "org-1" },
    ]);
  });

  it("ignores events from other workspaces or with no workspace connected", async () => {
    const other = await deliver(createdPayload({ organizationId: "org-2" }));
    expect(await other.json()).toEqual({ status: "ignored", reason: "unknown_workspace" });
    const missing = await deliver(createdPayload({ organizationId: undefined }));
    expect(await missing.json()).toEqual({ status: "ignored", reason: "unknown_workspace" });
    await state.db.delete(integrations);
    const none = await deliver(createdPayload());
    expect(await none.json()).toEqual({ status: "ignored", reason: "unknown_workspace" });
    await flush();
    expect(state.handled).toEqual([]);
  });
});
