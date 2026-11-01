import { randomBytes, randomUUID } from "node:crypto";
import {
  closeDb,
  createDb,
  getIntegrationById,
  listSettingsChanges,
  organizationMembers,
  organizations,
  saveIntegration,
  users,
  type Database,
} from "@omniralph/db";
import { captureChanges } from "@omniralph/db/changes";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { trackerFixLabelsSchema, type TrackerFixLabelsView } from "@/lib/api/trackers";
import { assertRole, type Role } from "@/lib/auth/roles";
import type * as LinearClient from "@/lib/tracker/linear/client";
import { FakeLinearGateway } from "@omniralph/tracker/linear/testing";

vi.mock("server-only", () => ({}));

type TestUser = { id: string; role: Role; name: string | null; email: string | null; image: null };
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  user: null as TestUser | null,
  orgId: "",
  linear: new Map<string, unknown>(),
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") =>
    assertRole(
      state.user && { ...state.user, organization: { id: state.orgId, name: "Acme" } },
      role,
    ),
}));
vi.mock("@/lib/tracker/linear/client", async (importOriginal) => {
  const actual = await importOriginal<typeof LinearClient>();
  return {
    ...actual,
    getLinearGateway: async (options: { organizationId: string }) => {
      const gateway = state.linear.get(options.organizationId);
      if (!gateway) throw new actual.LinearNotConnectedError();
      return gateway;
    },
  };
});

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const route = await import("./[integrationId]/fix-labels/route");

const databaseAvailable = testDatabaseAvailable();

const user = (id: string, role: Role): TestUser => ({
  id,
  role,
  name: id,
  email: null,
  image: null,
});
const member = user("member-1", "member");
const admin = user("admin-1", "admin");
const outsider = user("outsider-1", "admin");

async function call(
  method: "GET" | "PUT",
  integrationId: string,
  body?: unknown,
): Promise<{
  status: number;
  body: TrackerFixLabelsView & { error?: string; fieldErrors?: Record<string, string> };
}> {
  const request = new Request(`http://localhost/api/ui/trackers/${integrationId}/fix-labels`, {
    method,
    ...(body !== undefined && {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  });
  const handler = method === "GET" ? route.GET : route.PUT;
  const response = await handler(request, { params: Promise.resolve({ integrationId }) });
  return { status: response.status, body: await response.json() };
}

describe.skipIf(!databaseAvailable)("tracker fix labels endpoints", () => {
  let testDb: TestDatabase;
  let db: Database;
  let acme: string;
  let beta: string;
  let acmeIntegration: string;
  let betaIntegration: string;
  let other: string;
  const workspace = new FakeLinearGateway();

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
    other = otherOrg!.id;
    await db
      .insert(users)
      .values(
        [member, admin, outsider].map((u) => ({ id: u.id, name: u.name, email: `${u.id}@x.io` })),
      );
    await db.insert(organizationMembers).values([
      { organizationId: acme, userId: member.id, role: "member" },
      { organizationId: acme, userId: admin.id, role: "admin" },
      // Admin of Beta while Acme is active.
      { organizationId: beta, userId: member.id, role: "admin" },
      { organizationId: other, userId: outsider.id, role: "admin" },
    ]);
    const connect = async (organizationId: string, externalId: string) => {
      const saved = await saveIntegration(db, {
        organizationId,
        provider: "linear",
        externalId,
        name: externalId,
        credentials: { accessToken: "t" },
        installedByUserId: null,
      });
      if (saved === "other_organization") throw new Error("taken");
      state.linear.set(organizationId, workspace);
      return saved.id;
    };
    acmeIntegration = await connect(acme, "acme-ws");
    betaIntegration = await connect(beta, "beta-ws");
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(() => {
    state.user = member;
    state.orgId = acme;
  });

  const saved = async () => (await getIntegrationById(db, acmeIntegration))!.fixLabels;

  it("returns the default, Bug, to any member", async () => {
    const { status, body } = await call("GET", acmeIntegration);
    expect(status).toBe(200);
    expect(trackerFixLabelsSchema.parse(body)).toEqual(body);
    expect(body).toEqual({
      integrationId: acmeIntegration,
      organization: { id: acme, name: "Acme", role: "member" },
      fixLabels: ["Bug"],
    });
  });

  it("refuses PUT to a member", async () => {
    const { status } = await call("PUT", acmeIntegration, { fixLabels: ["Defect"] });
    expect(status).toBe(403);
    expect(await saved()).toEqual(["Bug"]);
  });

  it("saves trimmed labels without duplicates for an admin and records the change", async () => {
    state.user = admin;
    const { result, changes } = await captureChanges(() =>
      call("PUT", acmeIntegration, { fixLabels: [" Defect ", "Regression", "defect"] }),
    );
    expect(result.status).toBe(200);
    expect(result.body.fixLabels).toEqual(["Defect", "Regression"]);
    expect(await saved()).toEqual(["Defect", "Regression"]);
    expect(changes).toEqual([
      expect.objectContaining({
        resource: "connection",
        ids: [acmeIntegration],
        organizationId: acme,
      }),
      expect.objectContaining({
        resource: "settings",
        section: "connection",
        subjectId: acmeIntegration,
        organizationId: acme,
      }),
    ]);
    const history = () =>
      listSettingsChanges(db, {
        organizationIds: [acme],
        section: "connection",
        subjectId: acmeIntegration,
      });
    expect((await history()).entries).toEqual([
      expect.objectContaining({
        actor: { userId: admin.id, name: admin.name },
        changes: [
          {
            field: "fixLabels",
            label: "Fix labels",
            before: ["Bug"],
            after: ["Defect", "Regression"],
          },
        ],
      }),
    ]);
    // Saving the same labels again records nothing.
    expect(
      (await call("PUT", acmeIntegration, { fixLabels: ["Defect", "Regression"] })).status,
    ).toBe(200);
    expect((await history()).entries).toHaveLength(1);
    // Members read the saved labels.
    state.user = member;
    expect((await call("GET", acmeIntegration)).body.fixLabels).toEqual(["Defect", "Regression"]);
  });

  it("answers 400 for a blank label, an empty list or a malformed body", async () => {
    state.user = admin;
    const before = await saved();
    const blank = await call("PUT", acmeIntegration, { fixLabels: ["Bug", "  "] });
    expect(blank.status).toBe(400);
    expect(blank.body.fieldErrors).toEqual({ "fixLabels.1": "A fix label can't be blank." });
    const empty = await call("PUT", acmeIntegration, { fixLabels: [] });
    expect(empty.status).toBe(400);
    expect(empty.body.fieldErrors).toEqual({ fixLabels: "Add at least one fix label." });
    expect((await call("PUT", acmeIntegration, {})).status).toBe(400);
    expect((await call("PUT", acmeIntegration, { fixLabels: "Bug" })).status).toBe(400);
    expect(await saved()).toEqual(before);
  });

  it("serves an integration of another of the user's organizations, by role there", async () => {
    // The member is an admin of Beta, though Acme is active.
    const read = await call("GET", betaIntegration);
    expect(read.status).toBe(200);
    expect(read.body.organization).toEqual({ id: beta, name: "Beta", role: "admin" });
    const written = await call("PUT", betaIntegration, { fixLabels: ["Incident"] });
    expect(written.status).toBe(200);
    expect((await getIntegrationById(db, betaIntegration))!.fixLabels).toEqual(["Incident"]);
  });

  it("is not found for a non-member, an unknown ID or a malformed ID", async () => {
    state.user = outsider;
    state.orgId = other;
    expect((await call("GET", acmeIntegration)).status).toBe(404);
    expect((await call("PUT", acmeIntegration, { fixLabels: ["Bug"] })).status).toBe(404);
    state.user = admin;
    state.orgId = acme;
    expect((await call("GET", randomUUID())).status).toBe(404);
    expect((await call("GET", "not-a-uuid")).status).toBe(404);
    expect((await call("PUT", randomUUID(), { fixLabels: ["Bug"] })).status).toBe(404);
  });
});
