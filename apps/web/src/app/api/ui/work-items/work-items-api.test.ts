import { randomBytes, randomUUID } from "node:crypto";
import {
  addMember,
  closeDb,
  connectRepository,
  createDb,
  createOrganization,
  createTriageRun,
  getRunBySession,
  getWorkItemOverride,
  listWorkItemEvents,
  ralphRuns,
  replaceRoutingRules,
  saveIntegration,
  saveWorkItemMatch,
  setIntegrationStateMapping,
  setWorkItemRepository,
  triageRuns,
  upsertScmConnection,
  users,
  workItemUrlId,
  type Database,
  type WorkItemMatchFields,
} from "@omniralph/db";
import { captureChanges } from "@omniralph/db/changes";
import {
  createTestDatabase,
  setCodingEnabled,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import type { ScmAdapter } from "@omniralph/scm";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { workItemDetailSchema, type WorkItemDetail } from "@/lib/api/work-items";
import { assertRole, type Role } from "@/lib/auth/roles";
import { PostgresDispatcher } from "@/lib/dispatch/dispatcher";
import type * as LinearClient from "@/lib/linear/client";
import { handleLinearEvent } from "@/lib/linear/events";
import { FakeLinearGateway } from "@/lib/linear/fake-gateway";
import type { IssueSummary } from "@/lib/linear/gateway";
import { handleLinearWebhook } from "@/lib/linear/ingest";
import { signBody } from "@/lib/linear/webhook";
import { AGENT_SESSION_MARKER } from "@/lib/ralph/start";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: "wi-member",
  orgId: "",
  /** Each organization's Linear workspace. */
  linear: new Map<string, FakeLinearGateway>(),
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") =>
    assertRole(
      {
        id: state.userId,
        role: "member",
        name: "Steve McMaster",
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
    getLinearGateway: async (options: LinearClient.LinearGatewayOptions) => {
      const gateway = state.linear.get(options.organizationId);
      if (!gateway) throw new actual.LinearNotConnectedError();
      return gateway;
    },
  };
});

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const detailRoute = await import("./[id]/route");
const prdRoute = await import("./[id]/prd/route");
const startRoute = await import("./[id]/start/route");
const triageRoute = await import("./[id]/triage/route");
const repositoryRoute = await import("./[id]/repository/route");
const moveRoute = await import("./[id]/move/route");
const cancelRoute = await import("./[id]/cancel/route");
const backlogRoute = await import("../backlog/route");
const { hasCachedBacklog, resetBacklogCache } = await import("@/lib/work-items/backlog-cache");

type Handler = (request: Request, route: { params: Promise<{ id: string }> }) => Promise<Response>;

async function call<T = Record<string, unknown>>(
  handler: Handler,
  id: string,
  options: { method?: string; body?: unknown; query?: string } = {},
): Promise<{ status: number; body: T }> {
  const response = await handler(
    new Request(`http://localhost/api/ui/work-items/${id}${options.query ?? ""}`, {
      method: options.method ?? "GET",
      ...(options.body !== undefined && {
        body: JSON.stringify(options.body),
        headers: { "content-type": "application/json" },
      }),
    }),
    { params: Promise.resolve({ id }) },
  );
  return { status: response.status, body: (await response.json()) as T };
}

const databaseAvailable = testDatabaseAvailable();
const WORKSPACE = "acme-workspace";
const SECRET = "linear-webhook-secret";

describe.skipIf(!databaseAvailable)("/api/ui/work-items/{id}", () => {
  let testDb: TestDatabase;
  let db: Database;
  let acme: FakeLinearGateway;
  let integrationId: string;
  const repos: Record<string, string> = {};
  let otherRepo: string;

  const urlId = (issue: Pick<IssueSummary, "id">) => workItemUrlId("linear", issue.id);
  const key = (issue: Pick<IssueSummary, "id">) => ({
    organizationId: state.orgId,
    tracker: "linear" as const,
    externalId: issue.id,
  });
  const ready = (title: string, partial: Partial<IssueSummary> = {}) =>
    acme.add({ title, stateType: "unstarted", stateName: "Todo", ...partial });
  const refine = (title: string, partial: Partial<IssueSummary> = {}) =>
    acme.add({ title, stateType: "backlog", stateName: "Backlog", ...partial });

  const detail = async (issue: Pick<IssueSummary, "id">) => {
    const response = await call<WorkItemDetail>(detailRoute.GET, urlId(issue));
    expect(response.status).toBe(200);
    return workItemDetailSchema.parse(response.body);
  };
  const kinds = async (issue: Pick<IssueSummary, "id">) =>
    (await listWorkItemEvents(db, key(issue))).map((event) => event.kind);

  /** A connected repo of `orgId` (Coding on unless `coding` is false), with a work item match. */
  const repo = async (
    orgId: string,
    fullPath: string,
    match: Partial<WorkItemMatchFields> | null,
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
    if (match) {
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
    }
    await setCodingEnabled(db, id, coding);
    return id;
  };

  /**
   * Runs `action` and expects it to record exactly one `work_item` change, with the item's
   * ID, and to drop the organization's Backlog cache (filled before).
   */
  async function expectOneChange<T>(issue: Pick<IssueSummary, "id">, action: () => Promise<T>) {
    resetBacklogCache();
    expect(
      (
        await backlogRoute.GET(new Request("http://localhost/api/ui/backlog"), {
          params: Promise.resolve({}),
        })
      ).status,
    ).toBe(200);
    expect(hasCachedBacklog(state.orgId)).toBe(true);
    const { result, changes } = await captureChanges(action);
    expect(changes.filter((change) => change.resource === "work_item")).toEqual([
      expect.objectContaining({ organizationId: state.orgId, ids: [urlId(issue)] }),
    ]);
    expect(hasCachedBacklog(state.orgId)).toBe(false);
    return result;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    await db
      .insert(users)
      .values([{ id: "wi-owner" }, { id: state.userId, name: "Steve McMaster" }]);
    const org = await createOrganization(db, { name: "Acme", createdBy: "wi-owner" });
    state.orgId = org.id;
    expect(
      await addMember(db, { organizationId: org.id, userId: state.userId, role: "member" }),
    ).toBe("added");
    repos.api = await repo(org.id, "acme/api", {});
    repos.app = await repo(org.id, "acme/app", { project: "Portal" });
    repos.web = await repo(org.id, "acme/web", { labels: ["frontend"] });
    repos.ops = await repo(org.id, "acme/ops", null);
    repos.portal = await repo(org.id, "acme/customer-portal", null);
    repos.docs = await repo(org.id, "acme/docs", null, false);
    const saved = await replaceRoutingRules(db, org.id, [
      {
        repositoryId: repos.ops,
        query: { combinator: "and", rules: [{ field: "team", operator: "=", value: "OPS" }] },
      },
    ]);
    expect(saved.ok).toBe(true);

    const other = await createOrganization(db, { name: "Other", createdBy: "wi-owner" });
    otherRepo = await repo(other.id, "other/api", {});

    acme = new FakeLinearGateway();
    acme.projects = [{ id: "project-portal", name: "Portal" }];
    state.linear.set(org.id, acme);
    const integration = await saveIntegration(db, {
      organizationId: org.id,
      provider: "linear",
      externalId: WORKSPACE,
      name: "Acme",
      credentials: { accessToken: "t" },
      installedByUserId: null,
    });
    if (integration === "other_organization") throw new Error("setup");
    integrationId = integration.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(() => {
    resetBacklogCache();
  });

  describe("the detail", () => {
    it("routes via a project, a team, a label, a parent, a rule and a saved choice", async () => {
      const project = ready("In a project", { projectName: "Portal" });
      const team = ready("In the team");
      const label = ready("Labeled", { labels: ["frontend"] });
      const ruled = ready("Ops", { teamId: "team-ops", teamKey: "OPS" });
      const child = ready("Child", { teamId: "team-mod", teamKey: "MOD", parentId: ruled.id });
      const chosen = ready("Chosen");
      await setWorkItemRepository(db, {
        ...key(chosen),
        repositoryId: repos.portal!,
        userId: null,
      });

      const route = async (issue: IssueSummary) => (await detail(issue)).route;
      expect(await route(project)).toEqual({
        outcome: "repository",
        repository: { id: repos.app, provider: "github", fullPath: "acme/app" },
        via: { kind: "project", label: "Portal project" },
        by: "work item match (Team is ENG, project Portal)",
      });
      expect(await route(team)).toMatchObject({
        repository: { fullPath: "acme/api" },
        via: { kind: "team", label: "ENG team" },
      });
      expect(await route(label)).toMatchObject({
        repository: { fullPath: "acme/web" },
        via: { kind: "label", label: "label frontend" },
      });
      expect(await route(ruled)).toMatchObject({
        repository: { fullPath: "acme/ops" },
        via: { kind: "rule", label: "rule 1" },
        by: "rule 1 (Team is OPS)",
      });
      expect(await route(child)).toMatchObject({
        repository: { fullPath: "acme/ops" },
        via: { kind: "parent", label: `parent ${ruled.identifier}` },
      });
      expect(await route(chosen)).toMatchObject({
        outcome: "repository",
        repository: { fullPath: "acme/customer-portal" },
        via: { kind: "choice", label: "your choice" },
        by: "your choice in Omniralph (customer-portal)",
      });
      // The row's repo is the routed one.
      expect((await detail(chosen)).repository).toEqual({
        id: repos.portal,
        provider: "github",
        fullPath: "acme/customer-portal",
      });
    });

    it("reads the PRD, stories, activity, triage, run, actions and blockers", async () => {
      const epic = ready("Epic", { description: "# PRD: Epic\n\nBuild it." });
      acme.add({
        title: "Store it",
        parentId: epic.id,
        identifier: "ENG-501",
        stateType: "unstarted",
        stateName: "Todo",
        subIssueSortOrder: 1,
      });
      acme.add({
        title: "Grant access",
        parentId: epic.id,
        identifier: "ENG-502",
        labels: ["manual"],
        stateType: "started",
        stateName: "In Progress",
        subIssueSortOrder: 2,
      });
      // One blocker the Backlog lists, one in progress (not listed).
      const listedBlocker = ready("Listed blocker");
      const busyBlocker = acme.add({ title: "Busy blocker", stateType: "started" });
      acme.blocks.set(epic.id, [listedBlocker.id, busyBlocker.id]);
      acme.commentsByIssue.set(epic.id, [
        {
          body: "Looks good\nmore text",
          author: "Anna Lee",
          createdAt: "2026-10-03T00:00:00.000Z",
        },
      ]);
      const { run: triage } = await createTriageRun(db, {
        organizationId: state.orgId,
        linearIssueId: epic.id,
        linearAgentSessionId: `triage-${randomUUID()}`,
        trigger: "label",
      });
      await db
        .update(triageRuns)
        .set({
          status: "completed",
          lastResult: {
            summary: "s",
            error: null,
            outcome: { outcome: "prd", size: "M", openQuestions: ["a", "b"] },
          },
          updatedAt: new Date("2026-10-02T00:00:00.000Z"),
        })
        .where(eq(triageRuns.id, triage.id));
      // Repo changed in Omniralph, later than the comment.
      await expectOneChange(epic, async () =>
        expect(
          (
            await call(repositoryRoute.PUT, urlId(epic), {
              method: "PUT",
              body: { repositoryId: repos.portal },
            })
          ).status,
        ).toBe(200),
      );

      const view = await detail(epic);
      expect(view).toMatchObject({
        id: urlId(epic),
        identifier: epic.identifier,
        title: "Epic",
        group: "ready",
        description: "# PRD: Epic\n\nBuild it.",
        updatedAt: acme.issues.get(epic.id)!.updatedAt,
        size: "M",
        blocked: true,
        triageRunning: false,
        run: null,
        organization: { id: state.orgId, name: "Acme", role: "member" },
        source: { kind: "team", name: "ENG" },
      });
      expect(view.blockedBy).toEqual([
        {
          identifier: listedBlocker.identifier,
          url: `https://linear.app/acme/issue/${listedBlocker.identifier}`,
          backlogId: urlId(listedBlocker),
        },
        {
          identifier: busyBlocker.identifier,
          url: `https://linear.app/acme/issue/${busyBlocker.identifier}`,
          backlogId: null,
        },
      ]);
      expect(view.stories).toEqual([
        {
          identifier: "ENG-501",
          title: "Store it",
          state: { category: "todo", name: "Todo" },
          url: "https://linear.app/acme/issue/ENG-501",
          manual: false,
        },
        {
          identifier: "ENG-502",
          title: "Grant access",
          state: { category: "in_progress", name: "In Progress" },
          url: "https://linear.app/acme/issue/ENG-502",
          manual: true,
        },
      ]);
      expect(view.activity.map((entry) => entry.text)).toEqual([
        "Steve changed the repo to customer-portal",
        "Anna commented: Looks good",
        "Om left 2 open questions",
        "Om triaged it (size M)",
      ]);
      expect(view.actions).toEqual({
        start: true,
        triage: true,
        editPrd: true,
        changeRepo: true,
        move: true,
        cancel: true,
      });

      // Triage queued, then a run: the actions follow.
      const { run: active } = await createTriageRun(db, {
        organizationId: state.orgId,
        linearIssueId: epic.id,
        linearAgentSessionId: `triage-${randomUUID()}`,
        trigger: "label",
      });
      expect(await detail(epic)).toMatchObject({
        triageRunning: true,
        actions: { triage: false, start: true },
      });
      await db.delete(triageRuns).where(eq(triageRuns.id, active.id));
      const [run] = await db
        .insert(ralphRuns)
        .values({
          organizationId: state.orgId,
          linearIssueId: epic.id,
          linearIdentifier: epic.identifier,
          linearAgentSessionId: `session-${randomUUID()}`,
          kind: "children",
          status: "running",
        })
        .returning();
      expect(await detail(epic)).toMatchObject({
        run: { id: run!.id, status: "running" },
        actions: {
          start: false,
          triage: false,
          editPrd: false,
          changeRepo: false,
          move: false,
          cancel: false,
        },
      });
    });

    it("is not found for an unknown or malformed ID", async () => {
      expect((await call(detailRoute.GET, "linear-nope")).status).toBe(404);
      expect((await call(detailRoute.GET, "jira-1")).status).toBe(404);
      expect(
        (
          await call(detailRoute.GET, urlId(ready("Here")), {
            query: `?organization=${randomUUID()}`,
          })
        ).status,
      ).toBe(404);
    });
  });

  describe("Start epic", () => {
    const deliverSession = async (issue: IssueSummary, sessionId: string) => {
      const body = JSON.stringify({
        type: "AgentSessionEvent",
        action: "created",
        organizationId: WORKSPACE,
        webhookTimestamp: Date.now(),
        agentSession: {
          id: sessionId,
          issue: { id: issue.id, identifier: issue.identifier },
          comment: { body: `${AGENT_SESSION_MARKER}. Delegated by Steve.` },
        },
      });
      const fakeAdapter = { getDefaultBranch: async () => "main" } as unknown as ScmAdapter;
      const response = await handleLinearWebhook(
        new Request("https://omniralph.example.com/api/webhooks/linear", {
          method: "POST",
          headers: { "linear-signature": signBody(body, SECRET), "linear-delivery": sessionId },
          body,
        }),
        {
          db,
          secret: SECRET,
          handle: (event, context) =>
            handleLinearEvent(event, context, {
              linear: acme,
              dispatcher: new PostgresDispatcher({ db }),
              adapterFor: () => fakeAdapter,
            }),
        },
      );
      expect(response.status).toBe(200);
    };
    /** The session's activities, with the issue's identifier and ID made neutral. */
    const activities = (sessionId: string, issue: IssueSummary) =>
      acme.activities
        .filter((activity) => activity.sessionId === sessionId)
        .map((activity) =>
          JSON.parse(
            JSON.stringify(activity.content)
              .replaceAll(issue.identifier, "<identifier>")
              .replaceAll(issue.id, "<id>"),
          ),
        );

    it("delegates to Om, and the run that follows equals a delegation made in Linear", async () => {
      const same = { description: "Do it.", branchName: "same-work" };
      const inLinear = ready("Same work", same);
      const fromBacklog = ready("Same work", same);

      await deliverSession(inLinear, "session-in-linear");

      const started = await expectOneChange(fromBacklog, () =>
        call(startRoute.POST, urlId(fromBacklog), { method: "POST" }),
      );
      expect(started).toEqual({ status: 200, body: { ok: true } });
      expect(acme.delegateOf(fromBacklog.id)).toBe(acme.viewer.id);
      expect(await kinds(fromBacklog)).toEqual(["started"]);
      // Linear answers the delegation with an agent session, through the same webhook.
      await deliverSession(fromBacklog, "session-from-backlog");

      const linearRun = (await getRunBySession(db, "session-in-linear"))!;
      const backlogRun = (await getRunBySession(db, "session-from-backlog"))!;
      expect(backlogRun).toMatchObject({
        origin: linearRun.origin,
        mode: linearRun.mode,
        routedBy: linearRun.routedBy,
        repositoryId: linearRun.repositoryId,
        status: linearRun.status,
      });
      expect(backlogRun.routedBy).toBe("work item match (Team is ENG)");
      expect(activities("session-from-backlog", fromBacklog)).toEqual(
        activities("session-in-linear", inLinear),
      );
      expect(activities("session-from-backlog", fromBacklog).length).toBeGreaterThan(0);

      // It has a run now.
      const again = await call(startRoute.POST, urlId(fromBacklog), { method: "POST" });
      expect(again).toEqual({
        status: 409,
        body: expect.objectContaining({
          error: `Om already has a run for ${fromBacklog.identifier}.`,
        }),
      });
    });

    it("refuses an item that needs refining, and starts a blocked one", async () => {
      const unrefined = refine("Rough idea");
      expect(await call(startRoute.POST, urlId(unrefined), { method: "POST" })).toEqual({
        status: 400,
        body: expect.objectContaining({
          error: "Only a work item that's Ready to start can be started.",
        }),
      });
      expect(acme.delegateOf(unrefined.id)).toBeUndefined();

      const blocker = ready("Blocker first");
      const blocked = ready("Blocked");
      acme.blocks.set(blocked.id, [blocker.id]);
      expect((await call(startRoute.POST, urlId(blocked), { method: "POST" })).status).toBe(200);
      expect(acme.delegateOf(blocked.id)).toBe(acme.viewer.id);
    });
  });

  it("Triage now starts triage once; a second request while it runs is a conflict", async () => {
    const idea = refine("Idea", { identifier: "SOC-412" });
    expect(
      await expectOneChange(idea, () => call(triageRoute.POST, urlId(idea), { method: "POST" })),
    ).toEqual({ status: 200, body: { ok: true } });
    expect(acme.issues.get(idea.id)!.labels).toContain("coding:triage");
    expect(await kinds(idea)).toEqual(["triage_requested"]);

    await createTriageRun(db, {
      organizationId: state.orgId,
      linearIssueId: idea.id,
      linearAgentSessionId: `triage-${randomUUID()}`,
      trigger: "label",
    });
    expect(await call(triageRoute.POST, urlId(idea), { method: "POST" })).toEqual({
      status: 409,
      body: expect.objectContaining({ error: "Om is already triaging SOC-412." }),
    });
    expect(await kinds(idea)).toEqual(["triage_requested"]);
  });

  describe("Edit PRD", () => {
    it("saves the description based on the item's updatedAt and answers the new one", async () => {
      const item = ready("PRD", { description: "Old", identifier: "SOC-500" });
      const base = (await detail(item)).updatedAt;
      const saved = await expectOneChange(item, () =>
        call<{ updatedAt: string }>(prdRoute.PUT, urlId(item), {
          method: "PUT",
          body: { markdown: "# PRD: New", baseUpdatedAt: base },
        }),
      );
      expect(saved.status).toBe(200);
      expect(acme.issues.get(item.id)!.description).toBe("# PRD: New");
      expect(saved.body.updatedAt).toBe(acme.issues.get(item.id)!.updatedAt);
      expect(saved.body.updatedAt).not.toBe(base);
      expect(await kinds(item)).toEqual(["prd_edited"]);
    });

    it("refuses a stale base without writing, and while a run works on the item", async () => {
      const item = ready("PRD", { description: "Old", identifier: "SOC-501" });
      const base = (await detail(item)).updatedAt;
      acme.touch(item.id);
      const writes = acme.issueUpdates.length;
      expect(
        await call(prdRoute.PUT, urlId(item), {
          method: "PUT",
          body: { markdown: "Mine", baseUpdatedAt: base },
        }),
      ).toEqual({
        status: 409,
        body: expect.objectContaining({ error: "SOC-501 changed in Linear since you opened it." }),
      });
      expect(acme.issueUpdates.length).toBe(writes);
      expect(acme.issues.get(item.id)!.description).toBe("Old");

      for (const status of ["pending", "running", "waiting"] as const) {
        const [run] = await db
          .insert(ralphRuns)
          .values({
            organizationId: state.orgId,
            linearIssueId: item.id,
            linearIdentifier: item.identifier,
            linearAgentSessionId: `session-${randomUUID()}`,
            kind: "children",
            status,
          })
          .returning();
        expect(
          await call(prdRoute.PUT, urlId(item), {
            method: "PUT",
            body: { markdown: "Mine", baseUpdatedAt: acme.issues.get(item.id)!.updatedAt },
          }),
        ).toEqual({
          status: 409,
          body: expect.objectContaining({
            error: "Om is working on SOC-501. Edit the PRD when the run stops.",
          }),
        });
        await db.delete(ralphRuns).where(eq(ralphRuns.id, run!.id));
      }
      expect(acme.issueUpdates.length).toBe(writes);
      expect(await kinds(item)).toEqual([]);
    });
  });

  describe("Change repo", () => {
    it("saves and clears the choice", async () => {
      const item = ready("Re-route");
      expect(
        await expectOneChange(item, () =>
          call(repositoryRoute.PUT, urlId(item), {
            method: "PUT",
            body: { repositoryId: repos.portal },
          }),
        ),
      ).toEqual({
        status: 200,
        body: {
          repository: { id: repos.portal, provider: "github", fullPath: "acme/customer-portal" },
        },
      });
      expect((await getWorkItemOverride(db, key(item)))?.repositoryId).toBe(repos.portal);
      expect((await detail(item)).route.via).toEqual({ kind: "choice", label: "your choice" });

      expect(
        await expectOneChange(item, () =>
          call(repositoryRoute.PUT, urlId(item), { method: "PUT", body: { repositoryId: null } }),
        ),
      ).toEqual({ status: 200, body: { repository: null } });
      expect(await getWorkItemOverride(db, key(item))).toBeNull();
      expect((await detail(item)).route.via).toEqual({ kind: "team", label: "ENG team" });
      expect(await kinds(item)).toEqual(["repo_reset", "repo_changed"]);
    });

    it("refuses a repo of another organization or with Coding off", async () => {
      const item = ready("Not there");
      for (const repositoryId of [otherRepo, repos.docs, randomUUID()]) {
        expect(
          await call(repositoryRoute.PUT, urlId(item), { method: "PUT", body: { repositoryId } }),
        ).toEqual({
          status: 400,
          body: expect.objectContaining({
            error: "Choose a repo of this organization with Coding on.",
          }),
        });
      }
      expect(await getWorkItemOverride(db, key(item))).toBeNull();
      expect(await kinds(item)).toEqual([]);
    });
  });

  describe("Move to Needs refining", () => {
    it("moves to the default mapping's Backlog state", async () => {
      const item = ready("Not ready after all");
      expect(
        await expectOneChange(item, () =>
          call(moveRoute.POST, urlId(item), { method: "POST", body: { to: "needs_refining" } }),
        ),
      ).toEqual({ status: 200, body: { ok: true } });
      expect(acme.stateChanges.at(-1)).toEqual({
        issueId: item.id,
        target: { id: "state-backlog" },
      });
      expect(acme.issues.get(item.id)!.stateType).toBe("backlog");
      expect(await kinds(item)).toEqual(["moved_to_needs_refining"]);
      expect((await detail(item)).group).toBe("refine");
    });

    it("moves to a custom mapping's Needs-refining state", async () => {
      const states = acme.workflowStates;
      acme.workflowStates = [
        ...states,
        { id: "state-icebox", name: "Icebox", type: "backlog", position: 9 },
      ];
      await setIntegrationStateMapping(db, integrationId, {
        ready: { types: ["unstarted"] },
        needsRefining: { types: ["backlog"] },
        teams: { "team-1": { ready: [], needsRefining: ["state-icebox"] } },
      });
      try {
        const item = ready("Into the icebox");
        expect(
          (
            await call(moveRoute.POST, urlId(item), {
              method: "POST",
              body: { to: "needs_refining" },
            })
          ).status,
        ).toBe(200);
        expect(acme.stateChanges.at(-1)).toEqual({
          issueId: item.id,
          target: { id: "state-icebox" },
        });
        expect(acme.issues.get(item.id)!.stateName).toBe("Icebox");
      } finally {
        acme.workflowStates = states;
        await setIntegrationStateMapping(db, integrationId, {
          ready: { types: ["unstarted"] },
          needsRefining: { types: ["backlog"] },
          teams: {},
        });
      }
    });

    it("refuses anything but needs_refining", async () => {
      const item = ready("Stay");
      expect(
        (await call(moveRoute.POST, urlId(item), { method: "POST", body: { to: "ready" } })).status,
      ).toBe(400);
    });
  });

  it("Remove from backlog cancels the item in its tracker", async () => {
    const item = refine("Not doing it");
    expect(
      await expectOneChange(item, () => call(cancelRoute.POST, urlId(item), { method: "POST" })),
    ).toEqual({ status: 200, body: { ok: true } });
    expect(acme.issues.get(item.id)!.stateType).toBe("canceled");
    expect(await kinds(item)).toEqual(["canceled"]);
  });

  it("answers 502 when Linear fails, changing nothing", async () => {
    const item = ready("Flaky");
    acme.failures.set("setIssueState", new Error("Linear is down"));
    try {
      expect(await call(cancelRoute.POST, urlId(item), { method: "POST" })).toEqual({
        status: 502,
        body: expect.objectContaining({ error: "Linear didn't answer. Try again in a moment." }),
      });
    } finally {
      acme.failures.clear();
    }
    expect(await kinds(item)).toEqual([]);
  });
});
