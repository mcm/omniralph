import {
  closeDb,
  createDb,
  DEFAULT_TRACKER_LABELS,
  getTrackerLabels,
  listSettingsChanges,
  organizationMembers,
  organizations,
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
import { trackerLabelsSchema, type TrackerLabelsView } from "@/lib/api/trackers";
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

const route = await import("./labels/route");

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

async function call(
  method: "GET" | "PUT",
  body?: unknown,
): Promise<{
  status: number;
  body: TrackerLabelsView & { error?: string; fieldErrors?: Record<string, string> };
}> {
  const request = new Request("http://localhost/api/ui/trackers/labels", {
    method,
    ...(body !== undefined && {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  });
  const handler = method === "GET" ? route.GET : route.PUT;
  const response = await handler(request, { params: Promise.resolve({}) });
  return { status: response.status, body: await response.json() };
}

describe.skipIf(!databaseAvailable)("tracker labels endpoints", () => {
  let testDb: TestDatabase;
  let db: Database;
  let acme: string;
  let beta: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    const [acmeOrg, betaOrg] = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Beta" }])
      .returning();
    acme = acmeOrg!.id;
    beta = betaOrg!.id;
    await db
      .insert(users)
      .values([member, admin].map((u) => ({ id: u.id, name: u.name, email: `${u.id}@x.io` })));
    await db.insert(organizationMembers).values([
      { organizationId: acme, userId: member.id, role: "member" },
      { organizationId: acme, userId: admin.id, role: "admin" },
      { organizationId: beta, userId: admin.id, role: "admin" },
    ]);
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(() => {
    state.user = member;
    state.orgId = acme;
  });

  const saved = { manualLabels: ["by hand", "manual"], blockedLabels: ["on hold"] };

  it("answers the defaults to any member when none are saved", async () => {
    const { status, body } = await call("GET");
    expect(status).toBe(200);
    expect(trackerLabelsSchema.parse(body)).toEqual(body);
    expect(body).toEqual({ manualLabels: ["manual"], blockedLabels: ["under-review", "blocked"] });
    expect(body).toEqual(DEFAULT_TRACKER_LABELS);
  });

  it("refuses PUT to a member", async () => {
    const { status } = await call("PUT", saved);
    expect(status).toBe(403);
    expect(await getTrackerLabels(db, acme)).toEqual(DEFAULT_TRACKER_LABELS);
  });

  it.each([
    ["a blank label", { manualLabels: ["manual", "  "], blockedLabels: [] }],
    ["an empty manual list", { manualLabels: [], blockedLabels: ["blocked"] }],
    ["a label that isn't a string", { manualLabels: ["manual"], blockedLabels: [3] }],
    ["a list that isn't a list", { manualLabels: "manual", blockedLabels: [] }],
    ["a missing list", { manualLabels: ["manual"] }],
    ["an unknown field", { ...{ manualLabels: ["manual"], blockedLabels: [] }, other: [] }],
  ])("answers 400 to %s and saves nothing", async (_case, body) => {
    state.user = admin;
    const { result, changes } = await captureChanges(() => call("PUT", body));
    expect(result.status).toBe(400);
    expect(result.body.error).toEqual(expect.any(String));
    expect(changes).toEqual([]);
    expect(await getTrackerLabels(db, acme)).toEqual(DEFAULT_TRACKER_LABELS);
  });

  it("saves trimmed labels for an admin, records them and publishes a settings change", async () => {
    state.user = admin;
    const { result, changes } = await captureChanges(() =>
      call("PUT", { manualLabels: [" by hand ", "manual"], blockedLabels: ["on hold  "] }),
    );
    expect(result.status).toBe(200);
    expect(result.body).toEqual(saved);
    expect(await getTrackerLabels(db, acme)).toEqual(saved);
    expect(changes).toEqual([
      expect.objectContaining({
        resource: "settings",
        section: "routing_rules",
        ids: [acme],
        organizationId: acme,
      }),
    ]);
    const { entries } = await listSettingsChanges(db, {
      organizationIds: [acme],
      section: "routing_rules",
    });
    expect(entries).toEqual([
      expect.objectContaining({
        actor: { userId: admin.id, name: admin.name },
        changes: [
          {
            field: "manualLabels",
            label: "Manual labels",
            before: ["manual"],
            after: ["by hand", "manual"],
          },
          {
            field: "blockedLabels",
            label: "Blocked labels",
            before: ["under-review", "blocked"],
            after: ["on hold"],
          },
        ],
      }),
    ]);

    // Members read what was saved; the other organization keeps its defaults.
    state.user = member;
    expect((await call("GET")).body).toEqual(saved);
    expect(await getTrackerLabels(db, beta)).toEqual(DEFAULT_TRACKER_LABELS);
  });

  it("saves an empty blocked list, and a save that changes nothing publishes nothing", async () => {
    state.user = admin;
    const none = { manualLabels: ["manual"], blockedLabels: [] };
    expect((await call("PUT", none)).body).toEqual(none);
    const { result, changes } = await captureChanges(() => call("PUT", none));
    expect(result.status).toBe(200);
    expect(changes).toEqual([]);
    expect(await getTrackerLabels(db, acme)).toEqual(none);
  });
});
