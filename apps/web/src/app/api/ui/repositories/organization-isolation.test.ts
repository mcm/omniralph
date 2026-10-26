// Two organizations, each with a repository, a rule and a review: a member of one never
// sees or changes the other's, and gets a 404 on its URLs.
import { randomBytes } from "node:crypto";
import {
  addMember,
  setActiveOrganization,
  closeDb,
  connectRepository,
  disconnectRepository,
  createCustomRule,
  createDb,
  createOrganization,
  createReview,
  findings,
  getRepository,
  getRepositoryReviewSettings,
  listRepositoryRules,
  upsertScmConnection,
  users,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { labelsInclude, projectIs, setRoutingRules, teamIs } from "@/lib/routing/testing";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: null as string | null,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
// The signed-in user with their real role in their active organization.
vi.mock("@/lib/auth/session", async () => {
  const { getActiveOrganization } = await import("@omniralph/db");
  const current = async (role: Role) => {
    const active = state.userId ? await getActiveOrganization(state.db, state.userId) : null;
    return assertRole(
      state.userId === null
        ? null
        : {
            id: state.userId,
            organization: active ? { id: active.id, name: active.name } : null,
            role: active?.role ?? null,
            name: null,
            email: null,
            image: null,
            theme: null,
            showAdvanced: false,
          },
      role,
    );
  };
  return {
    requireUser: async (role: Role = "member") => current(role),
    requirePageUser: async (role: Role = "member") => current(role),
  };
});
vi.mock("@/lib/dispatch", () => ({ getDispatcher: () => ({}) }));
// No Linear workspace is connected.
vi.mock("@/lib/linear/settings-options", () => ({ getLinearSettingsOptions: async () => null }));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const repositoryDetail = await import("@/app/api/ui/repositories/[id]/route");
const repositorySettings = await import("@/app/api/ui/repositories/[id]/settings/route");
const repositoryTaskTypes = await import("@/app/api/ui/repositories/[id]/task-types/route");
const repositoryCoding = await import("@/app/api/ui/repositories/[id]/coding/route");
const repositoryRules = await import("@/app/api/ui/repositories/[id]/rules/route");
const repositoryRule = await import("@/app/api/ui/repositories/[id]/rules/[ruleId]/route");

type Coding = { routingRules: unknown[] };

type Handler = (request: Request, route: { params: Promise<{ id: string }> }) => Promise<Response>;

/** Calls an `/api/ui` handler of the repository `id`; resolves to the status and JSON body. */
async function call(handler: Handler, id: string, body?: unknown) {
  const response = await handler(
    new Request("http://localhost/api/ui", {
      method: body === undefined ? "GET" : "PUT",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** A save's answer as the `ActionResult` the form gets. */
async function save(handler: Handler, id: string, body: unknown) {
  const { status, body: json } = await call(handler, id, body);
  return status === 200 ? json : { ok: false, error: json.error as string };
}

// The settings tabs' requests, under the names of the server actions they replace.
const updateRepositorySettings = (id: string, input: unknown) =>
  save(repositorySettings.PUT, id, input);
const updateRepositoryTaskTypes = (id: string, input: unknown) =>
  save(repositoryTaskTypes.PUT, id, input);
const updateRepositoryCoding = (id: string, input: unknown) =>
  save(repositoryCoding.PUT, id, input);

/** A Rules tab request (`method` with a JSON `body`) as the `ActionResult` the tab gets. */
async function ruleRequest<P extends Record<string, string>>(
  handler: (request: Request, route: { params: Promise<P> }) => Promise<Response>,
  method: string,
  params: P,
  body?: unknown,
) {
  const response = await handler(
    new Request("http://localhost/api/ui", {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve(params) },
  );
  const json = (await response.json()) as Record<string, unknown>;
  return response.status === 200 ? json : { ok: false, error: json.error as string };
}

// The Rules tab's requests, under the names of the server actions they replace.
const addCustomRule = (id: string, input: unknown) =>
  ruleRequest(repositoryRules.POST, "POST", { id }, input);
const editRule = (id: string, ruleId: string, input: unknown) =>
  ruleRequest(repositoryRule.PATCH, "PATCH", { id, ruleId }, input);
const setRuleEnabled = (id: string, ruleId: string, enabled: boolean) =>
  ruleRequest(repositoryRule.PATCH, "PATCH", { id, ruleId }, { enabled });
const deleteRule = (id: string, ruleId: string) =>
  ruleRequest(repositoryRule.DELETE, "DELETE", { id, ruleId });

const databaseAvailable = testDatabaseAvailable();

interface Tenant {
  userId: string;
  orgId: string;
  connectionId: string;
  repoId: string;
  ruleId: string;
  reviewId: string;
  findingId: string;
}

describe.skipIf(!databaseAvailable)("organization isolation of repositories and reviews", () => {
  let testDb: TestDatabase;
  let db: Database;
  let a: Tenant;
  let b: Tenant;

  async function tenant(name: string, installationId: string): Promise<Tenant> {
    const [user] = await db
      .insert(users)
      .values({ id: `${name}-admin`, email: `admin@${name}.io` })
      .returning();
    const org = await createOrganization(db, { name, createdBy: user!.id });
    const connection = (await upsertScmConnection(db, {
      organizationId: org.id,
      provider: "github",
      name,
      baseUrl: "https://api.github.com",
      externalId: installationId,
      credentials: {},
    }))!;
    // Both organizations connect the same GitHub repository through their own installation.
    const repo = await connectRepository(db, {
      connectionId: connection.id,
      provider: "github",
      externalId: "500",
      fullPath: "shared/app",
    });
    const rule = await createCustomRule(db, {
      repositoryId: repo.id,
      text: `${name} rule`,
      createdBy: user!.id,
    });
    const review = await createReview(db, {
      repositoryId: repo.id,
      prNumber: 1,
      headSha: "h",
      baseSha: "b",
      trigger: "webhook",
      depth: "standard",
      model: null,
      budget: 1,
    });
    const [finding] = await db
      .insert(findings)
      .values({
        reviewId: review.id,
        path: "a.ts",
        startLine: 1,
        endLine: 1,
        severity: "medium",
        category: "bug",
        title: `${name} finding`,
        body: "x",
        confidence: 0.9,
      })
      .returning();
    return {
      userId: user!.id,
      orgId: org.id,
      connectionId: connection.id,
      repoId: repo.id,
      ruleId: rule.id,
      reviewId: review.id,
      findingId: finding!.id,
    };
  }

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    a = await tenant("alpha", "1");
    b = await tenant("beta", "2");
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  it("lists only the active organization's repositories", async () => {
    state.userId = a.userId;
    const settings = await call(repositoryDetail.GET, a.repoId);
    expect(settings).toMatchObject({ status: 200, body: { repository: { id: a.repoId } } });
    const rules = await call(repositoryRules.GET, a.repoId);
    expect(rules).toMatchObject({ status: 200, body: { repository: { id: a.repoId } } });
    expect((rules.body.rules as { id: string }[]).map((r) => r.id)).toEqual([a.ruleId]);
  });

  it("lists the organization's routing rules that target the repository on its detail", async () => {
    state.userId = a.userId;
    const web = await connectRepository(db, {
      connectionId: a.connectionId,
      provider: "github",
      externalId: "501",
      fullPath: "shared/web",
    });
    await setRoutingRules(
      db,
      a.orgId,
      [a.repoId, teamIs("ENG")],
      [web.id, labelsInclude("backend")],
      [a.repoId, projectIs("App")],
    );
    try {
      expect(
        ((await call(repositoryDetail.GET, a.repoId)).body.coding as Coding).routingRules,
      ).toEqual([
        { position: 1, description: "Team is ENG" },
        { position: 3, description: "Project is App" },
      ]);
      expect(
        ((await call(repositoryDetail.GET, web.id)).body.coding as Coding).routingRules,
      ).toEqual([{ position: 2, description: "Labels contains any of backend" }]);
      // Another organization's rules never show.
      state.userId = b.userId;
      expect(
        ((await call(repositoryDetail.GET, b.repoId)).body.coding as Coding).routingRules,
      ).toEqual([]);
    } finally {
      state.userId = a.userId;
      await setRoutingRules(db, a.orgId);
      await disconnectRepository(db, a.orgId, web.id);
    }
  });

  it("shows the coding policy to admins only; members get a 403 but see the repository", async () => {
    const [member] = await db
      .insert(users)
      .values({ id: "alpha-member", email: "member@alpha.io" })
      .returning();
    expect(
      await addMember(db, { organizationId: a.orgId, userId: member!.id, role: "member" }),
    ).toBe("added");
    await setActiveOrganization(db, { userId: member!.id, organizationId: a.orgId });
    state.userId = member!.id;
    expect(await call(repositoryCoding.GET, a.repoId)).toMatchObject({ status: 403 });
    expect(await call(repositoryDetail.GET, a.repoId)).toMatchObject({ status: 200 });
    state.userId = a.userId;
    expect(await call(repositoryCoding.GET, a.repoId)).toMatchObject({ status: 200 });
  });

  it("returns 404 for another organization's repository pages", async () => {
    state.userId = a.userId;
    for (const handler of [repositoryDetail.GET, repositoryCoding.GET, repositoryRules.GET]) {
      expect(await call(handler, b.repoId)).toMatchObject({ status: 404 });
    }
  });

  it("refuses actions on another organization's repositories and rules", async () => {
    state.userId = a.userId;
    const refused = { ok: false, error: expect.any(String) };
    expect(
      await updateRepositoryTaskTypes(b.repoId, { reviews: false, coding: false, ask: false }),
    ).toEqual(refused);
    expect(
      await updateRepositorySettings(b.repoId, {
        depth: "deep",
        triggers: { onOpen: false, onPush: false, drafts: false },
        pathExcludes: [],
        customInstructions: "",
        pinnedAgentIds: [],
        reviewPlaybookIds: ["builtin:review-pr"],
        correlationPlaybookId: "builtin:correlate-findings",
      }),
    ).toEqual(refused);
    expect(
      await updateRepositoryCoding(b.repoId, {
        codingEnabled: true,
        codingInstructions: "Sneaky.",
        openPullRequestEarly: true,
        historyRewrite: "always",
        respondToReviewsAndCi: false,
      }),
    ).toEqual(refused);
    expect(await getRepository(db, b.repoId)).toMatchObject({
      reviewsEnabled: true,
      disconnectedAt: null,
      reviewDepth: "standard",
      codingEnabled: false,
      codingInstructions: null,
      historyRewrite: "when-asked",
    });

    expect(await addCustomRule(b.repoId, { text: "Sneaky rule" })).toEqual(refused);
    expect(await editRule(b.repoId, b.ruleId, { text: "Edited" })).toEqual(refused);
    expect(await setRuleEnabled(b.repoId, b.ruleId, false)).toEqual(refused);
    expect(await deleteRule(b.repoId, b.ruleId)).toEqual(refused);
    expect((await listRepositoryRules(db, b.repoId)).map((r) => [r.text, r.enabled])).toEqual([
      ["beta rule", true],
    ]);
  });

  it("sets the depth of the active organization's repositories only", async () => {
    state.userId = a.userId;
    const settings = {
      depth: "deep" as const,
      triggers: { onOpen: true, onPush: true, drafts: false },
      pathExcludes: [],
      customInstructions: "",
      pinnedAgentIds: [],
      reviewPlaybookIds: ["builtin:review-pr"],
      correlationPlaybookId: "builtin:correlate-findings",
    };
    expect(await updateRepositorySettings(a.repoId, settings)).toEqual({ ok: true });
    expect((await getRepositoryReviewSettings(db, a.repoId))!.depth).toBe("deep");
    expect((await getRepository(db, b.repoId))!.reviewDepth).toBe("standard");
    const detail = await call(repositoryDetail.GET, a.repoId);
    expect(detail.body.reviews).toMatchObject({ depth: "deep" });
  });
});
