import { randomBytes } from "node:crypto";
import {
  closeDb,
  connectRepository,
  createDb,
  createRun,
  followUpSources,
  getRunBySession,
  jobs,
  organizations,
  ralphRuns,
  rateLimits,
  recordFollowUpSource,
  saveWorkItemMatch,
  upsertScmConnection,
  workItemMatches,
  type Database,
  type WorkItemMatchFields,
} from "@omniralph/db";
import type { ScmAdapter } from "@omniralph/scm";
import type { RoutingQuery } from "@omniralph/shared";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
  setCodingEnabled,
} from "@omniralph/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoutingTestResult } from "@/lib/api/routing-rules";
import { assertRole, type Role } from "@/lib/auth/roles";
import { PostgresDispatcher } from "@/lib/dispatch/dispatcher";
import type * as LinearClient from "@/lib/tracker/linear/client";
import { FakeLinearGateway } from "@omniralph/tracker/linear/testing";
import { startRun, type StartRunDeps } from "@/lib/ralph/start";
import { AGENT_SESSION_MARKER } from "@omniralph/tracker/linear";
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
vi.mock("@/lib/tracker/linear/client", async (importOriginal) => {
  const actual = await importOriginal<typeof LinearClient>();
  return {
    ...actual,
    getLinearGateway: async () => {
      if (!state.linear) throw new actual.LinearNotConnectedError();
      return state.linear;
    },
  };
});

const route = await import("@/app/api/ui/routing-rules/test/route");

type Rules = Array<[repositoryId: string, query: RoutingQuery]>;

async function post(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await route.POST(
    new Request("http://localhost/api/ui/routing-rules/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const test = (identifier: string, rules: Rules) =>
  post({ identifier, rules: rules.map(([repositoryId, query]) => ({ repositoryId, query })) });

const titleIs = (title: string): RoutingQuery => ({
  combinator: "and",
  rules: [{ field: "title", operator: "=", value: title }],
});

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("POST /api/ui/routing-rules/test", () => {
  let testDb: TestDatabase;
  let web: string;
  let api: string;
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
    api = await repo("2", "acme/api");
    docs = await repo("3", "acme/docs");
    await setCodingEnabled(state.db, web);
    await setCodingEnabled(state.db, api);
  }, 180_000);

  afterAll(async () => {
    if (state.db) await closeDb(state.db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    state.role = "member";
    state.userId = "user-1";
    await state.db.delete(jobs);
    await state.db.delete(ralphRuns);
    await state.db.delete(followUpSources);
    await state.db.delete(rateLimits);
    await state.db.delete(workItemMatches);
    await setRoutingRules(state.db, state.orgId);
    linear = new FakeLinearGateway();
    state.linear = linear;
  });

  it("routes by the unsaved rules, not the saved ones, and saves nothing", async () => {
    await setRoutingRules(state.db, state.orgId, [api, labelsInclude("frontend")]);
    linear.add({ identifier: "ENG-1", title: "UI", labels: ["Frontend"] });
    const { status, body } = await test("ENG-1", [
      [docs, labelsInclude("never")],
      [web, labelsInclude("frontend")],
    ]);
    expect(status).toBe(200);
    expect(body).toEqual({
      issue: { identifier: "ENG-1", title: "UI" },
      outcome: "repository",
      repository: { id: web, fullPath: "acme/web", provider: "github" },
      matched: "rule",
      rule: { kind: "custom", number: 2, summary: "Labels contains any of frontend" },
      by: "rule 2 (Labels contains any of frontend)",
      run: null,
    } satisfies RoutingTestResult);
    // The issue was loaded once.
    expect(linear.routingLoads).toHaveLength(1);
  });

  it("answers the work item's latest run and the repo it builds in", async () => {
    const ui = linear.add({ identifier: "ENG-1", title: "UI", labels: ["Frontend"] });
    const { run } = await createRun(state.db, {
      organizationId: state.orgId,
      trackerIssueId: ui.id,
      trackerIdentifier: "ENG-1",
      trackerTitle: "UI",
      trackerUrl: null,
      trackerSessionId: "session-run-answer",
      kind: "single",
      repositoryId: api,
      routedBy: "your selection",
      branch: "branch-run-answer",
      baseBranch: "main",
    });
    const { body } = await test("ENG-1", [[web, labelsInclude("frontend")]]);
    expect(body).toMatchObject({
      repository: { id: web },
      run: {
        id: run.id,
        routedBy: "your selection",
        repository: { id: api, fullPath: "acme/api", provider: "github" },
      },
    });
  });

  it("routes by the saved rules when the body leaves them out", async () => {
    await setRoutingRules(state.db, state.orgId, [api, labelsInclude("frontend")]);
    linear.add({ identifier: "ENG-1", title: "UI", labels: ["Frontend"] });
    const { status, body } = await post({ identifier: "ENG-1" });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      outcome: "repository",
      repository: { id: api },
      matched: "rule",
      rule: { kind: "custom", number: 1, summary: "Labels contains any of frontend" },
    });
  });

  it("answers the default rules, manual and ask, with the chain", async () => {
    const epic = linear.add({ identifier: "ENG-10", title: "Epic", labels: ["docs"] });
    linear.add({ identifier: "ENG-11", title: "Story", parentId: epic.id });
    linear.add({ identifier: "OPS-1", title: "Infra", teamKey: "OPS" });
    const rules: Rules = [[docs, labelsInclude("docs")]];

    expect((await test("ENG-11", rules)).body).toEqual({
      issue: { identifier: "ENG-11", title: "Story" },
      outcome: "manual",
      repository: { id: docs, fullPath: "acme/docs", provider: "github" },
      matched: "default",
      rule: { kind: "default", number: 2 },
      by: "sub-issue of ENG-10 → rule 1 (Labels contains any of docs)",
      run: null,
    } satisfies RoutingTestResult);
    expect((await test("OPS-1", rules)).body).toEqual({
      issue: { identifier: "OPS-1", title: "Infra" },
      outcome: "ask",
      repository: null,
      matched: "default",
      rule: { kind: "default", number: 3 },
      by: null,
      run: null,
    } satisfies RoutingTestResult);
  });

  describe("work item matches", () => {
    const fields = (partial: Partial<WorkItemMatchFields> = {}): WorkItemMatchFields => ({
      tracker: "linear",
      team: "ENG",
      project: null,
      withoutProject: false,
      labels: [],
      ...partial,
    });
    const saveMatch = (repositoryId: string, partial: Partial<WorkItemMatchFields> = {}) =>
      saveWorkItemMatch(state.db, {
        organizationId: state.orgId,
        repositoryId,
        userId: null,
        match: fields(partial),
      });

    it("routes by the saved matches after the rules", async () => {
      await saveMatch(api, { labels: ["backend"] });
      linear.add({ identifier: "ENG-1", title: "API", labels: ["Backend"] });
      expect((await test("ENG-1", [])).body).toEqual({
        issue: { identifier: "ENG-1", title: "API" },
        outcome: "repository",
        repository: { id: api, fullPath: "acme/api", provider: "github" },
        matched: "match",
        rule: null,
        by: "work item match (Team is ENG, label backend)",
        run: null,
      } satisfies RoutingTestResult);
      // A rule that matches comes first.
      expect((await test("ENG-1", [[web, labelsInclude("backend")]])).body).toMatchObject({
        matched: "rule",
        repository: { id: web },
      });
    });

    it("applies an unsaved match, replacing or clearing its repo's saved one, and saves nothing", async () => {
      await saveMatch(api, {});
      linear.add({ identifier: "ENG-1", title: "UI", labels: ["frontend"] });
      const withUnsaved = await post({
        identifier: "ENG-1",
        rules: [],
        workItemMatch: {
          repositoryId: web,
          match: { tracker: "linear", team: "eng", labels: ["frontend"] },
        },
      });
      expect(withUnsaved.body).toMatchObject({
        outcome: "repository",
        repository: { id: web },
        matched: "match",
        by: "work item match (Team is eng, label frontend)",
      });
      // Replacing api's own match with one for another team leaves nothing to match.
      const replaced = await post({
        identifier: "ENG-1",
        rules: [],
        workItemMatch: { repositoryId: api, match: { tracker: "linear", team: "OPS" } },
      });
      expect(replaced.body).toMatchObject({ outcome: "ask", matched: "default", by: null });
      const cleared = await post({
        identifier: "ENG-1",
        rules: [],
        workItemMatch: { repositoryId: api, match: null },
      });
      expect(cleared.body).toMatchObject({ outcome: "ask", matched: "default" });
      expect(await state.db.select().from(workItemMatches)).toEqual([
        expect.objectContaining({ repositoryId: api, team: "ENG", labels: [] }),
      ]);
    });

    it("applies an unsaved match after the saved rules when the body leaves them out", async () => {
      await setRoutingRules(state.db, state.orgId, [api, labelsInclude("backend")]);
      linear.add({ identifier: "ENG-1", title: "API", labels: ["backend"] });
      linear.add({ identifier: "ENG-2", title: "UI", labels: ["frontend"] });
      const unsaved = {
        repositoryId: web,
        match: { tracker: "linear", team: "ENG", labels: ["frontend", "backend"] },
      };
      // The saved rule comes first.
      expect((await post({ identifier: "ENG-1", workItemMatch: unsaved })).body).toMatchObject({
        matched: "rule",
        repository: { id: api },
      });
      expect((await post({ identifier: "ENG-2", workItemMatch: unsaved })).body).toMatchObject({
        matched: "match",
        repository: { id: web },
        by: "work item match (Team is ENG, any label of frontend, backend)",
      });
    });

    it("asks on a tie, naming the tied repos", async () => {
      await saveMatch(api, { labels: ["backend"] });
      linear.add({ identifier: "ENG-1", title: "Both", labels: ["backend", "docs"] });
      const { body } = await post({
        identifier: "ENG-1",
        rules: [],
        workItemMatch: {
          repositoryId: docs,
          match: { tracker: "linear", team: "ENG", labels: ["docs"] },
        },
      });
      expect(body).toEqual({
        issue: { identifier: "ENG-1", title: "Both" },
        outcome: "ask",
        repository: null,
        matched: "match",
        rule: null,
        by: "work item matches of acme/api, acme/docs tie",
        run: null,
      } satisfies RoutingTestResult);
    });

    it("validates the unsaved match", async () => {
      linear.add({ identifier: "ENG-1", title: "UI" });
      const invalid = await post({
        identifier: "ENG-1",
        rules: [],
        workItemMatch: { repositoryId: web, match: { tracker: "linear", team: "" } },
      });
      expect(invalid.status).toBe(400);
      expect(invalid.body.fieldErrors).toEqual({
        "workItemMatch.match.team": "Enter the team's key, e.g. ENG.",
      });
    });
  });

  it("answers 404 for an unknown issue and 409 without Linear", async () => {
    const unknown = await test("ENG-404", []);
    expect(unknown).toEqual({
      status: 404,
      body: { error: unknownIssueMessage("ENG-404", "Linear"), code: "not_found" },
    });
    state.linear = null;
    expect((await test("ENG-1", [])).status).toBe(409);
  });

  it("validates the identifier and the rules as a save does", async () => {
    expect((await test("  ", [])).body.fieldErrors).toEqual({
      identifier: "Enter an issue identifier, e.g. ENG-12.",
    });
    const invalid = await post({
      identifier: "ENG-1",
      rules: [{ repositoryId: web, query: { combinator: "and", rules: [{ field: "nope" }] } }],
    });
    expect(invalid.status).toBe(400);
    expect(Object.keys(invalid.body.fieldErrors as object)[0]).toMatch(/^rules\.0\.query/);
  });

  it(`is rate-limited to ${ROUTING_TEST_LIMIT} tests a minute per user`, async () => {
    // Mid-window, so the loop doesn't straddle two.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-18T12:00:20Z") });
    linear.add({ identifier: "ENG-1", title: "UI" });
    for (let i = 0; i < ROUTING_TEST_LIMIT; i++) {
      expect((await test("ENG-1", [])).status).toBe(200);
    }
    const limited = await test("ENG-1", []);
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("rate_limited");
    // Another user isn't.
    state.userId = "user-2";
    expect((await test("ENG-1", [])).status).toBe(200);
    vi.useRealTimers();
  });

  describe("gives the same outcome as delegating the issue", () => {
    const deps = (): StartRunDeps => ({
      db: state.db,
      organizationId: state.orgId,
      tracker: linear,
      dispatcher: new PostgresDispatcher({ db: state.db }),
      adapterFor: () => ({ getDefaultBranch: async () => "main" }) as unknown as ScmAdapter,
    });

    /** Saves `rules`, tests `identifier` against the same list, and delegates it. */
    const both = async (identifier: string, rules: Rules) => {
      await setRoutingRules(state.db, state.orgId, ...rules);
      const tested = (await test(identifier, rules)).body as RoutingTestResult;
      sessions += 1;
      const sessionId = `session-${sessions}`;
      const issue = linear.issues.values().find((i) => i.identifier === identifier)!;
      const outcome = await startRun(
        {
          kind: "issue_delegated",
          sessionId,
          issueId: issue.id,
          commentBody: `${AGENT_SESSION_MARKER}. Delegated by Steve.`,
        },
        deps(),
      );
      const run = await getRunBySession(state.db, sessionId);
      return { tested, outcome, run };
    };

    const rules = (): Rules => [
      [web, labelsInclude("frontend")],
      [docs, labelsInclude("docs")],
      [api, titleIs("Source")],
    ];

    it("for a custom match", async () => {
      linear.add({ identifier: "ENG-1", title: "UI", labels: ["frontend"] });
      const { tested, outcome, run } = await both("ENG-1", rules());
      expect(outcome).toMatchObject({ status: "started" });
      expect(tested).toMatchObject({ outcome: "repository", rule: { kind: "custom", number: 1 } });
      expect(run).toMatchObject({ repositoryId: tested.repository!.id, routedBy: tested.by });
    });

    it("for a sub-issue", async () => {
      // Delegating a sub-issue runs its parent, routed the same way the sub-issue is.
      const epic = linear.add({ identifier: "ENG-10", title: "Epic", labels: ["frontend"] });
      linear.add({ identifier: "ENG-11", title: "Story", parentId: epic.id });
      const { tested, outcome, run } = await both("ENG-11", rules());
      expect(outcome).toMatchObject({ status: "started" });
      expect(tested).toMatchObject({ outcome: "repository", rule: { kind: "default", number: 2 } });
      expect(tested.by).toBe(`sub-issue of ENG-10 → ${run!.routedBy}`);
      expect(run).toMatchObject({ repositoryId: tested.repository!.id });
    });

    it("for a follow-up", async () => {
      const source = linear.add({ identifier: "ENG-20", title: "Source" });
      const followUp = linear.add({ identifier: "ENG-21", title: "Follow-up" });
      await recordFollowUpSource(state.db, state.orgId, followUp.id, source.id);
      const { tested, outcome, run } = await both("ENG-21", rules());
      expect(outcome).toMatchObject({ status: "started" });
      expect(tested).toMatchObject({
        outcome: "repository",
        repository: { id: api },
        matched: "default",
        rule: { kind: "default", number: 1 },
        by: "follow-up of ENG-20 → rule 3 (Title equals Source)",
      });
      expect(run).toMatchObject({ repositoryId: tested.repository!.id, routedBy: tested.by });
    });

    it("for a manual route", async () => {
      linear.add({ identifier: "ENG-30", title: "Docs", labels: ["docs"] });
      const { tested, outcome, run } = await both("ENG-30", rules());
      expect(tested).toMatchObject({ outcome: "manual", rule: { kind: "custom", number: 2 } });
      expect(outcome).toEqual({ status: "manual", repository: tested.repository!.fullPath });
      expect(run).toBeNull();
    });

    it("when it would ask", async () => {
      linear.add({ identifier: "OPS-1", title: "Infra", teamKey: "OPS" });
      const { tested, outcome, run } = await both("OPS-1", rules());
      expect(tested).toMatchObject({ outcome: "ask", rule: { kind: "default", number: 3 } });
      expect(outcome).toMatchObject({ status: "selecting" });
      expect(run).toMatchObject({ repositoryId: null, routedBy: null });
    });
  });
});
