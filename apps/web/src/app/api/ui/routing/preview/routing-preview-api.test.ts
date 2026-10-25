import { randomBytes } from "node:crypto";
import {
  closeDb,
  connectRepository,
  createDb,
  createRun,
  organizations,
  ralphRuns,
  rateLimits,
  setRepositorySwitches,
  updateRun,
  upsertScmConnection,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ROUTING_PREVIEW_MAX,
  type RoutingPreview,
  type RoutingPreviewItem,
} from "@/lib/api/routing-rules";
import { assertRole, type Role } from "@/lib/auth/roles";
import type * as LinearClient from "@/lib/linear/client";
import { FakeLinearGateway } from "@/lib/linear/fake-gateway";
import { labelsInclude, setRoutingRules } from "@/lib/routing/testing";
import { ROUTING_TEST_LIMIT, unknownIssueMessage } from "@/lib/routing/test-issue";

vi.mock("server-only", () => ({}));
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const state = vi.hoisted(() => ({
  orgId: "",
  userId: "user-1",
  db: undefined as unknown as Database,
  role: "member" as Role,
  /** The connected workspace; null: none connected. */
  linear: null as FakeLinearGateway | null,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") =>
    assertRole(
      {
        id: state.userId,
        role: state.role,
        name: null,
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
    getLinearGateway: async () => {
      if (!state.linear) throw new actual.LinearNotConnectedError();
      return state.linear;
    },
  };
});

const preview = await import("@/app/api/ui/routing/preview/route");
const testRoute = await import("@/app/api/ui/routing-rules/test/route");

async function call(
  handler: typeof preview.POST,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handler(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const post = (identifiers: unknown) =>
  call(preview.POST, "/api/ui/routing/preview", { identifiers });

const results = async (...identifiers: string[]) => {
  const { status, body } = await post(identifiers);
  expect(status).toBe(200);
  return (body as unknown as RoutingPreview).results;
};

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("POST /api/ui/routing/preview", () => {
  let testDb: TestDatabase;
  let web: string;
  let docs: string;
  let linear: FakeLinearGateway;
  let sessions = 0;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    state.db = createDb(testDb.uri);
    const [org] = await state.db.insert(organizations).values({ name: "Acme" }).returning();
    state.orgId = org!.id;
    const connection = (await upsertScmConnection(
      state.db,
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
      (await connectRepository(state.db, {
        connectionId: connection.id,
        provider: "github",
        externalId,
        fullPath,
      }))!.id;
    web = await repo("1", "acme/web");
    docs = await repo("2", "acme/docs");
    await setRepositorySwitches(state.db, org!.id, docs, { coding: false });
  }, 180_000);

  afterAll(async () => {
    if (state.db) await closeDb(state.db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    state.role = "member";
    state.userId = "user-1";
    await state.db.delete(ralphRuns);
    await state.db.delete(rateLimits);
    await setRoutingRules(
      state.db,
      state.orgId,
      [web, labelsInclude("frontend")],
      [docs, labelsInclude("docs")],
    );
    linear = new FakeLinearGateway();
    state.linear = linear;
  });

  /** A finished run of `issueId`, in `repositoryId`, routed `by`. */
  const startedRun = async (issueId: string, identifier: string, by: string | null) => {
    sessions += 1;
    const { run } = await createRun(state.db, {
      organizationId: state.orgId,
      linearIssueId: issueId,
      linearIdentifier: identifier,
      linearTitle: identifier,
      linearUrl: null,
      linearAgentSessionId: `session-${sessions}`,
      kind: "single",
      repositoryId: web,
      routedBy: by,
      branch: `branch-${sessions}`,
      baseBranch: "main",
    });
    await updateRun(state.db, run.id, { status: "completed" });
    return run.id;
  };

  it("routes each work item by the saved rules, with the coding switch and its run", async () => {
    const ui = linear.add({ identifier: "ENG-1", title: "UI", labels: ["Frontend"] });
    linear.add({ identifier: "ENG-2", title: "Docs", labels: ["docs"] });
    linear.add({ identifier: "OPS-1", title: "Infra", teamKey: "OPS" });
    const runId = await startedRun(ui.id, "ENG-1", "your selection");

    expect(await results("OPS-1", "ENG-1", "ENG-2")).toEqual([
      {
        identifier: "OPS-1",
        issue: { identifier: "OPS-1", title: "Infra" },
        outcome: "ask",
        repository: null,
        rule: { kind: "default", number: 3 },
        by: null,
        run: null,
      },
      {
        identifier: "ENG-1",
        issue: { identifier: "ENG-1", title: "UI" },
        outcome: "repository",
        repository: { id: web, fullPath: "acme/web", codingEnabled: true },
        rule: { kind: "custom", number: 1, summary: "Labels contains any of frontend" },
        by: "rule 1 (Labels contains any of frontend)",
        run: { id: runId, routedBy: "your selection" },
      },
      {
        identifier: "ENG-2",
        issue: { identifier: "ENG-2", title: "Docs" },
        outcome: "manual",
        repository: { id: docs, fullPath: "acme/docs", codingEnabled: false },
        rule: { kind: "custom", number: 2, summary: "Labels contains any of docs" },
        by: "rule 2 (Labels contains any of docs)",
        run: null,
      },
    ] satisfies RoutingPreviewItem[]);
  });

  it("answers the default rules with the chain through a started parent", async () => {
    const epic = linear.add({ identifier: "ENG-10", title: "Epic" });
    linear.add({ identifier: "ENG-11", title: "Story", parentId: epic.id });
    await startedRun(epic.id, "ENG-10", "team ENG");
    const [story] = await results("ENG-11");
    expect(story).toMatchObject({
      outcome: "repository",
      repository: { id: web, codingEnabled: true },
      rule: { kind: "default", number: 2 },
      by: "sub-issue of ENG-10 → team ENG",
      run: null,
    });
  });

  it("answers an unknown work item as a not_found result, not a failed request", async () => {
    linear.add({ identifier: "ENG-1", title: "UI", labels: ["frontend"] });
    const [unknown, known] = await results("ENG-404", "ENG-1");
    expect(unknown).toEqual({
      identifier: "ENG-404",
      outcome: "not_found",
      message: unknownIssueMessage("ENG-404"),
    } satisfies RoutingPreviewItem);
    expect(known).toMatchObject({ identifier: "ENG-1", outcome: "repository" });
  });

  it("asks Linear once per work item in a request", async () => {
    const epic = linear.add({ identifier: "ENG-10", title: "Epic", labels: ["frontend"] });
    const story = linear.add({ identifier: "ENG-11", title: "Story", parentId: epic.id });
    const routed = await results("ENG-11", "ENG-10", "ENG-11");
    expect(routed.map((r) => r.outcome)).toEqual(["repository", "repository", "repository"]);
    expect(routed[0]).toMatchObject({ rule: { kind: "default", number: 2 } });
    // The sub-issue's route reads its parent, which was sent too, and ENG-11 was sent twice:
    // each issue is loaded once.
    expect(linear.routingLoads.toSorted()).toEqual([epic.id, story.id].toSorted());
  });

  it("takes 1 to 50 identifiers", async () => {
    expect((await post([])).status).toBe(400);
    expect((await post(["  "])).status).toBe(400);
    const tooMany = Array.from({ length: ROUTING_PREVIEW_MAX + 1 }, (_, i) => `ENG-${i}`);
    expect(await post(tooMany)).toMatchObject({
      status: 400,
      body: { fieldErrors: { identifiers: "Preview at most 50 work items at once." } },
    });
    const most = Array.from({ length: ROUTING_PREVIEW_MAX }, (_, i) => `ENG-${i}`);
    expect((await results(...most)).length).toBe(ROUTING_PREVIEW_MAX);
  });

  it("answers 409 without a Linear workspace", async () => {
    state.linear = null;
    expect(await post(["ENG-1"])).toMatchObject({
      status: 409,
      body: { code: "linear_not_connected" },
    });
  });

  it(`shares the "Test an issue" limit of ${ROUTING_TEST_LIMIT} a minute per user`, async () => {
    // Mid-window, so the loop doesn't straddle two.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-18T12:00:20Z") });
    try {
      linear.add({ identifier: "ENG-1", title: "UI" });
      const test = () =>
        call(testRoute.POST, "/api/ui/routing-rules/test", { identifier: "ENG-1", rules: [] });
      for (let i = 0; i < ROUTING_TEST_LIMIT - 1; i++) {
        expect((await test()).status).toBe(200);
      }
      expect((await post(["ENG-1"])).status).toBe(200);
      const limited = await post(["ENG-1"]);
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe("rate_limited");
      expect((await test()).status).toBe(429);
      // Another user isn't.
      state.userId = "user-2";
      expect((await post(["ENG-1"])).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});
