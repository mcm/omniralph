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
  createHarnessEnrollment,
  enrollHarness,
  pinRepositoryToHarness,
  recordHarnessHeartbeat,
  updateHarnessConfig,
  createDb,
  createOrganization,
  createReview,
  findings,
  getRepository,
  getRepositoryReviewSettings,
  getReviewProfile,
  listRepositoryRules,
  upsertScmConnection,
  users,
  type Database,
} from "@omniralph/db";
import { DEFAULT_RALPH_SETTINGS, ralphSettingsFormValues } from "@omniralph/shared";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { callAction } from "@/lib/api/test-call";
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
const repositoryLinear = await import("@/app/api/ui/repositories/[id]/coding/linear/route");
const repositoryRules = await import("@/app/api/ui/repositories/[id]/rules/route");
const repositoryRule = await import("@/app/api/ui/repositories/[id]/rules/[ruleId]/route");
const reviewProfiles = await import("@/app/api/ui/review-profiles/route");
const reviewProfile = await import("@/app/api/ui/review-profiles/[id]/route");

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
const updateRalphSettings = (id: string, input: unknown) => save(repositoryCoding.PUT, id, input);

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
// Settings › Review profiles' save, under the server action's old name.
const updateReviewProfile = (id: string, input: unknown) =>
  callAction(reviewProfile.PUT, "PUT", { id }, input);

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
      profileId: "standard",
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

  it("lists only the active organization's repositories and profiles", async () => {
    state.userId = a.userId;
    const profiles = await call(reviewProfiles.GET, a.repoId);
    expect(profiles.status).toBe(200);
    const rows = profiles.body.profiles as { id: string; repositories: { id: string }[] }[];
    expect(rows.map((p) => p.id)).toEqual(["quick", "standard", "deep"]);
    // Only this organization's repositories use its profiles.
    expect(JSON.stringify(profiles.body)).not.toContain(b.repoId);

    const settings = await call(repositoryDetail.GET, a.repoId);
    expect(settings).toMatchObject({ status: 200, body: { repository: { id: a.repoId } } });
    const rules = await call(repositoryRules.GET, a.repoId);
    expect(rules).toMatchObject({ status: 200, body: { repository: { id: a.repoId } } });
    expect((rules.body.rules as { id: string }[]).map((r) => r.id)).toEqual([a.ruleId]);
  });

  it("offers the Coding tab the models of its pinned harnesses, else of those accepting coding", async () => {
    state.userId = a.userId;
    const harness = async (name: string, models: { value: string; displayName: string }[]) => {
      const enrollment = await createHarnessEnrollment(db, { organizationId: a.orgId, name });
      const { harnessId } = (await enrollHarness(db, {
        enrollmentToken: enrollment.token,
        name,
        version: "1.0.0",
      }))!;
      await recordHarnessHeartbeat(db, harnessId, { version: "1.0.0", models });
      return harnessId;
    };
    const opus = { value: "opus", displayName: "Opus" };
    const sonnet = { value: "sonnet", displayName: "Sonnet" };
    const haiku = { value: "haiku", displayName: "Haiku" };
    const coder = await harness("coder", [opus, sonnet]);
    const reviewer = await harness("reviewer", [haiku]);
    await updateHarnessConfig(db, a.orgId, reviewer, {
      maxConcurrency: null,
      acceptedTaskTypes: ["review"],
      poolLimits: {},
    });
    // Another organization's harness never counts.
    const other = await createHarnessEnrollment(db, { organizationId: b.orgId, name: "other" });
    const { harnessId: otherId } = (await enrollHarness(db, {
      enrollmentToken: other.token,
      name: "other",
      version: "1.0.0",
    }))!;
    await recordHarnessHeartbeat(db, otherId, { version: "1.0.0", models: [haiku] });

    const choices = async () => (await call(repositoryCoding.GET, a.repoId)).body;
    expect(await call(repositoryLinear.GET, a.repoId)).toEqual({
      status: 200,
      body: { status: "disconnected" },
    });
    // Unpinned: every harness accepting coding.
    expect(await choices()).toMatchObject({
      models: [
        { ...opus, harnessIds: [coder] },
        { ...sonnet, harnessIds: [coder] },
      ],
      harnessCount: 1,
      pinned: false,
    });
    // Pinned: its pinned harnesses, whatever they accept.
    await pinRepositoryToHarness(db, { harnessId: reviewer, repositoryId: a.repoId });
    expect(await choices()).toMatchObject({
      models: [{ ...haiku, harnessIds: [reviewer] }],
      harnessCount: 1,
      pinned: true,
    });
    // The other tabs' data doesn't carry them.
    expect((await call(repositoryDetail.GET, a.repoId)).body).not.toHaveProperty("models");
  });

  it("lists the organization's routing rules that target the repository on the Coding tab", async () => {
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
      expect((await call(repositoryCoding.GET, a.repoId)).body.routingRules).toEqual([
        { number: 1, summary: "Team is ENG" },
        { number: 3, summary: "Project is App" },
      ]);
      expect((await call(repositoryCoding.GET, web.id)).body.routingRules).toEqual([
        { number: 2, summary: "Labels contains any of backend" },
      ]);
      // Another organization's rules never show.
      state.userId = b.userId;
      expect((await call(repositoryCoding.GET, b.repoId)).body.routingRules).toEqual([]);
    } finally {
      state.userId = a.userId;
      await setRoutingRules(db, a.orgId);
      await disconnectRepository(db, a.orgId, web.id);
    }
  });

  it("shows the Coding tab to admins only; members get a 403 but see the other tabs", async () => {
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
    expect(await call(repositoryLinear.GET, a.repoId)).toMatchObject({ status: 403 });
    expect(await call(repositoryDetail.GET, a.repoId)).toMatchObject({ status: 200 });
    state.userId = a.userId;
    expect(await call(repositoryCoding.GET, a.repoId)).toMatchObject({ status: 200 });
  });

  it("returns 404 for another organization's repository pages", async () => {
    state.userId = a.userId;
    for (const handler of [
      repositoryDetail.GET,
      repositoryCoding.GET,
      repositoryLinear.GET,
      repositoryRules.GET,
    ]) {
      expect(await call(handler, b.repoId)).toMatchObject({ status: 404 });
    }
  });

  it("refuses actions on another organization's repositories and rules", async () => {
    state.userId = a.userId;
    const refused = { ok: false, error: expect.any(String) };
    expect(
      await updateRepositoryTaskTypes(b.repoId, { query: false, review: false, coding: false }),
    ).toEqual(refused);
    expect(
      await updateRepositorySettings(b.repoId, {
        profileId: "deep",
        triggers: { onOpen: false, onPush: false, drafts: false },
        pathExcludes: [],
        customInstructions: "",
        pinnedHarnessIds: [],
        reviewTaskIds: ["builtin:review-pr"],
        correlationTaskId: "builtin:correlate-findings",
      }),
    ).toEqual(refused);
    expect(
      await updateRalphSettings(b.repoId, {
        storyTaskId: "builtin:implement-story",
        requestTaskId: "builtin:handle-request",
        ...ralphSettingsFormValues(DEFAULT_RALPH_SETTINGS),
      }),
    ).toEqual(refused);
    expect(await getRepository(db, b.repoId)).toMatchObject({
      enabled: null,
      disconnectedAt: null,
      profileId: "standard",
      ralphEnabled: null,
    });

    expect(await addCustomRule(b.repoId, { text: "Sneaky rule" })).toEqual(refused);
    expect(await editRule(b.repoId, b.ruleId, { text: "Edited" })).toEqual(refused);
    expect(await setRuleEnabled(b.repoId, b.ruleId, false)).toEqual(refused);
    expect(await deleteRule(b.repoId, b.ruleId)).toEqual(refused);
    expect((await listRepositoryRules(db, b.repoId)).map((r) => [r.text, r.enabled])).toEqual([
      ["beta rule", true],
    ]);
  });

  it("edits only the active organization's review profiles", async () => {
    state.userId = a.userId;
    const limits = {
      model: "claude-haiku-5-5",
      maxTokensPerReview: 12_345,
      maxFiles: 3,
      allowRepoExploration: false,
    };
    expect(await updateReviewProfile("deep", limits)).toEqual({ ok: true });
    expect(await getReviewProfile(db, a.orgId, "deep")).toMatchObject({
      maxTokensPerReview: 12_345,
    });
    expect(await getReviewProfile(db, b.orgId, "deep")).toMatchObject({
      maxTokensPerReview: 500_000,
    });

    // Reviews of this organization's repositories use its own copy of the profile.
    expect(
      await updateRepositorySettings(a.repoId, {
        profileId: "deep",
        triggers: { onOpen: true, onPush: true, drafts: false },
        pathExcludes: [],
        customInstructions: "",
        pinnedHarnessIds: [],
        reviewTaskIds: ["builtin:review-pr"],
        correlationTaskId: "builtin:correlate-findings",
      }),
    ).toEqual({ ok: true });
    expect((await getRepositoryReviewSettings(db, a.repoId))!.profile).toMatchObject({
      organizationId: a.orgId,
      id: "deep",
      maxTokensPerReview: 12_345,
    });
    expect((await getRepository(db, a.repoId))!.profileId).toBe("deep");
  });
});
