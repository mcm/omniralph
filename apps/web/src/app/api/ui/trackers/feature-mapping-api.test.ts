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
import {
  NO_PARENT_ISSUES,
  trackerFeatureMappingSchema,
  type TrackerFeatureMappingView,
} from "@/lib/api/trackers";
import { assertRole, type Role } from "@/lib/auth/roles";
import type * as Adapters from "@/lib/tracker/adapters";
import type * as LinearClient from "@/lib/tracker/linear/client";
import { FakeLinearGateway } from "@omniralph/tracker/linear/testing";

vi.mock("server-only", () => ({}));

type TestUser = { id: string; role: Role; name: string | null; email: string | null; image: null };
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  user: null as TestUser | null,
  orgId: "",
  linear: new Map<string, unknown>(),
  /** Whether the tracker's gateways can hold parent issues (Linear's can). */
  parentIssues: true,
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

vi.mock("@/lib/tracker/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof Adapters>();
  return {
    ...actual,
    trackerProviderCapabilities: (
      provider: Parameters<typeof actual.trackerProviderCapabilities>[0],
    ) =>
      actual
        .trackerProviderCapabilities(provider)
        .filter((capability) => state.parentIssues || capability !== "parentIssues"),
  };
});

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const route = await import("./[integrationId]/feature-mapping/route");

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
  body: TrackerFeatureMappingView & { error?: string; fieldErrors?: Record<string, string> };
}> {
  const request = new Request(`http://localhost/api/ui/trackers/${integrationId}/feature-mapping`, {
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

describe.skipIf(!databaseAvailable)("tracker feature mapping endpoints", () => {
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
    state.parentIssues = true;
    state.user = member;
    state.orgId = acme;
  });

  const saved = async () => (await getIntegrationById(db, acmeIntegration))!.featureMapping;
  const history = () =>
    listSettingsChanges(db, {
      organizationIds: [acme],
      section: "connection",
      subjectId: acmeIntegration,
    });

  it("returns the default, Omniralph only, to any member, with the tracker's parent issues", async () => {
    const { status, body } = await call("GET", acmeIntegration);
    expect(status).toBe(200);
    expect(trackerFeatureMappingSchema.parse(body)).toEqual(body);
    expect(body).toEqual({
      integrationId: acmeIntegration,
      organization: { id: acme, name: "Acme", role: "member" },
      featureMapping: "omniralph",
      parentIssues: true,
    });
  });

  it("refuses PUT to a member", async () => {
    const { status } = await call("PUT", acmeIntegration, { featureMapping: "parent-issue" });
    expect(status).toBe(403);
    expect(await saved()).toBe("omniralph");
  });

  it("saves the mapping for an admin and records it in the settings history", async () => {
    state.user = admin;
    const { result, changes } = await captureChanges(() =>
      call("PUT", acmeIntegration, { featureMapping: "parent-issue" }),
    );
    expect(result.status).toBe(200);
    expect(result.body.featureMapping).toBe("parent-issue");
    expect(await saved()).toBe("parent-issue");
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
    expect((await history()).entries).toEqual([
      expect.objectContaining({
        actor: { userId: admin.id, name: admin.name },
        changes: [
          {
            field: "featureMapping",
            label: "Features",
            before: "Omniralph only",
            after: "Parent issue in the tracker",
          },
        ],
      }),
    ]);
    // Saving the same mapping again records nothing.
    expect((await call("PUT", acmeIntegration, { featureMapping: "parent-issue" })).status).toBe(
      200,
    );
    expect((await history()).entries).toHaveLength(1);
    // Members read the saved mapping; switching back is recorded too.
    state.user = member;
    expect((await call("GET", acmeIntegration)).body.featureMapping).toBe("parent-issue");
    state.user = admin;
    expect((await call("PUT", acmeIntegration, { featureMapping: "omniralph" })).status).toBe(200);
    expect(await saved()).toBe("omniralph");
    expect((await history()).entries).toHaveLength(2);
  });

  it("answers 400 for an unknown mapping or a malformed body", async () => {
    state.user = admin;
    const before = await saved();
    const unknown = await call("PUT", acmeIntegration, { featureMapping: "initiative" });
    expect(unknown.status).toBe(400);
    expect(unknown.body.fieldErrors).toEqual({
      featureMapping: "Choose Omniralph only or a parent issue in the tracker.",
    });
    expect((await call("PUT", acmeIntegration, {})).status).toBe(400);
    expect(
      (await call("PUT", acmeIntegration, { featureMapping: "omniralph", extra: true })).status,
    ).toBe(400);
    expect(await saved()).toBe(before);
  });

  it("refuses a parent issue, with 400, for a tracker that can't hold parent issues", async () => {
    state.parentIssues = false;
    state.user = admin;
    expect((await call("GET", acmeIntegration)).body.parentIssues).toBe(false);
    const entries = (await history()).entries.length;
    const refused = await call("PUT", acmeIntegration, { featureMapping: "parent-issue" });
    expect(refused.status).toBe(400);
    expect(refused.body.fieldErrors).toEqual({ featureMapping: NO_PARENT_ISSUES });
    expect(await saved()).toBe("omniralph");
    expect((await history()).entries).toHaveLength(entries);
    // Omniralph only can still be saved.
    expect((await call("PUT", acmeIntegration, { featureMapping: "omniralph" })).status).toBe(200);
  });

  it("serves an integration of another of the user's organizations, by role there", async () => {
    // The member is an admin of Beta, though Acme is active.
    const read = await call("GET", betaIntegration);
    expect(read.status).toBe(200);
    expect(read.body.organization).toEqual({ id: beta, name: "Beta", role: "admin" });
    const written = await call("PUT", betaIntegration, { featureMapping: "parent-issue" });
    expect(written.status).toBe(200);
    expect((await getIntegrationById(db, betaIntegration))!.featureMapping).toBe("parent-issue");
  });

  it("is not found for a non-member, an unknown ID or a malformed ID", async () => {
    state.user = outsider;
    state.orgId = other;
    expect((await call("GET", acmeIntegration)).status).toBe(404);
    expect((await call("PUT", acmeIntegration, { featureMapping: "omniralph" })).status).toBe(404);
    state.user = admin;
    state.orgId = acme;
    expect((await call("GET", randomUUID())).status).toBe(404);
    expect((await call("GET", "not-a-uuid")).status).toBe(404);
    expect((await call("PUT", randomUUID(), { featureMapping: "omniralph" })).status).toBe(404);
  });
});
