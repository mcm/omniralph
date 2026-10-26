import { createHash, randomBytes } from "node:crypto";
import {
  addMember,
  closeDb,
  createDb,
  createOrganization,
  listWorkItemEvents,
  saveIntegration,
  users,
  workItemShareLinks,
  workItemUrlId,
  type Database,
} from "@omniralph/db";
import { captureChanges } from "@omniralph/db/changes";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createShareLinkResultSchema, shareLinkListSchema } from "@/lib/api/work-items";
import { assertRole, type Role } from "@/lib/auth/roles";
import type * as LinearClient from "@/lib/linear/client";
import { FakeLinearGateway } from "@/lib/linear/fake-gateway";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: "share-member",
  orgId: "",
  linear: new Map<string, FakeLinearGateway>(),
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") =>
    assertRole(
      {
        id: state.userId,
        role: "member",
        name: "Steve McMaster",
        email: null,
        image: null,
        organization: { id: state.orgId, name: "Acme" },
      },
      role,
    ),
}));
vi.mock("@/lib/linear/client", async (importOriginal) => {
  const actual = await importOriginal<typeof LinearClient>();
  return {
    ...actual,
    getLinearGateway: async (options: LinearClient.LinearGatewayOptions) => {
      const gateway = state.linear.get(options.organizationId);
      if (!gateway) throw new actual.LinearNotConnectedError();
      return gateway;
    },
  };
});

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.APP_URL = "https://omniralph.example.com/";

const linksRoute = await import("./[id]/share-links/route");
const revokeRoute = await import("../share-links/[linkId]/route");
const backlogRoute = await import("../backlog/route");
const { hasCachedBacklog, resetBacklogCache } = await import("@/lib/work-items/backlog-cache");

async function call<T = Record<string, unknown>>(
  handler: (request: Request, route: { params: Promise<never> }) => Promise<Response>,
  params: Record<string, string>,
  options: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const response = await handler(
    new Request("http://localhost/api/ui/share", {
      method: options.method ?? "GET",
      ...(options.body !== undefined && {
        body: JSON.stringify(options.body),
        headers: { "content-type": "application/json" },
      }),
    }),
    { params: Promise.resolve(params as never) },
  );
  return { status: response.status, body: (await response.json()) as T };
}

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("review link endpoints", () => {
  let testDb: TestDatabase;
  let db: Database;
  let acme: FakeLinearGateway;

  const list = async (id: string) => {
    const response = await call(linksRoute.GET, { id });
    expect(response.status).toBe(200);
    return shareLinkListSchema.parse(response.body).links;
  };
  const create = (id: string, password?: string) =>
    call(
      linksRoute.POST,
      { id },
      { method: "POST", body: password === undefined ? {} : { password } },
    );
  const revoke = (linkId: string) => call(revokeRoute.DELETE, { linkId }, { method: "DELETE" });
  const key = (externalId: string) => ({
    organizationId: state.orgId,
    tracker: "linear" as const,
    externalId,
  });

  /** Runs `action`, expecting one `work_item` change of the item and its Backlog cache dropped. */
  async function expectOneChange<T>(externalId: string, action: () => Promise<T>) {
    expect(
      (
        await backlogRoute.GET(new Request("http://localhost/api/ui/backlog"), {
          params: Promise.resolve({}),
        })
      ).status,
    ).toBe(200);
    expect(hasCachedBacklog(state.orgId)).toBe(true);
    const { result, changes } = await captureChanges(action);
    expect(changes.filter((change) => change.resource === "work_item")).toEqual([
      expect.objectContaining({
        organizationId: state.orgId,
        ids: [workItemUrlId("linear", externalId)],
      }),
    ]);
    expect(hasCachedBacklog(state.orgId)).toBe(false);
    return result;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    await db
      .insert(users)
      .values([{ id: "share-owner" }, { id: state.userId, name: "Steve McMaster" }]);
    const org = await createOrganization(db, { name: "Acme", createdBy: "share-owner" });
    state.orgId = org.id;
    expect(
      await addMember(db, { organizationId: org.id, userId: state.userId, role: "member" }),
    ).toBe("added");
    acme = new FakeLinearGateway();
    state.linear.set(org.id, acme);
    const integration = await saveIntegration(db, {
      organizationId: org.id,
      provider: "linear",
      externalId: "acme-share-workspace",
      name: "Acme",
      credentials: { accessToken: "t" },
      installedByUserId: null,
    });
    if (integration === "other_organization") throw new Error("setup");
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(() => resetBacklogCache());

  it("creates a link: a URL with a 43-character base64url token, stored only as its SHA-256", async () => {
    const issue = acme.add({ id: "share-create", title: "Share me" });
    const id = workItemUrlId("linear", issue.id);
    const response = await expectOneChange(issue.id, () => create(id));
    expect(response.status).toBe(201);
    const { link, url } = createShareLinkResultSchema.parse(response.body);
    const match = /^https:\/\/omniralph\.example\.com\/share\/([A-Za-z0-9_-]+)$/.exec(url);
    expect(match?.[1]).toHaveLength(43);
    const token = match![1]!;
    expect(link).toMatchObject({ protected: false, createdBy: { name: "Steve McMaster" } });
    expect(new Date(link.expiresAt).getTime() - new Date(link.createdAt).getTime()).toBeCloseTo(
      30 * 24 * 60 * 60 * 1000,
      -4,
    );

    const [row] = await db
      .select()
      .from(workItemShareLinks)
      .where(eq(workItemShareLinks.id, link.id));
    expect(row).toMatchObject({
      organizationId: state.orgId,
      tracker: "linear",
      externalId: issue.id,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      passwordHash: null,
      createdBy: state.userId,
      revokedAt: null,
    });
    expect(JSON.stringify(row)).not.toContain(token);
    expect(await listWorkItemEvents(db, key(issue.id))).toEqual([
      expect.objectContaining({
        kind: "share_link_created",
        actorUserId: state.userId,
        actorName: "Steve McMaster",
        detail: { linkId: link.id, protected: false },
      }),
    ]);
  });

  it("stores a password as scrypt and marks the link protected", async () => {
    const issue = acme.add({ id: "share-password", title: "Protected" });
    const response = await create(workItemUrlId("linear", issue.id), "open sesame");
    expect(response.status).toBe(201);
    const { link } = createShareLinkResultSchema.parse(response.body);
    expect(link.protected).toBe(true);
    const [row] = await db
      .select()
      .from(workItemShareLinks)
      .where(eq(workItemShareLinks.id, link.id));
    expect(row!.passwordHash).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(row!.passwordHash).not.toContain("open sesame");
  });

  it("lists active links without tokens, and revokes", async () => {
    const issue = acme.add({ id: "share-list", title: "Listed" });
    const id = workItemUrlId("linear", issue.id);
    const first = createShareLinkResultSchema.parse((await create(id)).body);
    const second = createShareLinkResultSchema.parse((await create(id, "pw")).body);
    // Another item's links aren't listed.
    await create(workItemUrlId("linear", acme.add({ id: "share-other", title: "Other" }).id));

    const raw = await call(linksRoute.GET, { id });
    expect(Object.keys((raw.body.links as object[])[0]!).sort()).toEqual(
      ["createdAt", "createdBy", "expiresAt", "id", "protected"].sort(),
    );
    for (const { url } of [first, second]) {
      expect(JSON.stringify(raw.body)).not.toContain(url.split("/share/")[1]);
    }
    expect((await list(id)).map((link) => [link.id, link.protected])).toEqual([
      [first.link.id, false],
      [second.link.id, true],
    ]);

    const revoked = await expectOneChange(issue.id, () => revoke(first.link.id));
    expect(revoked).toEqual({ status: 200, body: { ok: true } });
    const [row] = await db
      .select()
      .from(workItemShareLinks)
      .where(eq(workItemShareLinks.id, first.link.id));
    expect(row!.revokedAt).toBeInstanceOf(Date);
    expect((await list(id)).map((link) => link.id)).toEqual([second.link.id]);
    expect((await listWorkItemEvents(db, key(issue.id))).map((event) => event.kind)).toEqual([
      "share_link_revoked",
      "share_link_created",
      "share_link_created",
    ]);
    expect((await listWorkItemEvents(db, key(issue.id)))[0]).toMatchObject({
      actorName: "Steve McMaster",
      detail: { linkId: first.link.id },
    });

    // Revoking again changes nothing; an unknown link is not found.
    expect(await revoke(first.link.id)).toEqual({ status: 200, body: { ok: true } });
    expect(await listWorkItemEvents(db, key(issue.id))).toHaveLength(3);
    expect((await revoke("8a4f0b9e-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await revoke("not-a-uuid")).status).toBe(404);
  });

  it("answers 400 for an 11th active link, and counts revoked and expired ones out", async () => {
    const issue = acme.add({ id: "share-cap", title: "Popular" });
    const id = workItemUrlId("linear", issue.id);
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const response = await create(id);
      expect(response.status).toBe(201);
      ids.push(createShareLinkResultSchema.parse(response.body).link.id);
    }
    const eleventh = await create(id);
    expect(eleventh).toMatchObject({
      status: 400,
      body: {
        error: "This work item already has 10 active review links. Revoke one first.",
        code: "share_link_limit",
      },
    });
    expect(await list(id)).toHaveLength(10);

    await revoke(ids[0]!);
    expect((await create(id)).status).toBe(201);
    await db
      .update(workItemShareLinks)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(workItemShareLinks.id, ids[1]!));
    expect((await create(id)).status).toBe(201);
    expect((await create(id)).status).toBe(400);
  });

  it("answers 404 for an unknown work item and a too long password", async () => {
    expect((await create(workItemUrlId("linear", "missing"))).status).toBe(404);
    expect((await call(linksRoute.GET, { id: "not-an-id" })).status).toBe(404);
    const issue = acme.add({ id: "share-long", title: "Long" });
    expect((await create(workItemUrlId("linear", issue.id), "x".repeat(201))).status).toBe(400);
  });
});
