import { randomBytes, randomUUID } from "node:crypto";
import {
  addMember,
  closeDb,
  connectRepository,
  createDb,
  createOrganization,
  ralphRuns,
  saveIntegration,
  saveWorkItemMatch,
  setIntegrationStateMapping,
  setWorkItemRepository,
  triageRuns,
  upsertScmConnection,
  users,
  type Database,
  type TrackerStateMapping,
  type WorkItemMatchFields,
} from "@omniralph/db";
import type * as Db from "@omniralph/db";
import {
  createTestDatabase,
  setCodingEnabled,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { captureChanges } from "@omniralph/db/changes";
import { QueryClient } from "@tanstack/react-query";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backlogCountsSchema,
  backlogSchema,
  backlogUpNextSchema,
  type Backlog,
  type BacklogCounts,
  type BacklogUpNext,
} from "@/lib/api/backlog";
import { backlogKeys, queryKeys } from "@/lib/api/keys";
import { workItemRowSchema, type WorkItemRow } from "@/lib/api/work-items";
import { assertRole, type Role } from "@/lib/auth/roles";
import type * as LinearClient from "@/lib/tracker/linear/client";
import { FakeLinearGateway } from "@omniralph/tracker/linear/testing";
import type { IssueSummary, WorkflowState } from "@omniralph/tracker";
import { signBody } from "@omniralph/tracker/linear";
import { parseChangeEvent } from "@/lib/live/events";
import { createLiveInvalidator } from "@/lib/live/invalidations";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: "backlog-user",
  orgId: "",
  orgName: "Acme",
  /** Each organization's Linear workspace (else none is connected). */
  linear: new Map<string, FakeLinearGateway>(),
  /** Calls of `latestTriageSizes`. */
  sizeQueries: 0,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") =>
    assertRole(
      {
        id: state.userId,
        role: "member",
        name: "Ada",
        email: null,
        image: null,
        organization: { id: state.orgId, name: state.orgName },
      },
      role,
    ),
}));
vi.mock("@/lib/tracker/linear/client", async (importOriginal) => {
  const actual = await importOriginal<typeof LinearClient>();
  return {
    ...actual,
    getLinearGateway: async (options: LinearClient.LinearGatewayOptions) => {
      const gateway = state.linear.get(options.organizationId);
      if (!gateway) throw new actual.LinearNotConnectedError();
      return gateway;
    },
  };
});
vi.mock("@omniralph/db", async (importOriginal) => {
  const actual = await importOriginal<typeof Db>();
  return {
    ...actual,
    latestTriageSizes: (...args: Parameters<typeof actual.latestTriageSizes>) => {
      state.sizeQueries += 1;
      return actual.latestTriageSizes(...args);
    },
  };
});

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const list = await import("./route");
const counts = await import("./counts/route");
const upNext = await import("./up-next/route");
const { dropBacklogCache, resetBacklogCache } = await import("@/lib/work-items/backlog-cache");
const { BACKLOG_CANDIDATE_CAP, TRACKER_UNAVAILABLE_REASON } =
  await import("@/lib/work-items/backlog");
const { handleLinearWebhook } = await import("@/lib/tracker/linear/ingest");
const { changeMessage } = await import("@/lib/live/publisher");

type Handler = (
  request: Request,
  route: { params: Promise<Record<string, string>> },
) => Promise<Response>;

async function call<T>(
  handler: Handler,
  search: Record<string, string> = {},
): Promise<{ status: number; body: T }> {
  const response = await handler(
    new Request(`http://localhost/api/ui/backlog?${new URLSearchParams(search)}`),
    { params: Promise.resolve({}) },
  );
  return { status: response.status, body: (await response.json()) as T };
}

const getBacklog = async (search: Record<string, string> = {}) => {
  const response = await call<Backlog>(list.GET, search);
  expect(response.status).toBe(200);
  return backlogSchema.parse(response.body);
};
const identifiers = (rows: WorkItemRow[]) => rows.map((row) => row.identifier);

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("GET /api/ui/backlog", () => {
  let testDb: TestDatabase;
  let db: Database;
  const orgs: Record<string, string> = {};
  const repos: Record<string, string> = {};
  let acme: FakeLinearGateway;
  const items: Record<string, IssueSummary> = {};

  /** An organization (the user a member of it unless `member` is false), with a code host. */
  const organization = async (name: string, member = true) => {
    const org = await createOrganization(db, { name, createdBy: "backlog-owner" });
    if (member) {
      expect(
        await addMember(db, { organizationId: org.id, userId: state.userId, role: "member" }),
      ).toBe("added");
    }
    orgs[name] = org.id;
    return org.id;
  };

  /** A connected repo (Coding on unless `coding` is false) with a work item match. */
  const repo = async (
    orgId: string,
    fullPath: string,
    match: Partial<WorkItemMatchFields>,
    coding = true,
  ) => {
    const connection = (await upsertScmConnection(
      db,
      {
        organizationId: orgId,
        provider: "github",
        name: fullPath,
        baseUrl: "https://api.github.com",
        externalId: `installation-${fullPath}`,
        credentials: {},
      },
      randomBytes(32),
    ))!;
    const { id } = await connectRepository(db, {
      connectionId: connection.id,
      provider: "github",
      externalId: fullPath,
      fullPath,
    });
    const saved = await saveWorkItemMatch(db, {
      organizationId: orgId,
      repositoryId: id,
      userId: null,
      match: {
        tracker: "linear",
        team: "ENG",
        project: null,
        withoutProject: false,
        labels: [],
        ...match,
      },
    });
    expect(saved).not.toBeNull();
    await setCodingEnabled(db, id, coding);
    repos[fullPath] = id;
    return id;
  };

  /** Connects a Linear workspace to the organization. */
  const connectLinear = async (orgId: string, gateway: FakeLinearGateway) => {
    const integration = await saveIntegration(db, {
      organizationId: orgId,
      provider: "linear",
      externalId: `workspace-${orgId}`,
      name: "Workspace",
      credentials: { accessToken: "t" },
      installedByUserId: null,
    });
    if (integration === "other_organization") throw new Error("setup");
    state.linear.set(orgId, gateway);
    return integration;
  };

  const sized = async (orgId: string, issueId: string, size: string) => {
    await db.insert(triageRuns).values({
      organizationId: orgId,
      linearIssueId: issueId,
      linearAgentSessionId: `triage-${randomUUID()}`,
      trigger: "label",
      status: "completed",
      lastResult: {
        summary: "s",
        error: null,
        outcome: { outcome: "prd", size, openQuestions: [] },
      },
    });
  };

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    await db.insert(users).values([{ id: "backlog-owner" }, { id: state.userId }]);

    // Acme: every kind of candidate.
    state.orgId = await organization("Acme");
    await repo(orgs.Acme!, "acme/api", {});
    await repo(orgs.Acme!, "acme/web", { labels: ["frontend"] });
    await repo(orgs.Acme!, "acme/app", { project: "Portal" });
    await repo(orgs.Acme!, "acme/docs", { labels: ["docs"] }, false);
    acme = new FakeLinearGateway();
    acme.projects = [{ id: "project-portal", name: "Portal" }];
    await connectLinear(orgs.Acme!, acme);
    const ready = (title: string, partial: Partial<IssueSummary> = {}) =>
      acme.add({ title, stateType: "unstarted", stateName: "Todo", ...partial });
    const refine = (title: string, partial: Partial<IssueSummary> = {}) =>
      acme.add({ title, stateType: "backlog", stateName: "Backlog", ...partial });
    items.olderHigh = ready("Older high", { identifier: "ENG-1", priority: 2 });
    items.urgent = ready("Urgent", { identifier: "ENG-2", priority: 1 });
    items.recentHigh = ready("Recent high", { identifier: "ENG-3", priority: 2 });
    items.none = ready("No priority, chosen", { identifier: "ENG-4", priority: 0 });
    items.tie = ready("Tie", {
      identifier: "ENG-5",
      priority: 3,
      labels: ["frontend"],
      projectName: "Portal",
    });
    items.refineOld = refine("Refine old", { identifier: "ENG-6", priority: 0 });
    items.refine = refine("Refine", { identifier: "ENG-7", priority: 0 });
    items.refineBlocked = refine("Refine blocked", { identifier: "ENG-8", priority: 4 });
    items.blocker = acme.add({ identifier: "ENG-9", title: "Blocker", stateType: "started" });
    acme.blocks.set(items.refineBlocked.id, [items.blocker.id]);
    items.withRun = ready("Has a run", { identifier: "ENG-10", priority: 1 });
    items.sub = ready("Sub-issue", { identifier: "ENG-11", parentId: items.urgent.id });
    items.otherAgent = ready("Another agent's", { identifier: "ENG-12", delegateId: "agent-x" });
    items.canceled = acme.add({
      identifier: "ENG-13",
      title: "Canceled",
      stateType: "canceled",
      stateName: "Canceled",
    });
    items.docs = ready("Docs", { identifier: "ENG-14", labels: ["docs"] });

    await db.insert(ralphRuns).values({
      organizationId: orgs.Acme!,
      linearIssueId: items.withRun.id,
      linearIdentifier: "ENG-10",
      linearAgentSessionId: "session-with-run",
      kind: "children",
      status: "completed",
    });
    await setWorkItemRepository(db, {
      organizationId: orgs.Acme!,
      tracker: "linear",
      externalId: items.none.id,
      repositoryId: repos["acme/web"]!,
      userId: null,
    });
    await sized(orgs.Acme!, items.urgent.id, "XS");
    await sized(orgs.Acme!, items.recentHigh.id, "S");
    await sized(orgs.Acme!, items.olderHigh.id, "M");
    await sized(orgs.Acme!, items.tie.id, "L");
    await sized(orgs.Acme!, items.refine.id, "XL");

    // Other (a member): one ready item.
    await organization("Other");
    await repo(orgs.Other!, "other/api", {});
    const other = new FakeLinearGateway();
    other.teams = [{ id: "team-other", key: "ENG", name: "Engineering" }];
    other.add({ identifier: "OTH-1", title: "Other ready", teamId: "team-other" });
    await connectLinear(orgs.Other!, other);

    // Foreign: the user isn't a member.
    await organization("Foreign", false);
    await repo(orgs.Foreign!, "foreign/api", {});
    const foreign = new FakeLinearGateway();
    foreign.add({ identifier: "FOR-1", title: "Foreign ready", teamId: "team-foreign" });
    await connectLinear(orgs.Foreign!, foreign);

    // Mapped: Ready to start is the "Selected" state, not Todo.
    await organization("Mapped");
    await repo(orgs.Mapped!, "mapped/api", {});
    const mapped = new FakeLinearGateway();
    mapped.teams = [{ id: "team-mapped", key: "ENG", name: "Engineering" }];
    const states: WorkflowState[] = [
      { id: "mapped-backlog", name: "Backlog", type: "backlog", position: 0 },
      { id: "mapped-todo", name: "Todo", type: "unstarted", position: 1 },
      { id: "mapped-selected", name: "Selected", type: "unstarted", position: 2 },
      { id: "mapped-started", name: "In Progress", type: "started", position: 3 },
    ];
    mapped.workflowStatesByTeam.set("team-mapped", states);
    const base = { teamId: "team-mapped", stateType: "unstarted" as const };
    mapped.add({
      ...base,
      identifier: "MAP-1",
      title: "Selected",
      stateId: "mapped-selected",
      stateName: "Selected",
    });
    mapped.add({ ...base, identifier: "MAP-2", title: "Todo", stateId: "mapped-todo" });
    const integration = await connectLinear(orgs.Mapped!, mapped);
    const mapping: TrackerStateMapping = {
      ready: { types: ["unstarted"] },
      needsRefining: { types: ["backlog"] },
      teams: { "team-mapped": { ready: ["mapped-selected"], needsRefining: ["mapped-backlog"] } },
    };
    await setIntegrationStateMapping(db, integration.id, mapping);

    // Broken: Linear fails. Bare: no Linear.
    await organization("Broken");
    await repo(orgs.Broken!, "broken/api", {});
    const broken = new FakeLinearGateway();
    broken.add({ identifier: "BRK-1", title: "Unreadable" });
    broken.failures.set("listIssues", new Error("Linear is down: secret detail"));
    await connectLinear(orgs.Broken!, broken);
    await organization("Bare");
    await repo(orgs.Bare!, "bare/api", {});
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(() => {
    resetBacklogCache();
    state.sizeQueries = 0;
  });

  it("lists the active organization's work items that route to a repo with Coding on, by group and order", async () => {
    const backlog = await getBacklog();
    for (const row of [...backlog.groups.readyToStart, ...backlog.groups.needsRefining]) {
      expect(workItemRowSchema.strict().parse(row)).toEqual(row);
      expect(row.organization).toEqual({ id: orgs.Acme, name: "Acme", role: "member" });
    }
    // Priority (Urgent first, No priority last), then most recently updated.
    expect(identifiers(backlog.groups.readyToStart)).toEqual([
      "ENG-2",
      "ENG-3",
      "ENG-1",
      "ENG-5",
      "ENG-4",
    ]);
    expect(identifiers(backlog.groups.needsRefining)).toEqual(["ENG-8", "ENG-7", "ENG-6"]);
    const byIdentifier = new Map(
      [...backlog.groups.readyToStart, ...backlog.groups.needsRefining].map((row) => [
        row.identifier,
        row,
      ]),
    );
    expect(byIdentifier.get("ENG-2")).toEqual({
      id: `linear-${items.urgent!.id}`,
      tracker: "linear",
      identifier: "ENG-2",
      title: "Urgent",
      url: items.urgent!.url,
      organization: { id: orgs.Acme, name: "Acme", role: "member" },
      repository: { id: repos["acme/api"], provider: "github", fullPath: "acme/api" },
      size: "XS",
      group: "ready",
      blocked: false,
      blockers: [],
      triageRunning: false,
      source: { kind: "team", id: "team-1", name: "ENG" },
    });
    // Two matches tie: no repo yet.
    expect(byIdentifier.get("ENG-5")).toMatchObject({
      repository: null,
      source: { kind: "project", id: "project-portal", name: "Portal" },
    });
    // A member's choice (Change repo…) wins over the match.
    expect(byIdentifier.get("ENG-4")!.repository).toMatchObject({ id: repos["acme/web"] });
    expect(byIdentifier.get("ENG-8")).toMatchObject({
      group: "refine",
      blocked: true,
      blockers: ["ENG-9"],
    });
    expect(byIdentifier.get("ENG-7")).toMatchObject({ group: "refine", blocked: false });
    expect(backlog.unavailable).toEqual([]);
    expect(backlog.truncated).toBe(false);
  });

  it("marks the items Om is triaging (a triage queued or running)", async () => {
    const [run] = await db
      .insert(triageRuns)
      .values({
        organizationId: orgs.Acme!,
        linearIssueId: items.refine!.id,
        linearAgentSessionId: `triage-${randomUUID()}`,
        trigger: "label",
        status: "running",
      })
      .returning();
    try {
      const { groups } = await getBacklog();
      const triaging = [...groups.readyToStart, ...groups.needsRefining]
        .filter((row) => row.triageRunning)
        .map((row) => row.identifier);
      expect(triaging).toEqual(["ENG-7"]);
    } finally {
      await db.delete(triageRuns).where(eq(triageRuns.id, run!.id));
    }
  });

  it("returns sizes as triage gave them, from one query per fill", async () => {
    const { groups } = await getBacklog();
    const sizes = Object.fromEntries(
      [...groups.readyToStart, ...groups.needsRefining].map((row) => [row.identifier, row.size]),
    );
    expect(sizes).toEqual({
      "ENG-2": "XS",
      "ENG-3": "S",
      "ENG-1": "M",
      "ENG-5": "L",
      "ENG-7": "XL",
      "ENG-4": null,
      "ENG-6": null,
      "ENG-8": null,
    });
    expect(state.sizeQueries).toBe(1);
  });

  it("lists by the state mapping only: a non-default Ready state is Ready, Todo isn't listed", async () => {
    const backlog = await getBacklog({ organization: orgs.Mapped! });
    expect(identifiers(backlog.groups.readyToStart)).toEqual(["MAP-1"]);
    expect(backlog.groups.needsRefining).toEqual([]);
  });

  it("combines the source and repo filters, lists the unfiltered values, and matches nothing for unknown values", async () => {
    const team = "linear:team:team-1";
    const project = "linear:project:project-portal";
    const unfiltered = await getBacklog();
    expect(unfiltered.filters).toEqual({
      sources: [
        { kind: "team", id: "team-1", name: "ENG", value: team, tracker: "linear" },
        {
          kind: "project",
          id: "project-portal",
          name: "Portal",
          value: project,
          tracker: "linear",
        },
      ],
      repos: [
        { value: repos["acme/api"], provider: "github", fullPath: "acme/api" },
        { value: repos["acme/web"], provider: "github", fullPath: "acme/web" },
      ],
    });
    const filtered = async (search: Record<string, string>) => {
      const backlog = await getBacklog(search);
      expect(backlog.filters).toEqual(unfiltered.filters);
      return [
        ...identifiers(backlog.groups.readyToStart),
        ...identifiers(backlog.groups.needsRefining),
      ];
    };
    expect(await filtered({ source: project })).toEqual(["ENG-5"]);
    expect(await filtered({ repo: repos["acme/web"]! })).toEqual(["ENG-4"]);
    expect(await filtered({ source: team, repo: repos["acme/api"]! })).toEqual([
      "ENG-2",
      "ENG-3",
      "ENG-1",
      "ENG-8",
      "ENG-7",
      "ENG-6",
    ]);
    expect(await filtered({ source: project, repo: repos["acme/api"]! })).toEqual([]);
    expect(await filtered({ source: "linear:team:nope" })).toEqual([]);
    expect(await filtered({ repo: randomUUID() })).toEqual([]);
  });

  it("counts the groups and answers Up next in list order", async () => {
    const countsResponse = await call<BacklogCounts>(counts.GET);
    expect(countsResponse.status).toBe(200);
    expect(backlogCountsSchema.parse(countsResponse.body)).toEqual({
      readyToStart: 5,
      needsRefining: 3,
      total: 8,
    });
    const next = await call<BacklogUpNext>(upNext.GET);
    expect(next.status).toBe(200);
    const parsed = backlogUpNextSchema.parse(next.body);
    expect(identifiers(parsed.readyToStart)).toEqual(["ENG-2", "ENG-3", "ENG-1"]);
    expect(identifiers(parsed.needsRefining)).toEqual(["ENG-8", "ENG-7"]);
  });

  it("reads Linear once per organization per cache fill, for the list, counts and Up next", async () => {
    acme.issueLists = [];
    await getBacklog();
    await call(counts.GET);
    await call(upNext.GET);
    await getBacklog({ source: "linear:team:team-1" });
    expect(acme.issueLists).toHaveLength(1);
    expect(acme.issueLists[0]).toMatchObject({ teamKey: "ENG", withRoutingFields: true });
    // Routing the page asked Linear nothing more.
    expect(acme.routingLoads).toEqual([]);
    expect(state.sizeQueries).toBe(1);
    await dropBacklogCache(orgs.Acme!);
    await call(counts.GET);
    expect(acme.issueLists).toHaveLength(2);
    expect(state.sizeQueries).toBe(2);
  });

  it("spans every membership with organization=all, skips one without Linear and reports one whose Linear fails", async () => {
    const backlog = await getBacklog({ organization: "all" });
    const rows = [...backlog.groups.readyToStart, ...backlog.groups.needsRefining];
    expect(new Set(rows.map((row) => row.organization.id))).toEqual(
      new Set([orgs.Acme, orgs.Other, orgs.Mapped]),
    );
    expect(identifiers(rows)).toContain("OTH-1");
    expect(identifiers(rows)).not.toContain("FOR-1");
    expect(JSON.stringify(backlog)).not.toContain(orgs.Foreign);
    expect(backlog.unavailable).toEqual([
      {
        organization: { id: orgs.Broken, name: "Broken", role: "member" },
        tracker: "linear",
        reason: TRACKER_UNAVAILABLE_REASON,
      },
    ]);
    expect(JSON.stringify(backlog)).not.toContain("secret detail");
    const all = (await call<BacklogCounts>(counts.GET, { organization: "all" })).body;
    expect(all.total).toBe(rows.length);
    // A failure isn't cached: once Linear answers, the organization loads.
    state.linear.get(orgs.Broken!)!.failures.delete("listIssues");
    const recovered = await getBacklog({ organization: orgs.Broken! });
    expect(identifiers(recovered.groups.readyToStart)).toEqual(["BRK-1"]);
    expect(recovered.unavailable).toEqual([]);
    state.linear.get(orgs.Broken!)!.failures.set("listIssues", new Error("down"));
  });

  it("says why a list may be empty: no Linear, nothing picks up work items, or ready", async () => {
    expect((await getBacklog()).setup).toBe("ready");
    expect((await getBacklog({ organization: orgs.Bare! })).setup).toBe("no_tracker");
    // A failed tracker is connected: its notice explains the gap, not an empty state.
    expect((await getBacklog({ organization: orgs.Broken! })).setup).toBe("ready");
    expect((await getBacklog({ organization: "all" })).setup).toBe("ready");

    const orgId = await organization("Unmatched");
    await repo(orgId, "unmatched/api", {}, false);
    const unmatched = new FakeLinearGateway();
    unmatched.add({ identifier: "UNM-1", title: "Nobody picks this up" });
    await connectLinear(orgId, unmatched);
    const backlog = await getBacklog({ organization: orgId });
    expect(backlog.setup).toBe("no_work_item_match");
    expect(backlog.groups).toEqual({ readyToStart: [], needsRefining: [] });
    expect(unmatched.issueLists).toEqual([]);
  });

  it("answers 404 for an organization the user isn't a member of", async () => {
    for (const handler of [list.GET, counts.GET, upNext.GET]) {
      expect((await call(handler, { organization: orgs.Foreign! })).status).toBe(404);
      expect((await call(handler, { organization: randomUUID() })).status).toBe(404);
    }
  });

  it(`cuts an organization's list at ${BACKLOG_CANDIDATE_CAP} candidates`, async () => {
    const orgId = await organization("Big");
    await repo(orgId, "big/api", {});
    const big = new FakeLinearGateway();
    for (let i = 0; i <= BACKLOG_CANDIDATE_CAP; i += 1) big.add({ title: `Item ${i}` });
    await connectLinear(orgId, big);
    const backlog = await getBacklog({ organization: orgId });
    expect(backlog.truncated).toBe(true);
    expect(backlog.truncatedOrganizations).toEqual([{ id: orgId, name: "Big", role: "member" }]);
    expect(backlog.groups.readyToStart.length).toBeLessThanOrEqual(BACKLOG_CANDIDATE_CAP);
    expect(big.issueLists.length).toBe(BACKLOG_CANDIDATE_CAP / 50);
    // A list within the cap isn't cut.
    expect((await getBacklog()).truncated).toBe(false);
  }, 60_000);

  it("shows an item triaged to Todo in Ready to start within 5 seconds of Linear's Issue webhook, without a refresh", async () => {
    const orgId = await organization("Live");
    await repo(orgId, "live/api", {});
    const live = new FakeLinearGateway();
    const idea = live.add({
      identifier: "LIV-1",
      title: "Rough idea",
      stateType: "backlog",
      stateName: "Backlog",
    });
    await connectLinear(orgId, live);
    const scope = { organization: orgId };
    const before = await getBacklog(scope);
    expect(identifiers(before.groups.needsRefining)).toEqual(["LIV-1"]);
    expect(before.groups.readyToStart).toEqual([]);

    // The page's queries, as the browser holds them.
    const backlog = backlogKeys(queryKeys(orgId));
    const client = new QueryClient();
    const views = [backlog.list({}, orgId), backlog.counts(orgId), backlog.upNext(orgId)];
    for (const key of views) client.setQueryData(key, {});
    const invalidator = createLiveInvalidator(client);

    // Triage finishes in Linear: the item moves to Todo. The cached Backlog still has it in
    // Needs refining until Linear tells us.
    await live.setIssueState(idea.id, { type: "unstarted" });
    expect(identifiers((await getBacklog(scope)).groups.needsRefining)).toEqual(["LIV-1"]);

    const webhookAt = Date.now();
    const body = JSON.stringify({
      type: "Issue",
      action: "update",
      organizationId: `workspace-${orgId}`,
      webhookTimestamp: webhookAt,
      data: { id: idea.id, identifier: "LIV-1" },
      updatedFrom: { stateId: "state-backlog" },
    });
    const { result, changes } = await captureChanges(() =>
      handleLinearWebhook(
        new Request("https://omniralph.example.com/api/webhooks/linear", {
          method: "POST",
          headers: {
            "linear-signature": signBody(body, "secret"),
            "linear-delivery": randomUUID(),
          },
          body,
        }),
        { db, secret: "secret", handle: async () => {} },
      ),
    );
    expect(result.status).toBe(200);

    // The published event names the work item, by ID only.
    const messages = changes.map(changeMessage);
    const message = messages.find((m) => m.event.resource === "work_item");
    expect(message).toMatchObject({
      channel: `org:${orgId}:changes`,
      event: { resource: "work_item", organizationId: orgId, ids: [`linear-${idea.id}`] },
    });
    // The browser invalidates the Backlog list, counts and Up next.
    const event = parseChangeEvent(JSON.parse(JSON.stringify(message!.event)));
    expect(event).not.toBeNull();
    invalidator.apply(event!, new Set([orgId]));
    for (const key of views) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    invalidator.dispose();

    // Their refetch lists it in Ready to start.
    const after = await getBacklog(scope);
    expect(identifiers(after.groups.readyToStart)).toEqual(["LIV-1"]);
    expect(after.groups.needsRefining).toEqual([]);
    const counted = await call<BacklogCounts>(counts.GET, scope);
    expect(backlogCountsSchema.parse(counted.body)).toEqual({
      readyToStart: 1,
      needsRefining: 0,
      total: 1,
    });
    expect(Date.now() - webhookAt).toBeLessThan(5_000);
  });
});
