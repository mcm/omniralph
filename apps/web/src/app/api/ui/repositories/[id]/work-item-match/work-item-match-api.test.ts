import { randomBytes, randomUUID } from "node:crypto";
import {
  closeDb,
  connectRepository,
  createDb,
  disconnectRepository,
  integrations,
  organizations,
  saveIntegration,
  upsertScmConnection,
  users,
  workItemMatches,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedWorkItemMatch } from "@/lib/api/work-item-matches";
import { assertRole, type Role } from "@/lib/auth/roles";
import { TRACKER_NOT_CONNECTED } from "@/lib/repositories/work-item-match";
import { labelsInclude, setRoutingRules, teamIs } from "@/lib/routing/testing";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const state = vi.hoisted(() => ({
  orgId: "",
  db: undefined as unknown as Database,
  user: null as { id: string; role: Role } | null,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") =>
    assertRole(
      state.user && {
        ...state.user,
        name: null,
        email: null,
        image: null,
        theme: null,
        showAdvanced: false,
        organization: { id: state.orgId, name: "Acme" },
      },
      role,
    ),
}));
vi.mock("@/lib/linear/settings-options", () => ({ getLinearSettingsOptions: async () => null }));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const workItemMatch = await import("@/app/api/ui/repositories/[id]/work-item-match/route");
const repositoryDetail = await import("@/app/api/ui/repositories/[id]/route");

type Handler = (request: Request, route: { params: Promise<{ id: string }> }) => Promise<Response>;

async function call(handler: Handler, method: "GET" | "PUT", id: string, body?: unknown) {
  const response = await handler(
    new Request("http://localhost/api/ui", {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const put = (id: string, body: unknown) => call(workItemMatch.PUT, "PUT", id, body);
const detail = async (id: string) => (await call(repositoryDetail.GET, "GET", id)).body;

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("PUT /api/ui/repositories/{id}/work-item-match", () => {
  let testDb: TestDatabase;
  let db: Database;
  let api: string;
  let web: string;
  let docs: string;
  let adminId: string;

  const connectLinear = () =>
    saveIntegration(db, {
      organizationId: state.orgId,
      provider: "linear",
      externalId: "org-1",
      name: "Acme",
      credentials: { accessToken: "t" },
      installedByUserId: null,
    });

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    state.orgId = org!.id;
    const [admin] = await db
      .insert(users)
      .values({ id: randomUUID(), email: "admin@acme.test" })
      .returning();
    adminId = admin!.id;
    const connection = (await upsertScmConnection(
      db,
      {
        organizationId: org!.id,
        provider: "github",
        name: "acme",
        baseUrl: "https://api.github.com",
        externalId: "1",
        credentials: {},
      },
      randomBytes(32),
    ))!;
    const repo = async (externalId: string, fullPath: string) =>
      (
        await connectRepository(db, {
          connectionId: connection.id,
          provider: "github",
          externalId,
          fullPath,
        })
      ).id;
    api = await repo("1", "acme/api");
    web = await repo("2", "acme/web");
    docs = await repo("3", "acme/docs");
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    state.user = { id: adminId, role: "admin" };
    await db.delete(workItemMatches);
    await db.delete(integrations);
    await setRoutingRules(db, state.orgId);
    await connectLinear();
  });

  it("saves a match, shows it on the repo and clears it", async () => {
    expect(await detail(api)).toMatchObject({ workItemMatch: null, routingRules: [] });

    const saved = await put(api, {
      match: {
        tracker: "linear",
        team: " SOC ",
        project: null,
        labels: ["product:portal", "Product:Portal"],
      },
    });
    expect(saved).toEqual({
      status: 200,
      body: {
        ok: true,
        workItemMatch: {
          tracker: "linear",
          team: "SOC",
          project: null,
          withoutProject: false,
          labels: ["product:portal"],
          updatedAt: expect.any(String),
        },
        warnings: [],
      } satisfies SavedWorkItemMatch,
    });
    const [row] = await db.select().from(workItemMatches);
    expect(row).toMatchObject({ repositoryId: api, createdBy: adminId, updatedBy: adminId });
    expect((await detail(api)).workItemMatch).toEqual(saved.body.workItemMatch);

    // Saving again replaces it.
    await put(api, { match: { tracker: "linear", team: "MOD", withoutProject: true } });
    expect((await detail(api)).workItemMatch).toMatchObject({
      team: "MOD",
      project: null,
      withoutProject: true,
      labels: [],
    });

    expect(await put(api, { match: null })).toEqual({
      status: 200,
      body: { ok: true, workItemMatch: null, warnings: [] },
    });
    expect((await detail(api)).workItemMatch).toBeNull();
    expect(await db.select().from(workItemMatches)).toEqual([]);
  });

  it("warns about each other repo whose match overlaps", async () => {
    await put(web, { match: { tracker: "linear", team: "SOC", labels: ["portal", "app"] } });
    await put(docs, { match: { tracker: "linear", team: "SOC", labels: ["docs"] } });
    const { body } = await put(api, {
      match: { tracker: "linear", team: "soc", labels: ["App"] },
    });
    expect(body.warnings).toEqual([
      {
        repositoryId: web,
        fullPath: "acme/web",
        message:
          "The work item match of acme/web (Team is SOC, any label of portal, app) overlaps this one: a work item both match asks which repo to use.",
      },
    ]);
    // Both empty label sets overlap; a project tells them apart.
    await put(web, { match: { tracker: "linear", team: "MOD" } });
    await put(docs, { match: { tracker: "linear", team: "MOD", project: "Portal" } });
    const plain = await put(api, { match: { tracker: "linear", team: "MOD" } });
    expect(plain.body.warnings).toEqual([expect.objectContaining({ repositoryId: web })]);
  });

  it("validates the match", async () => {
    const empty = await put(api, { match: { tracker: "linear", team: "  " } });
    expect(empty.status).toBe(400);
    expect(empty.body.fieldErrors).toEqual({ "match.team": "Enter the team's key, e.g. ENG." });

    const both = await put(api, {
      match: { tracker: "linear", team: "ENG", project: "Portal", withoutProject: true },
    });
    expect(both.status).toBe(400);
    expect(both.body.fieldErrors).toEqual({
      "match.project": 'Choose a project or "no project", not both.',
    });

    expect((await put(api, { match: { tracker: "jira", team: "ENG" } })).status).toBe(400);
    expect((await put(api, {})).status).toBe(400);
    expect(await db.select().from(workItemMatches)).toEqual([]);
  });

  it("needs the tracker connected to save, not to clear", async () => {
    await put(api, { match: { tracker: "linear", team: "ENG" } });
    await db.delete(integrations);
    expect(await put(web, { match: { tracker: "linear", team: "ENG" } })).toEqual({
      status: 409,
      body: { error: TRACKER_NOT_CONNECTED, code: "tracker_not_connected" },
    });
    expect((await put(api, { match: null })).status).toBe(200);
    expect(await db.select().from(workItemMatches)).toEqual([]);
  });

  it("is for admins only", async () => {
    state.user = { id: adminId, role: "member" };
    expect((await put(api, { match: { tracker: "linear", team: "ENG" } })).status).toBe(403);
    expect((await put(api, { match: null })).status).toBe(403);
    expect(await db.select().from(workItemMatches)).toEqual([]);
    // Members still read the repo's match.
    expect((await call(repositoryDetail.GET, "GET", api)).status).toBe(200);
  });

  it("answers 404 for an unknown or disconnected repo", async () => {
    expect((await put(randomUUID(), { match: null })).status).toBe(404);
    const connection = (await db.query.repositories.findFirst())!.connectionId;
    const gone = await connectRepository(db, {
      connectionId: connection,
      provider: "github",
      externalId: "gone",
      fullPath: "acme/gone",
    });
    await disconnectRepository(db, state.orgId, gone.id);
    expect((await put(gone.id, { match: { tracker: "linear", team: "ENG" } })).status).toBe(404);
  });

  it("reports the routing rules that target the repo", async () => {
    await setRoutingRules(
      db,
      state.orgId,
      [api, teamIs("ENG")],
      [web, labelsInclude("ui")],
      [api, labelsInclude("backend")],
    );
    expect((await detail(api)).routingRules).toEqual([
      { position: 1, description: "Team is ENG" },
      { position: 3, description: "Labels contains any of backend" },
    ]);
    expect((await detail(docs)).routingRules).toEqual([]);
  });
});
