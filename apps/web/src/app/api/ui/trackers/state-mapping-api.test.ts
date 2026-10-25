import { randomBytes, randomUUID } from "node:crypto";
import {
  closeDb,
  createDb,
  DEFAULT_TRACKER_STATE_MAPPING,
  getIntegrationById,
  organizationMembers,
  organizations,
  saveIntegration,
  users,
  type Database,
  type TrackerStateMapping,
} from "@omniralph/db";
import { captureChanges } from "@omniralph/db/changes";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { trackerStateMappingSchema, type TrackerStateMappingView } from "@/lib/api/trackers";
import { assertRole, type Role } from "@/lib/auth/roles";
import type * as LinearClient from "@/lib/linear/client";
import { FakeLinearGateway } from "@/lib/linear/fake-gateway";

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
vi.mock("@/lib/linear/client", async (importOriginal) => {
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

const route = await import("./[integrationId]/state-mapping/route");

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
  body: TrackerStateMappingView & { error?: string; fieldErrors?: Record<string, string> };
}> {
  const request = new Request(`http://localhost/api/ui/trackers/${integrationId}/state-mapping`, {
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

describe.skipIf(!databaseAvailable)("tracker state mapping endpoints", () => {
  let testDb: TestDatabase;
  let db: Database;
  let acme: string;
  let beta: string;
  let acmeIntegration: string;
  let betaIntegration: string;
  let other: string;
  const workspace = new FakeLinearGateway();
  workspace.teams = [
    { id: "team-a", key: "ENG", name: "Engineering" },
    { id: "team-b", key: "OPS", name: "Operations" },
  ];
  workspace.workflowStatesByTeam.set(
    "team-b",
    [
      ["Inbox", "triage"],
      ["Icebox", "backlog"],
      ["Ready", "unstarted"],
      ["Doing", "started"],
      ["Shipped", "completed"],
      ["Dropped", "canceled"],
    ].map(([name, type], position) => ({
      id: `b-${position}`,
      name: name!,
      type: type!,
      position,
    })),
  );

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
    state.orgId = acme;
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
      { organizationId: otherOrg!.id, userId: outsider.id, role: "admin" },
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

  const override: TrackerStateMapping = {
    ready: { types: ["unstarted"] },
    needsRefining: { types: ["triage", "backlog"] },
    teams: { "team-b": { ready: ["b-2", "b-3"], needsRefining: ["b-1"] } },
  };

  it("returns the mapping with each team's workflow states to any member", async () => {
    const { status, body } = await call("GET", acmeIntegration);
    expect(status).toBe(200);
    expect(trackerStateMappingSchema.parse(body)).toEqual(body);
    expect(body).toMatchObject({
      integrationId: acmeIntegration,
      tracker: "linear",
      organization: { id: acme, name: "Acme", role: "member" },
      mapping: DEFAULT_TRACKER_STATE_MAPPING,
      stateTypes: ["triage", "backlog", "unstarted", "started"],
    });
    expect(body.teams.map((t) => t.key)).toEqual(["ENG", "OPS"]);
    expect(body.teams[1]!.states).toEqual([
      { id: "b-0", name: "Inbox", type: "triage", category: "triage" },
      { id: "b-1", name: "Icebox", type: "backlog", category: "backlog" },
      { id: "b-2", name: "Ready", type: "unstarted", category: "todo" },
      { id: "b-3", name: "Doing", type: "started", category: "in_progress" },
      { id: "b-4", name: "Shipped", type: "completed", category: "done" },
      { id: "b-5", name: "Dropped", type: "canceled", category: "canceled" },
    ]);
  });

  it("refuses PUT to a member", async () => {
    const { status } = await call("PUT", acmeIntegration, override);
    expect(status).toBe(403);
    expect((await getIntegrationById(db, acmeIntegration))!.stateMapping).toEqual(
      DEFAULT_TRACKER_STATE_MAPPING,
    );
  });

  it("saves the mapping for an admin and records a connection change", async () => {
    state.user = admin;
    const { result, changes } = await captureChanges(() => call("PUT", acmeIntegration, override));
    expect(result.status).toBe(200);
    expect(result.body.mapping).toEqual(override);
    expect((await getIntegrationById(db, acmeIntegration))!.stateMapping).toEqual(override);
    expect(changes).toEqual([
      expect.objectContaining({
        resource: "connection",
        ids: [acmeIntegration],
        organizationId: acme,
      }),
    ]);
    // Members read the saved mapping.
    state.user = member;
    expect((await call("GET", acmeIntegration)).body.mapping).toEqual(override);
  });

  it("answers 400 with field errors for an invalid mapping", async () => {
    state.user = admin;
    const unknownState = await call("PUT", acmeIntegration, {
      ...override,
      teams: { "team-b": { ready: ["state-unstarted"], needsRefining: ["b-1"] } },
    });
    expect(unknownState.status).toBe(400);
    expect(unknownState.body.fieldErrors).toEqual({
      "teams.team-b.ready": "This state isn't in the team's workflow.",
    });
    const both = await call("PUT", acmeIntegration, {
      ...override,
      ready: { types: ["backlog"] },
    });
    expect(both.status).toBe(400);
    expect(both.body.fieldErrors).toHaveProperty("needsRefining.types");
    const empty = await call("PUT", acmeIntegration, { ...override, ready: { types: [] } });
    expect(empty.body.fieldErrors).toHaveProperty("ready.types");
    const badType = await call("PUT", acmeIntegration, {
      ...override,
      ready: { types: ["completed"] },
    });
    expect(badType.body.fieldErrors).toHaveProperty("ready.types");
    const malformed = await call("PUT", acmeIntegration, { ready: { types: ["unstarted"] } });
    expect(malformed.status).toBe(400);
  });

  it("serves an integration of another of the user's organizations, by role there", async () => {
    // The member is an admin of Beta, though Acme is active.
    const read = await call("GET", betaIntegration);
    expect(read.status).toBe(200);
    expect(read.body.organization).toEqual({ id: beta, name: "Beta", role: "admin" });
    const { result, changes } = await captureChanges(() => call("PUT", betaIntegration, override));
    expect(result.status).toBe(200);
    expect(changes).toEqual([
      expect.objectContaining({ resource: "connection", organizationId: beta }),
    ]);
  });

  it("is not found for a non-member, an unknown ID or a malformed ID", async () => {
    state.user = outsider;
    state.orgId = other;
    expect((await call("GET", acmeIntegration)).status).toBe(404);
    expect((await call("PUT", acmeIntegration, override)).status).toBe(404);
    state.user = admin;
    expect((await call("GET", randomUUID())).status).toBe(404);
    expect((await call("GET", "not-a-uuid")).status).toBe(404);
    expect((await call("PUT", randomUUID(), override)).status).toBe(404);
  });
});
