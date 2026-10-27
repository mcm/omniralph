import { randomBytes, randomUUID } from "node:crypto";
import {
  closeDb,
  connectRepository,
  createDb,
  organizationMembers,
  organizations,
  recordWebhookEvent,
  saveIntegration,
  upsertScmConnection,
  users,
  webhookEvents,
  type Database,
  type WebhookEventOutcome,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  deliveryDetailSchema,
  deliveryListSchema,
  type DeliveryDetail,
  type DeliveryList,
} from "@/lib/api/deliveries";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));

type TestUser = { id: string; role: Role; name: string | null; email: string | null; image: null };
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  user: null as TestUser | null,
  orgId: "",
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") =>
    assertRole(
      state.user && { ...state.user, organization: { id: state.orgId, name: "Acme" } },
      role,
    ),
}));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const list = await import("./[kind]/[id]/deliveries/route");
const detail = await import("../deliveries/[id]/route");

const databaseAvailable = testDatabaseAvailable();

const member: TestUser = {
  id: "member-1",
  role: "member",
  name: "Mia Member",
  email: null,
  image: null,
};

async function getList(kind: string, id: string, search = "") {
  const response = await list.GET(
    new Request(`http://localhost/api/ui/connections/${kind}/${id}/deliveries${search}`),
    { params: Promise.resolve({ kind, id }) },
  );
  return {
    status: response.status,
    body: (await response.json()) as DeliveryList & { error?: string },
  };
}

async function getDetail(id: string) {
  const response = await detail.GET(new Request(`http://localhost/api/ui/deliveries/${id}`), {
    params: Promise.resolve({ id }),
  });
  return {
    status: response.status,
    body: (await response.json()) as DeliveryDetail & { error?: string },
  };
}

describe.skipIf(!databaseAvailable)("webhook delivery log endpoints", () => {
  let testDb: TestDatabase;
  let db: Database;
  let acme: string;
  let beta: string;
  let acmeConnection: string;
  let acmeRepo: string;
  let betaIntegration: string;
  let otherConnection: string;
  /** Acme's deliveries, newest first. */
  const acmeEvents: Array<{ id: string; outcome: WebhookEventOutcome }> = [];
  let betaEvent: string;
  let otherEvent: string;
  let truncatedEvent: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    const [acmeOrg, betaOrg, otherOrg] = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Beta" }, { name: "Other" }])
      .returning();
    acme = acmeOrg!.id;
    beta = betaOrg!.id;
    state.orgId = acme;
    await db.insert(users).values({ id: member.id, name: member.name, email: "mia@acme.io" });
    await db.insert(organizationMembers).values([
      { organizationId: acme, userId: member.id, role: "member" },
      { organizationId: beta, userId: member.id, role: "admin" },
    ]);

    const connect = async (organizationId: string, name: string) => {
      const connection = (await upsertScmConnection(db, {
        organizationId,
        provider: "github",
        name,
        baseUrl: "https://api.github.com",
        externalId: `${name}-installation`,
        credentials: {},
      }))!;
      const repo = await connectRepository(db, {
        connectionId: connection.id,
        provider: "github",
        externalId: `${name}-1`,
        fullPath: `${name}/app`,
      });
      return { connection: connection.id, repo: repo.id };
    };
    ({ connection: acmeConnection, repo: acmeRepo } = await connect(acme, "acme"));
    ({ connection: otherConnection } = await connect(otherOrg!.id, "other"));
    const integration = await saveIntegration(db, {
      organizationId: beta,
      provider: "linear",
      externalId: "beta-workspace",
      name: "Beta",
      credentials: { accessToken: "t" },
      installedByUserId: null,
    });
    if (integration === "other_organization") throw new Error("setup");
    betaIntegration = integration.id;

    // Acme: five deliveries a minute apart, oldest first.
    const outcomes: WebhookEventOutcome[] = [
      "started_run",
      "ignored",
      "failed",
      "duplicate",
      "ignored",
    ];
    const runId = randomUUID();
    for (const [i, outcome] of outcomes.entries()) {
      const id = await recordWebhookEvent(db, {
        organizationId: acme,
        provider: "github",
        source: { scmConnectionId: acmeConnection },
        repositoryId: acmeRepo,
        deliveryId: `acme-${i}`,
        event: "pull_request.opened",
        rawBody: JSON.stringify({ action: "opened", n: i }),
        outcome,
        ...(outcome === "ignored" && { reasonCode: "draft", reason: "Drafts are off" }),
        ...(outcome === "started_run" && { run: { id: runId, kind: "review" as const } }),
      });
      await db
        .update(webhookEvents)
        .set({ receivedAt: new Date(Date.now() - (10 - i) * 60_000) })
        .where(eq(webhookEvents.id, id));
      acmeEvents.unshift({ id, outcome });
    }
    truncatedEvent = await recordWebhookEvent(db, {
      organizationId: acme,
      provider: "github",
      source: { scmConnectionId: acmeConnection },
      event: "pull_request.edited",
      rawBody: JSON.stringify({ padding: "x".repeat(300 * 1024) }),
      outcome: "ignored",
      reasonCode: "unsupported_event",
      reason: "Omniralph doesn't act on this event",
      replayOfId: acmeEvents.at(-1)!.id,
      replayedBy: member.id,
    });
    await db
      .update(webhookEvents)
      .set({ receivedAt: new Date(Date.now() - 20 * 60_000) })
      .where(eq(webhookEvents.id, truncatedEvent));
    acmeEvents.push({ id: truncatedEvent, outcome: "ignored" });
    betaEvent = await recordWebhookEvent(db, {
      organizationId: beta,
      provider: "linear",
      source: { integrationId: betaIntegration },
      event: "AgentSessionEvent.created",
      rawBody: JSON.stringify({ type: "AgentSessionEvent", action: "created" }),
      outcome: "started_run",
    });
    otherEvent = await recordWebhookEvent(db, {
      organizationId: otherOrg!.id,
      provider: "github",
      source: { scmConnectionId: otherConnection },
      event: "pull_request.opened",
      rawBody: "{}",
      outcome: "ignored",
    });
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  it("lists a connection's deliveries newest first, a page at a time", async () => {
    state.user = member;
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const search: string = `?limit=2${cursor ? `&cursor=${cursor}` : ""}`;
      const page = await getList("scm", acmeConnection, search);
      expect(page.status).toBe(200);
      expect(deliveryListSchema.parse(page.body)).toEqual(page.body);
      expect(page.body.deliveries.length).toBeLessThanOrEqual(2);
      seen.push(...page.body.deliveries.map((d) => d.id));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual(acmeEvents.map((e) => e.id));
  });

  it("carries the delivery's references and outcome", async () => {
    state.user = member;
    const { body } = await getList("scm", acmeConnection);
    const started = body.deliveries.find((d) => d.outcome === "started_run")!;
    expect(started).toMatchObject({
      provider: "github",
      connection: { kind: "scm", id: acmeConnection },
      organization: { id: acme, name: "Acme", role: "member" },
      repository: { id: acmeRepo, provider: "github", fullPath: "acme/app" },
      event: "pull_request.opened",
      run: { kind: "review" },
      payloadTruncated: false,
    });
    expect(started).not.toHaveProperty("payload");
    expect(body.deliveries.find((d) => d.id === truncatedEvent)).toMatchObject({
      payloadTruncated: true,
      repository: null,
      replayOfId: acmeEvents[acmeEvents.length - 2]!.id,
      replayedBy: { id: member.id, name: member.name ?? "Someone" },
    });
    expect(started.replayedBy).toBeNull();
  });

  it("filters by outcome", async () => {
    state.user = member;
    const { body } = await getList("scm", acmeConnection, "?outcome=failed&outcome=duplicate");
    expect(body.deliveries.map((d) => d.outcome)).toEqual(["duplicate", "failed"]);
    const ignored = await getList("scm", acmeConnection, "?outcome=ignored");
    expect(ignored.body.deliveries.map((d) => d.reasonCode)).toEqual([
      "draft",
      "draft",
      "unsupported_event",
    ]);
  });

  it("answers 400 for a bad query", async () => {
    state.user = member;
    for (const search of ["?outcome=enqueued", "?cursor=nope", "?limit=0", "?limit=101"]) {
      expect((await getList("scm", acmeConnection, search)).status, search).toBe(400);
    }
  });

  it("serves another of the user's organizations' Linear deliveries without switching", async () => {
    state.user = member;
    const { status, body } = await getList("linear", betaIntegration);
    expect(status).toBe(200);
    expect(body.deliveries).toEqual([
      expect.objectContaining({
        id: betaEvent,
        provider: "linear",
        connection: { kind: "linear", id: betaIntegration },
        organization: { id: beta, name: "Beta", role: "admin" },
        repository: null,
      }),
    ]);
    expect((await getDetail(betaEvent)).status).toBe(200);
  });

  it("doesn't find other organizations' connections or deliveries", async () => {
    state.user = member;
    for (const [kind, id] of [
      ["scm", otherConnection],
      ["linear", acmeConnection],
      ["scm", betaIntegration],
      ["scm", randomUUID()],
      ["scm", "not-a-uuid"],
      ["github", acmeConnection],
    ] as const) {
      expect((await getList(kind, id)).status, `${kind}/${id}`).toBe(404);
    }
    for (const id of [otherEvent, randomUUID(), "not-a-uuid"]) {
      expect((await getDetail(id)).status, id).toBe(404);
    }
  });

  it("shows a delivery's payload and who replayed it", async () => {
    state.user = member;
    const newest = await getDetail(acmeEvents[0]!.id);
    expect(newest.status).toBe(200);
    expect(deliveryDetailSchema.parse(newest.body)).toEqual(newest.body);
    expect(newest.body).toMatchObject({
      id: acmeEvents[0]!.id,
      payload: { action: "opened", n: 4 },
      replayedBy: null,
      organization: { id: acme },
    });
    const truncated = await getDetail(truncatedEvent);
    expect(truncated.body).toMatchObject({
      payload: null,
      payloadTruncated: true,
      replayedBy: { id: member.id, name: "Mia Member" },
    });
  });

  it("requires a signed-in user", async () => {
    state.user = null;
    expect((await getList("scm", acmeConnection)).status).toBe(401);
    expect((await getDetail(acmeEvents[0]!.id)).status).toBe(401);
  });
});
