import { randomBytes } from "node:crypto";
import {
  closeDb,
  connectRepository,
  createDb,
  createOrganization,
  saveIntegration,
  sprints,
  upsertScmConnection,
  users,
  type Database,
} from "@omniralph/db";
import { captureChanges } from "@omniralph/db/changes";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { FakeLinearGateway } from "@omniralph/tracker/linear/testing";
import type { IssueSummary } from "@omniralph/tracker";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { savedSprintSchema, sprintListSchema, type SprintRow } from "@/lib/api/sprints";
import { assertRole, type Role } from "@/lib/auth/roles";
import type * as LinearClient from "@/lib/tracker/linear/client";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  orgId: "",
  role: "admin" as Role,
  linear: new Map<string, FakeLinearGateway>(),
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") =>
    assertRole(
      {
        id: "sprint-user",
        role: state.role,
        name: "Ada",
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
    getLinearGateway: async (options: LinearClient.LinearGatewayOptions) => {
      const gateway = state.linear.get(options.organizationId);
      if (!gateway) throw new actual.LinearNotConnectedError();
      return gateway;
    },
  };
});

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const list = await import("./route");
const one = await import("./[id]/route");

type Handler = (
  request: Request,
  route: { params: Promise<Record<string, string>> },
) => Promise<Response>;

async function call(
  handler: Handler,
  method: string,
  params: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handler(
    new Request("http://localhost/api/ui/sprints", {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve(params) },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const workItemId = (issue: IssueSummary) => `linear-${issue.id}`;

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("/api/ui/sprints", () => {
  let testDb: TestDatabase;
  let db: Database;
  let repoId: string;
  let otherOrgId: string;
  let otherOrgRepoId: string;
  let linear: FakeLinearGateway;
  const issues: Record<string, IssueSummary> = {};

  const repo = async (organizationId: string, fullPath: string) => {
    const connection = (await upsertScmConnection(
      db,
      {
        organizationId,
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
    return id;
  };

  /** An epic: a work item with a sub-issue. */
  const epic = (identifier: string, partial: Partial<IssueSummary> = {}) => {
    const issue = linear.add({ identifier, title: `Epic ${identifier}`, ...partial });
    linear.add({ title: `Story of ${identifier}`, parentId: issue.id });
    return issue;
  };

  const create = (body: Record<string, unknown>) =>
    call(list.POST as Handler, "POST", {}, { repositoryId: repoId, name: "Q4", ...body });
  const patch = (id: string, body: unknown) => call(one.PATCH as Handler, "PATCH", { id }, body);
  const remove = (id: string) => call(one.DELETE as Handler, "DELETE", { id });
  const created = async (body: Record<string, unknown>): Promise<SprintRow> => {
    const result = await create(body);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    return savedSprintSchema.parse(result.body).sprint;
  };

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    await db.insert(users).values([{ id: "sprint-user", name: "Ada" }]);
    const org = await createOrganization(db, { name: "Acme", createdBy: "sprint-user" });
    const other = await createOrganization(db, { name: "Other", createdBy: "sprint-user" });
    state.orgId = org.id;
    repoId = await repo(org.id, "acme/api");
    otherOrgId = other.id;
    otherOrgRepoId = await repo(other.id, "other/api");

    linear = new FakeLinearGateway();
    const integration = await saveIntegration(db, {
      organizationId: org.id,
      provider: "linear",
      externalId: "workspace-acme",
      name: "Acme",
      credentials: { accessToken: "t" },
      installedByUserId: null,
    });
    if (integration === "other_organization") throw new Error("setup");
    state.linear.set(org.id, linear);

    issues.a = epic("ENG-1");
    issues.b = epic("ENG-2");
    issues.c = epic("ENG-3");
    // ENG-2 is blocked by ENG-1.
    linear.blocks.set(issues.b.id, [issues.a.id]);
    issues.standalone = linear.add({ identifier: "ENG-4", title: "A task on its own" });
    issues.story = linear.add({ identifier: "ENG-5", title: "A story", parentId: issues.a.id });
    issues.feature = linear.add({ identifier: "ENG-6", title: "A feature" });
    const featureEpic = linear.add({ title: "Its epic", parentId: issues.feature.id });
    linear.add({ title: "Its epic's story", parentId: featureEpic.id });
    issues.done = epic("ENG-7", { stateType: "completed", stateName: "Done" });
  });

  beforeEach(async () => {
    state.role = "admin";
    await db.delete(sprints);
  });

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  it("creates a draft sprint with its epics in order, a standalone task counting as an epic", async () => {
    const { result, changes } = await captureChanges(() =>
      create({
        name: "  Launch  ",
        mergeTogether: true,
        epics: [workItemId(issues.a!), workItemId(issues.standalone!), workItemId(issues.b!)],
      }),
    );
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const sprint = savedSprintSchema.parse(result.body).sprint;
    expect(sprint).toMatchObject({
      name: "Launch",
      repository: { id: repoId, fullPath: "acme/api" },
      mergeTogether: true,
      status: "draft",
      sprintBranch: null,
      sprintPullRequest: null,
    });
    expect(sprint.epics.map((e) => [e.identifier, e.position, e.state])).toEqual([
      ["ENG-1", 0, "queued"],
      ["ENG-4", 1, "queued"],
      ["ENG-2", 2, "queued"],
    ]);
    expect(changes.map((c) => [c.resource, c.ids])).toEqual(
      expect.arrayContaining([
        ["sprint", [sprint.id]],
        [
          "work_item",
          [workItemId(issues.a!), workItemId(issues.standalone!), workItemId(issues.b!)],
        ],
      ]),
    );
  });

  it("lists the organization's sprints newest first, for members too", async () => {
    const first = await created({ name: "First" });
    const second = await created({ name: "Second", epics: [workItemId(issues.c!)] });
    state.role = "member";
    const result = await call(list.GET as Handler, "GET");
    expect(result.status).toBe(200);
    const { sprints: listed } = sprintListSchema.parse(result.body);
    expect(listed.map((s) => s.id)).toEqual([second.id, first.id]);
    expect(listed[0]!.epics.map((e) => e.workItemId)).toEqual([workItemId(issues.c!)]);

    const detail = await call(one.GET as Handler, "GET", { id: first.id });
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ id: first.id, name: "First" });
  });

  it("refuses members' writes", async () => {
    const sprint = await created({});
    state.role = "member";
    expect((await create({})).status).toBe(403);
    expect((await patch(sprint.id, { name: "New" })).status).toBe(403);
    expect((await remove(sprint.id)).status).toBe(403);
  });

  it("answers 400 for invalid input", async () => {
    const blank = await create({ name: "   " });
    expect(blank.status).toBe(400);
    expect(blank.body.fieldErrors).toHaveProperty("name");
    expect((await create({ repositoryId: "nope" })).status).toBe(400);
    const twice = await create({ epics: [workItemId(issues.a!), workItemId(issues.a!)] });
    expect(twice.status).toBe(400);
    const unknownRepo = await create({ repositoryId: otherOrgRepoId });
    expect(unknownRepo.status).toBe(400);
    expect(unknownRepo.body.fieldErrors).toHaveProperty("repositoryId");
    const unknownItem = await create({ epics: ["linear-missing"] });
    expect(unknownItem.status).toBe(400);
    expect(unknownItem.body.fieldErrors).toHaveProperty("epics.0");
    expect((await create({ epics: ["not an id"] })).status).toBe(400);

    const sprint = await created({});
    expect((await patch(sprint.id, {})).status).toBe(400);
    expect((await patch(sprint.id, { status: "running" })).status).toBe(400);
    expect(await db.select().from(sprints)).toHaveLength(1);
  });

  it("adds only epics: a story, a feature or a done epic is refused", async () => {
    const story = await create({ epics: [workItemId(issues.a!), workItemId(issues.story!)] });
    expect(story.status).toBe(400);
    expect(story.body.error).toBe(
      "ENG-5 is a task in an epic: add its epic to the sprint instead.",
    );
    expect(story.body.fieldErrors).toEqual({ "epics.1": story.body.error });

    const feature = await create({ epics: [workItemId(issues.feature!)] });
    expect(feature.status).toBe(400);
    expect(feature.body.error).toBe(
      "ENG-6 is a feature: add each of its epics to the sprint instead.",
    );

    const done = await create({ epics: [workItemId(issues.done!)] });
    expect(done.status).toBe(400);
    expect(done.body.error).toMatch(/^ENG-7 is done/);
    expect(await db.select().from(sprints)).toHaveLength(0);
  });

  it("refuses an order that puts an epic before an epic that blocks it, naming both", async () => {
    const refused = await create({ epics: [workItemId(issues.b!), workItemId(issues.a!)] });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({
      error: "ENG-2 is blocked by ENG-1: move ENG-1 before ENG-2.",
      code: "blocked_order",
    });
    expect(await db.select().from(sprints)).toHaveLength(0);

    // A blocker outside the sprint doesn't count.
    await created({ epics: [workItemId(issues.b!)] });
  });

  it("keeps a work item in at most one active sprint", async () => {
    const first = await created({ name: "First", epics: [workItemId(issues.a!)] });
    const again = await create({
      name: "Second",
      epics: [workItemId(issues.c!), workItemId(issues.a!)],
    });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({
      code: "in_other_sprint",
      fieldErrors: { "epics.1": expect.stringContaining("“First”") },
    });
    expect(again.body.error).toMatch(/^ENG-1 is already in the sprint “First”/);

    const second = await created({ name: "Second", epics: [workItemId(issues.c!)] });
    const moved = await patch(second.id, { epics: [workItemId(issues.a!)] });
    expect(moved.status).toBe(409);

    // Once its sprint is over, the work item can join another.
    await db.update(sprints).set({ status: "done" }).where(eq(sprints.id, first.id));
    expect((await patch(second.id, { epics: [workItemId(issues.a!)] })).status).toBe(200);
  });

  it("renames, switches merge together and reorders a draft sprint", async () => {
    const sprint = await created({
      epics: [workItemId(issues.a!), workItemId(issues.c!), workItemId(issues.b!)],
    });
    const renamed = await patch(sprint.id, { name: "Renamed", mergeTogether: true });
    expect(renamed.status).toBe(200);
    expect(savedSprintSchema.parse(renamed.body).sprint).toMatchObject({
      name: "Renamed",
      mergeTogether: true,
    });

    const { result, changes } = await captureChanges(() =>
      patch(sprint.id, {
        epics: [workItemId(issues.c!), workItemId(issues.a!), workItemId(issues.standalone!)],
      }),
    );
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const reordered = savedSprintSchema.parse(result.body).sprint;
    expect(reordered.name).toBe("Renamed");
    expect(reordered.epics.map((e) => [e.identifier, e.position])).toEqual([
      ["ENG-3", 0],
      ["ENG-1", 1],
      ["ENG-4", 2],
    ]);
    // The sprint, and the work items that left or joined it.
    expect(changes.map((c) => [c.resource, [...c.ids].sort()])).toEqual(
      expect.arrayContaining([
        ["sprint", [sprint.id]],
        ["work_item", [workItemId(issues.b!), workItemId(issues.standalone!)].sort()],
      ]),
    );

    const blocked = await patch(sprint.id, {
      epics: [workItemId(issues.b!), workItemId(issues.a!)],
    });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toBe("ENG-2 is blocked by ENG-1: move ENG-1 before ENG-2.");
  });

  it("deletes a draft sprint, freeing its epics", async () => {
    const sprint = await created({ epics: [workItemId(issues.a!)] });
    const { result, changes } = await captureChanges(() => remove(sprint.id));
    expect(result.status).toBe(200);
    expect(changes.map((c) => [c.resource, c.ids])).toEqual(
      expect.arrayContaining([
        ["sprint", [sprint.id]],
        ["work_item", [workItemId(issues.a!)]],
      ]),
    );
    expect(await db.select().from(sprints)).toHaveLength(0);
    expect((await call(one.GET as Handler, "GET", { id: sprint.id })).status).toBe(404);
    await created({ epics: [workItemId(issues.a!)] });
  });

  it("changes and deletes only draft sprints", async () => {
    const sprint = await created({});
    await db.update(sprints).set({ status: "running" }).where(eq(sprints.id, sprint.id));
    const renamed = await patch(sprint.id, { name: "New" });
    expect(renamed.status).toBe(409);
    expect(renamed.body.code).toBe("not_draft");
    expect((await remove(sprint.id)).status).toBe(409);
    expect(await db.select().from(sprints)).toHaveLength(1);
  });

  it("answers 404 for an unknown sprint or another organization's", async () => {
    const [foreign] = await db
      .insert(sprints)
      .values({ organizationId: otherOrgId, repositoryId: otherOrgRepoId, name: "Theirs" })
      .returning();
    for (const id of [foreign!.id, "00000000-0000-4000-8000-000000000000", "nope"]) {
      expect((await call(one.GET as Handler, "GET", { id })).status).toBe(404);
      expect((await patch(id, { name: "Mine" })).status).toBe(404);
      expect((await remove(id)).status).toBe(404);
    }
  });
});
