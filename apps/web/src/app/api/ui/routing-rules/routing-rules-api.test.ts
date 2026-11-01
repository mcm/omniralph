import { randomBytes, randomUUID } from "node:crypto";
import {
  closeDb,
  connectRepository,
  createDb,
  listRoutingRules,
  organizations,
  repositories,
  upsertScmConnection,
  users,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
  setCodingEnabled,
} from "@omniralph/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRole, type Role } from "@/lib/auth/roles";
import type { RoutingRules } from "@/lib/api/routing-rules";
import type { TrackerSettingsOptions } from "@/lib/tracker/settings-values";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  /** The connected Linear workspace's options (null: none connected), or a load failure. */
  linear: null as TrackerSettingsOptions | null | Error,
  orgId: "",
  db: undefined as unknown as Database,
  role: "admin" as Role,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/tracker/settings-options", () => ({
  getTrackerSettingsOptions: async () => {
    if (state.linear instanceof Error) throw state.linear;
    return state.linear;
  },
}));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") =>
    assertRole(
      {
        id: "user-1",
        role: state.role,
        name: null,
        email: null,
        image: null,
        organization: { id: state.orgId, name: "Acme" },
      },
      role,
    ),
}));

const route = await import("@/app/api/ui/routing-rules/route");
const { ROUTING_FIELDS } = await import("@/lib/routing/fields");

const key = randomBytes(32);

const workspace: TrackerSettingsOptions = {
  teams: [{ key: "ENG", name: "Engineering" }],
  labels: ["backend"],
  projects: ["Omniralph"],
  states: ["Todo"],
  projectMilestones: ["Beta"],
  cycles: [{ id: "cy1", number: 1, name: null, teamKey: "ENG" }],
  users: [{ id: "u1", name: "Ada" }],
};

async function get(): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await route.GET(new Request("http://localhost/api/ui/routing-rules"), {
    params: Promise.resolve({}),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function put(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await route.PUT(
    new Request("http://localhost/api/ui/routing-rules", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const labels = (...values: string[]) => ({
  combinator: "and",
  rules: [{ field: "labels", operator: "containsAny", value: values }],
});

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("/api/ui/routing-rules", () => {
  let testDb: TestDatabase;
  let web: string;
  let api: string;
  let foreign: string;
  let seq = 0;

  const repos = async (organizationId: string, ...paths: string[]) => {
    seq += 1;
    const connection = (await upsertScmConnection(
      state.db,
      {
        organizationId,
        provider: "github",
        name: `acme-${seq}`,
        baseUrl: "https://api.github.com",
        externalId: `conn-${seq}`,
        credentials: {},
      },
      key,
    ))!;
    const ids: string[] = [];
    for (const fullPath of paths) {
      seq += 1;
      const repo = await connectRepository(state.db, {
        connectionId: connection.id,
        provider: "github",
        externalId: `repo-${seq}`,
        fullPath,
      });
      ids.push(repo.id);
    }
    return ids;
  };

  beforeAll(async () => {
    testDb = await createTestDatabase();
    state.db = createDb(testDb.uri);
    const [org] = await state.db.insert(organizations).values({ name: "Acme" }).returning();
    const [other] = await state.db.insert(organizations).values({ name: "Other" }).returning();
    state.orgId = org!.id;
    // The signed-in user, whom the history entries name.
    await state.db.insert(users).values({ id: "user-1", name: "Ada" });
    [web, api] = (await repos(org!.id, "acme/web", "acme/api")) as [string, string];
    [foreign] = (await repos(other!.id, "other/repo")) as [string];
    await setCodingEnabled(state.db, web);
  }, 180_000);

  afterAll(async () => {
    if (state.db) await closeDb(state.db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    state.role = "admin";
    state.linear = workspace;
    await put({ rules: [] });
  });

  describe("GET", () => {
    it("answers any member with the rules in order, the catalog, the options and the repositories", async () => {
      await put({
        rules: [
          { repositoryId: api, query: labels("backend") },
          { repositoryId: web, query: labels("frontend") },
        ],
      });
      state.role = "member";
      const { status, body } = await get();
      expect(status).toBe(200);
      const result = body as unknown as RoutingRules;
      expect(result.rules.map((r) => [r.position, r.repositoryId, r.query])).toEqual([
        [0, api, labels("backend")],
        [1, web, labels("frontend")],
      ]);
      expect(result.fields).toEqual(JSON.parse(JSON.stringify(ROUTING_FIELDS)));
      expect(result.tracker).toEqual({
        status: "connected",
        provider: "linear",
        options: workspace,
      });
      expect(result.repositories).toEqual([
        { id: api, provider: "github", fullPath: "acme/api", codingEnabled: false },
        { id: web, provider: "github", fullPath: "acme/web", codingEnabled: true },
      ]);
    });

    it("answers the rules' latest change, by the admin who saved them (members too)", async () => {
      await put({ rules: [{ repositoryId: api, query: labels("history") }] });
      state.role = "member";
      const { body } = await get();
      const { history } = body as unknown as RoutingRules;
      expect(history).toMatchObject({
        section: "routing_rules",
        actor: { id: "user-1" },
        organization: { id: state.orgId, name: "Acme" },
      });
    });

    it("says when Linear isn't connected or can't be read", async () => {
      state.linear = null;
      expect((await get()).body.tracker).toEqual({ status: "disconnected", provider: "linear" });
      state.linear = new Error("Linear is down");
      vi.spyOn(console, "error").mockImplementation(() => {});
      expect((await get()).body.tracker).toEqual({ status: "unavailable", provider: "linear" });
    });
  });

  describe("PUT", () => {
    it("is for admins only", async () => {
      state.role = "member";
      const { status } = await put({ rules: [{ repositoryId: web, query: labels("x") }] });
      expect(status).toBe(403);
      expect(await listRoutingRules(state.db, state.orgId)).toEqual([]);
    });

    it("replaces the whole list, and reorders it", async () => {
      const first = await put({
        rules: [
          { repositoryId: web, query: labels("a") },
          { repositoryId: api, query: labels("b") },
        ],
      });
      expect(first.status).toBe(200);
      expect(first.body.ok).toBe(true);

      const second = await put({
        rules: [
          { repositoryId: api, query: labels("b") },
          { repositoryId: web, query: labels("a") },
          { repositoryId: web, query: labels("c") },
        ],
      });
      expect(second.status).toBe(200);
      const saved = await listRoutingRules(state.db, state.orgId);
      expect(saved.map((r) => [r.position, r.repositoryId, r.query])).toEqual([
        [0, api, labels("b")],
        [1, web, labels("a")],
        [2, web, labels("c")],
      ]);
      expect((second.body.rules as Array<{ id: string }>).map((r) => r.id)).toEqual(
        saved.map((r) => r.id),
      );
    });

    it("rejects an invalid query with field errors, and saves nothing", async () => {
      await put({ rules: [{ repositoryId: web, query: labels("keep") }] });
      const { status, body } = await put({
        rules: [
          { repositoryId: web, query: labels("a") },
          {
            repositoryId: api,
            query: {
              combinator: "and",
              rules: [
                { field: "milestone", operator: "=", value: "x" },
                { field: "parent.labels", operator: "=", value: "x" },
                { field: "source.title", operator: "matches", value: "(" },
                { field: "priority", operator: "=", value: "9" },
              ],
            },
          },
        ],
      });
      expect(status).toBe(400);
      expect(body.fieldErrors).toEqual({
        "rules.1.query.rules.0.field": "Pick a field.",
        "rules.1.query.rules.1.operator": "Pick an operator for this field.",
        "rules.1.query.rules.2.value": "This isn't a valid regular expression.",
        "rules.1.query.rules.3.value": "Pick a value.",
      });
      expect((await listRoutingRules(state.db, state.orgId)).map((r) => r.query)).toEqual([
        labels("keep"),
      ]);
    });

    it("rejects more than 100 rules", async () => {
      const rules = Array.from({ length: 101 }, () => ({ repositoryId: web, query: labels("a") }));
      const { status, body } = await put({ rules });
      expect(status).toBe(400);
      expect(body.fieldErrors).toEqual({ rules: "There can be at most 100 rules." });
    });

    it("rejects repositories outside the organization with field errors, and saves nothing", async () => {
      await put({ rules: [{ repositoryId: web, query: labels("keep") }] });
      const { status, body } = await put({
        rules: [
          { repositoryId: web, query: labels("a") },
          { repositoryId: foreign, query: labels("b") },
          { repositoryId: randomUUID(), query: labels("c") },
        ],
      });
      expect(status).toBe(400);
      expect(body.fieldErrors).toEqual({
        "rules.1.repositoryId": "Pick one of your organization's repositories.",
        "rules.2.repositoryId": "Pick one of your organization's repositories.",
      });
      expect((await listRoutingRules(state.db, state.orgId)).map((r) => r.query)).toEqual([
        labels("keep"),
      ]);
    });

    it("drops a deleted repository's rules", async () => {
      const [docs] = (await repos(state.orgId, "acme/docs")) as [string];
      await put({
        rules: [
          { repositoryId: docs, query: labels("docs") },
          { repositoryId: web, query: labels("web") },
        ],
      });
      await state.db.delete(repositories).where(eq(repositories.id, docs));
      const rules = (await get()).body.rules as Array<{ repositoryId: string }>;
      expect(rules.map((r) => r.repositoryId)).toEqual([web]);
    });
  });
});
