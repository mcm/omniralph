import { randomBytes } from "node:crypto";
import {
  addMember,
  closeDb,
  connectRepository,
  createDb,
  createOrganization,
  listWorkItemEvents,
  saveIntegration,
  saveWorkItemMatch,
  upsertScmConnection,
  users,
  workItemEvents,
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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkItemResultSchema } from "@/lib/api/work-items";
import { assertRole, type Role } from "@/lib/auth/roles";
import type * as LinearClient from "@/lib/linear/client";
import { FakeLinearGateway } from "@/lib/linear/fake-gateway";
import { TRIAGE_LABEL } from "@/lib/linear/webhook";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: "create-member",
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

const createRoute = await import("./route");
const backlogRoute = await import("../backlog/route");
const {
  CREATE_FAILED_MESSAGE,
  TITLE_REQUIRED_MESSAGE,
  TITLE_TOO_LONG_MESSAGE,
  TRACKER_NOT_CONNECTED_MESSAGE,
  TRIAGE_FAILED_MESSAGE,
  createWorkItem,
} = await import("@/lib/work-items/create");
const { hasCachedBacklog, resetBacklogCache } = await import("@/lib/work-items/backlog-cache");

async function post(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await createRoute.POST(
    new Request("http://localhost/api/ui/work-items", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({}) },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("creating work items", () => {
  let testDb: TestDatabase;
  let db: Database;
  let acme: FakeLinearGateway;
  let otherOrgId: string;
  let unconnectedOrgId: string;
  const repos: Record<string, string> = {};
  const actor = { userId: null, name: "Om in Slack" };

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

  const input = (repositoryId: string, extra: Record<string, unknown> = {}) => ({
    organizationId: state.orgId,
    repositoryId,
    title: "Export invoices as CSV",
    description: "Customers ask for it.",
    triageNow: false,
    actor,
    origin: "ask" as const,
    ...extra,
  });

  const events = async (externalId: string, organizationId = state.orgId) =>
    listWorkItemEvents(db, { organizationId, tracker: "linear", externalId });

  async function fillBacklogCache() {
    resetBacklogCache();
    const response = await backlogRoute.GET(new Request("http://localhost/api/ui/backlog"), {
      params: Promise.resolve({}),
    });
    expect(response.status).toBe(200);
    expect(hasCachedBacklog(state.orgId)).toBe(true);
  }

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    await db
      .insert(users)
      .values([{ id: "create-owner" }, { id: state.userId, name: "Steve McMaster" }]);
    const org = await createOrganization(db, { name: "Acme", createdBy: "create-owner" });
    state.orgId = org.id;
    expect(
      await addMember(db, { organizationId: org.id, userId: state.userId, role: "member" }),
    ).toBe("added");
    repos.portal = await repo(org.id, "acme/customer-portal", {
      team: "eng",
      project: "portal",
      labels: ["frontend", "product:portal"],
    });
    repos.api = await repo(org.id, "acme/api", { withoutProject: true });
    repos.lost = await repo(org.id, "acme/lost", { project: "Archived" });
    repos.ghost = await repo(org.id, "acme/ghost", { team: "GHO" });
    repos.none = await repo(org.id, "acme/none", null);
    repos.off = await repo(org.id, "acme/off", {}, false);

    const other = await createOrganization(db, { name: "Other", createdBy: "create-owner" });
    otherOrgId = other.id;
    repos.other = await repo(other.id, "other/api", {});
    const unconnected = await createOrganization(db, {
      name: "Unconnected",
      createdBy: "create-owner",
    });
    unconnectedOrgId = unconnected.id;
    repos.unconnected = await repo(unconnected.id, "unconnected/api", {});

    for (const [orgId, workspace] of [
      [org.id, "acme-workspace"],
      [other.id, "other-workspace"],
    ] as const) {
      const integration = await saveIntegration(db, {
        organizationId: orgId,
        provider: "linear",
        externalId: workspace,
        name: workspace,
        credentials: { accessToken: "t" },
        installedByUserId: null,
      });
      if (integration === "other_organization") throw new Error("setup");
    }
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    // Each test's workspace numbers its issues from 1 again.
    await db.delete(workItemEvents);
    acme = new FakeLinearGateway();
    acme.projects = [{ id: "project-portal", name: "Portal" }];
    state.linear.clear();
    state.linear.set(state.orgId, acme);
    state.linear.set(otherOrgId, new FakeLinearGateway());
    resetBacklogCache();
  });

  describe("createWorkItem", () => {
    it("creates the item in the match's team, project and labels, records it and answers the row", async () => {
      await fillBacklogCache();
      const { result, changes } = await captureChanges(() =>
        createWorkItem({ db }, input(repos.portal!)),
      );

      expect(acme.created).toEqual([
        expect.objectContaining({
          teamId: "team-1",
          projectId: "project-portal",
          labels: ["frontend", "product:portal"],
          title: "Export invoices as CSV",
          description: "Customers ask for it.",
        }),
      ]);
      // Never delegated.
      expect(acme.delegations).toEqual([]);
      const [issue] = [...acme.issues.values()];
      expect(result).toEqual({
        ok: true,
        item: {
          id: workItemUrlId("linear", issue!.id),
          tracker: "linear",
          identifier: issue!.identifier,
          title: "Export invoices as CSV",
          url: issue!.url,
          organization: { id: state.orgId, name: "Acme" },
          repository: { id: repos.portal, provider: "github", fullPath: "acme/customer-portal" },
          size: null,
          group: "ready",
          blocked: false,
          source: { kind: "project", id: "project-portal", name: "Portal" },
        },
        triage: null,
      });
      expect(await events(issue!.id)).toEqual([
        expect.objectContaining({
          kind: "created",
          actorUserId: null,
          actorName: "Om in Slack",
          detail: {
            origin: "ask",
            repositoryId: repos.portal,
            repository: "acme/customer-portal",
          },
        }),
      ]);
      expect(changes.filter((change) => change.resource === "work_item")).toEqual([
        expect.objectContaining({
          organizationId: state.orgId,
          ids: [workItemUrlId("linear", issue!.id)],
        }),
      ]);
      expect(hasCachedBacklog(state.orgId)).toBe(false);
    });

    it("drops the Backlog cache when called outside a request", async () => {
      await fillBacklogCache();
      const result = await createWorkItem({ db }, input(repos.api!));
      expect(result.ok).toBe(true);
      expect(hasCachedBacklog(state.orgId)).toBe(false);
    });

    it("creates in no project for a match of items without one, trimming the title", async () => {
      const result = await createWorkItem(
        { db },
        input(repos.api!, { title: "  Rate limit the API  ", description: "" }),
      );
      expect(acme.created).toEqual([
        { teamId: "team-1", title: "Rate limit the API", description: "" },
      ]);
      expect(result).toMatchObject({
        ok: true,
        item: {
          title: "Rate limit the API",
          source: { kind: "team", id: "team-1", name: "ENG" },
          repository: { id: repos.api },
        },
      });
    });

    it("starts triage with triageNow and records it", async () => {
      const result = await createWorkItem({ db }, input(repos.api!, { triageNow: true }));
      expect(result).toMatchObject({ ok: true, triage: "started" });
      const [issue] = [...acme.issues.values()];
      expect(issue!.labels).toContain(TRIAGE_LABEL);
      expect((await events(issue!.id)).map((event) => event.kind)).toEqual([
        "triage_requested",
        "created",
      ]);
    });

    it("returns the created item with triage failed when triage can't start", async () => {
      acme.failures.set("addIssueLabels", new Error("Linear is down"));
      const result = await createWorkItem({ db }, input(repos.api!, { triageNow: true }));
      const [issue] = [...acme.issues.values()];
      expect(issue).toBeDefined();
      expect(result).toMatchObject({
        ok: true,
        item: { id: workItemUrlId("linear", issue!.id), title: "Export invoices as CSV" },
        triage: "failed",
        triageError: TRIAGE_FAILED_MESSAGE,
      });
      expect((await events(issue!.id)).map((event) => event.kind)).toEqual(["created"]);
    });

    it("refuses an empty title and one over 255 characters", async () => {
      for (const title of ["", "   "]) {
        expect(await createWorkItem({ db }, input(repos.api!, { title }))).toEqual({
          ok: false,
          code: "invalid",
          message: TITLE_REQUIRED_MESSAGE,
        });
      }
      expect(await createWorkItem({ db }, input(repos.api!, { title: "x".repeat(256) }))).toEqual({
        ok: false,
        code: "invalid",
        message: TITLE_TOO_LONG_MESSAGE,
      });
      expect(acme.created).toEqual([]);
      expect(
        await createWorkItem({ db }, input(repos.api!, { title: "x".repeat(255) })),
      ).toMatchObject({ ok: true });
    });

    it("refuses a repo without a work item match", async () => {
      expect(await createWorkItem({ db }, input(repos.none!))).toEqual({
        ok: false,
        code: "no_work_item_match",
        message: "none doesn't pick up work items yet.",
      });
      expect(acme.created).toEqual([]);
    });

    it("refuses a repo with Coding off", async () => {
      expect(await createWorkItem({ db }, input(repos.off!))).toEqual({
        ok: false,
        code: "coding_off",
        message: "Coding is off for off.",
      });
      expect(acme.created).toEqual([]);
    });

    it("refuses when the organization has no tracker connected", async () => {
      expect(
        await createWorkItem(
          { db },
          input(repos.unconnected!, { organizationId: unconnectedOrgId }),
        ),
      ).toEqual({
        ok: false,
        code: "tracker_not_connected",
        message: TRACKER_NOT_CONNECTED_MESSAGE,
      });
    });

    it("answers tracker_failed when the tracker fails, recording nothing", async () => {
      acme.failures.set("createIssue", new Error("Linear is down"));
      expect(await createWorkItem({ db }, input(repos.api!, { triageNow: true }))).toEqual({
        ok: false,
        code: "tracker_failed",
        message: CREATE_FAILED_MESSAGE,
      });
      expect(acme.issues.size).toBe(0);
    });

    it("answers tracker_failed when the match's team or project isn't in the tracker", async () => {
      expect(await createWorkItem({ db }, input(repos.ghost!))).toEqual({
        ok: false,
        code: "tracker_failed",
        message: "Linear has no team GHO.",
      });
      expect(await createWorkItem({ db }, input(repos.lost!))).toEqual({
        ok: false,
        code: "tracker_failed",
        message: "Linear has no project Archived.",
      });
      expect(acme.issues.size).toBe(0);
    });

    it("refuses a repo of another organization", async () => {
      expect(await createWorkItem({ db }, input(repos.other!))).toMatchObject({
        ok: false,
        code: "repository_not_found",
      });
      expect(state.linear.get(otherOrgId)!.created).toEqual([]);
    });
  });

  describe("POST /api/ui/work-items", () => {
    it("lets a member create, as themselves from the Backlog", async () => {
      const response = await post({
        repositoryId: repos.portal,
        title: "Export invoices as CSV",
        description: "Customers ask for it.",
        triageNow: true,
      });
      expect(response.status).toBe(200);
      const body = createWorkItemResultSchema.parse(response.body);
      const [issue] = [...acme.issues.values()];
      expect(body).toMatchObject({
        item: {
          id: workItemUrlId("linear", issue!.id),
          organization: { id: state.orgId, name: "Acme", role: "member" },
          repository: { id: repos.portal, fullPath: "acme/customer-portal" },
          group: "ready",
        },
        triage: "started",
      });
      expect(await events(issue!.id)).toEqual([
        expect.objectContaining({
          kind: "triage_requested",
          actorUserId: state.userId,
          actorName: "Steve McMaster",
          detail: { origin: "backlog" },
        }),
        expect.objectContaining({
          kind: "created",
          actorUserId: state.userId,
          actorName: "Steve McMaster",
          detail: expect.objectContaining({ origin: "backlog" }),
        }),
      ]);
    });

    it("triages by default and takes an empty description", async () => {
      const response = await post({ repositoryId: repos.api, title: "Default" });
      expect(response).toMatchObject({ status: 200, body: { triage: "started" } });
      expect(acme.created).toEqual([expect.objectContaining({ description: "" })]);
    });

    it("answers 404 for another organization's repo, creating nothing", async () => {
      expect(await post({ repositoryId: repos.other, title: "Planted" })).toMatchObject({
        status: 404,
      });
      expect(state.linear.get(otherOrgId)!.created).toEqual([]);
      expect(acme.created).toEqual([]);
    });

    it("answers the service's refusals with their messages", async () => {
      expect(await post({ repositoryId: repos.api, title: " " })).toMatchObject({
        status: 400,
        body: {
          code: "invalid",
          error: TITLE_REQUIRED_MESSAGE,
          fieldErrors: { title: TITLE_REQUIRED_MESSAGE },
        },
      });
      expect(await post({ repositoryId: repos.none, title: "A" })).toMatchObject({
        status: 400,
        body: { code: "no_work_item_match", error: "none doesn't pick up work items yet." },
      });
      expect(await post({ repositoryId: repos.off, title: "A" })).toMatchObject({
        status: 400,
        body: { code: "coding_off", error: "Coding is off for off." },
      });
      acme.failures.set("createIssue", new Error("Linear is down"));
      expect(await post({ repositoryId: repos.api, title: "A" })).toMatchObject({
        status: 502,
        body: { code: "tracker_failed", error: CREATE_FAILED_MESSAGE },
      });
      expect(await post({ title: "No repo" })).toMatchObject({ status: 400 });
    });
  });
});
