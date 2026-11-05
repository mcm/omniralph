import { randomBytes, randomUUID } from "node:crypto";
import {
  closeDb,
  connectRepository,
  createDb,
  createFeature,
  createOrganization,
  createRun,
  getMainLane,
  linkFeatureEpic,
  updateLane,
  updateRun,
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
import { featureProgressSchema } from "@/lib/api/features";
import { ApiRouteError } from "@/lib/api/handler";
import type { OrgUser } from "@/lib/auth/session";
import { fakeWorkItemTracker } from "@/lib/testing/work-item-tracker";
import { TrackerNotConnectedError, type WorkItemTracker } from "@/lib/work-items/tracker";
import {
  loadFeatureProgress,
  TRACKER_NOT_CONNECTED_PROBLEM,
  TRACKER_READ_PROBLEM,
} from "./progress";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn() }));

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("a feature's epic progress", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let otherOrgId: string;
  let repoId: string;
  let user: OrgUser;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    await db.insert(users).values([
      { id: "planner", name: "Ada" },
      { id: "stranger", name: "Grace" },
    ]);
    orgId = (await createOrganization(db, { name: "Acme", createdBy: "planner" })).id;
    otherOrgId = (await createOrganization(db, { name: "Other", createdBy: "stranger" })).id;
    user = { id: "planner", role: "member", organization: { id: orgId, name: "Acme" } } as OrgUser;
    const connection = (await upsertScmConnection(
      db,
      {
        organizationId: orgId,
        provider: "github",
        name: "acme",
        baseUrl: "https://api.github.com",
        externalId: "1",
        credentials: {},
      },
      randomBytes(32),
    ))!;
    repoId = (
      await connectRepository(db, {
        connectionId: connection.id,
        provider: "github",
        externalId: "1",
        fullPath: "acme/portal",
      })
    ).id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  async function feature(organizationId = orgId): Promise<string> {
    const created = await createFeature(db, {
      organizationId,
      name: `Feature ${randomUUID()}`,
      repositoryId: null,
      createdBy: null,
    });
    if (created.status !== "created") throw new Error(created.status);
    return created.feature.id;
  }

  const link = (featureId: string, externalId: string) =>
    linkFeatureEpic(db, { featureId, organizationId: orgId, tracker: "linear", externalId });

  /** A tracker run of the epic, with its main lane's PR when `pr` is given. */
  async function run(
    issue: { id: string; identifier: string },
    status: "running" | "completed" | "failed",
    pr?: { number: number; merged?: boolean; draft?: boolean },
  ): Promise<string> {
    const { run } = await createRun(db, {
      origin: "tracker",
      organizationId: orgId,
      trackerIssueId: issue.id,
      trackerIdentifier: issue.identifier,
      trackerTitle: `Run of ${issue.identifier}`,
      trackerUrl: `https://linear.app/acme/issue/${issue.identifier}`,
      trackerSessionId: `session-${randomUUID()}`,
      kind: "prd",
      repositoryId: repoId,
      branch: `omniralph/${issue.identifier.toLowerCase()}`,
      baseBranch: "main",
    });
    if (pr) {
      const lane = (await getMainLane(db, run))!;
      await updateLane(db, lane.id, {
        prNumber: pr.number,
        prUrl: `https://github.com/acme/portal/pull/${pr.number}`,
        prDraft: pr.draft ?? false,
        prMerged: pr.merged ?? false,
        prClosed: pr.merged ?? false,
      });
    }
    await updateRun(db, run.id, { status });
    return run.id;
  }

  const load = (featureId: string, tracker: () => Promise<WorkItemTracker>) =>
    loadFeatureProgress({ db, tracker }, user, featureId);

  it("has no epics and nothing done for a feature that wasn't sharded", async () => {
    const { tracker } = fakeWorkItemTracker();
    expect(await load(await feature(), async () => tracker)).toEqual({
      epics: [],
      rollup: { epicsDone: 0, epicsTotal: 0, storiesDone: 0, storiesTotal: 0 },
      trackerProblem: null,
    });
  });

  it("shows each epic's state, stories, latest run and PRs, and rolls up the counted ones", async () => {
    const { tracker, workspace } = fakeWorkItemTracker();
    const done = workspace.add({
      id: "issue-done",
      identifier: "ENG-10",
      title: "Invoice model",
      stateType: "completed",
      stateName: "Done",
    });
    for (const stateType of ["completed", "completed", "canceled"] as const) {
      workspace.add({ title: "Story", parentId: done.id, stateType });
    }
    const working = workspace.add({
      id: "issue-working",
      identifier: "ENG-20",
      title: "Send invoices",
      stateType: "started",
      stateName: "In Progress",
    });
    for (const stateType of ["completed", "started", "unstarted"] as const) {
      workspace.add({ title: "Story", parentId: working.id, stateType });
    }
    const dropped = workspace.add({
      id: "issue-dropped",
      identifier: "ENG-30",
      title: "Paper invoices",
      stateType: "canceled",
      stateName: "Canceled",
    });
    const featureId = await feature();
    for (const issue of [done, working, dropped]) await link(featureId, issue.id);

    const doneRun = await run(done, "completed", { number: 41, merged: true });
    await run(working, "failed", { number: 40 });
    const workingRun = await run(working, "running", { number: 42, draft: true });

    const progress = featureProgressSchema.parse(await load(featureId, async () => tracker));
    expect(progress.epics).toEqual([
      {
        workItemId: "linear-issue-done",
        identifier: "ENG-10",
        title: "Invoice model",
        url: done.url,
        state: { category: "done", name: "Done" },
        stories: { done: 2, total: 2 },
        run: { id: doneRun, status: "completed" },
        pullRequests: [
          {
            number: 41,
            url: "https://github.com/acme/portal/pull/41",
            state: "merged",
            host: "github",
          },
        ],
      },
      {
        workItemId: "linear-issue-working",
        identifier: "ENG-20",
        title: "Send invoices",
        url: working.url,
        state: { category: "in_progress", name: "In Progress" },
        stories: { done: 1, total: 3 },
        // The latest run, not the failed one before it.
        run: { id: workingRun, status: "running" },
        pullRequests: [
          {
            number: 42,
            url: "https://github.com/acme/portal/pull/42",
            state: "draft",
            host: "github",
          },
        ],
      },
      {
        workItemId: "linear-issue-dropped",
        identifier: "ENG-30",
        title: "Paper invoices",
        url: dropped.url,
        state: { category: "canceled", name: "Canceled" },
        stories: { done: 0, total: 0 },
        run: null,
        pullRequests: [],
      },
    ]);
    // The canceled epic counts in neither.
    expect(progress.rollup).toEqual({
      epicsDone: 1,
      epicsTotal: 2,
      storiesDone: 3,
      storiesTotal: 5,
    });
    expect(progress.trackerProblem).toBeNull();
  });

  it("lists the epics from their runs when the tracker isn't connected", async () => {
    const featureId = await feature();
    const issue = { id: "issue-offline", identifier: "ENG-50" };
    await link(featureId, issue.id);
    const runId = await run(issue, "running");

    const progress = await load(featureId, async () => {
      throw new TrackerNotConnectedError();
    });
    expect(progress.trackerProblem).toBe(TRACKER_NOT_CONNECTED_PROBLEM);
    expect(progress.epics).toEqual([
      {
        workItemId: "linear-issue-offline",
        identifier: "ENG-50",
        title: "Run of ENG-50",
        url: "https://linear.app/acme/issue/ENG-50",
        state: null,
        stories: null,
        run: { id: runId, status: "running" },
        pullRequests: [],
      },
    ]);
    expect(progress.rollup).toEqual({
      epicsDone: 0,
      epicsTotal: 1,
      storiesDone: 0,
      storiesTotal: 0,
    });
  });

  it("says the tracker couldn't be read when an epic's read fails, keeping the others", async () => {
    const { tracker, workspace } = fakeWorkItemTracker();
    const readable = workspace.add({
      id: "issue-readable",
      title: "Readable",
      stateType: "completed",
    });
    const featureId = await feature();
    await link(featureId, readable.id);
    await link(featureId, "issue-flaky");
    const flaky: WorkItemTracker = Object.assign(Object.create(tracker) as WorkItemTracker, {
      get: async (ref: string) => {
        if (ref === "issue-flaky") throw new Error("Linear is down");
        return tracker.get(ref);
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const progress = await load(featureId, async () => flaky);
    warn.mockRestore();
    expect(progress.trackerProblem).toBe(TRACKER_READ_PROBLEM);
    expect(progress.epics.map((epic) => epic.state?.category ?? null)).toEqual(["done", null]);
    expect(progress.epics[1]!.identifier).toBeNull();
    expect(progress.rollup.epicsDone).toBe(1);
    expect(progress.rollup.epicsTotal).toBe(2);
  });

  it("refuses another organization's feature", async () => {
    const { tracker } = fakeWorkItemTracker();
    const theirs = await feature(otherOrgId);
    await expect(load(theirs, async () => tracker)).rejects.toMatchObject({
      constructor: ApiRouteError,
      status: 404,
    });
  });
});
