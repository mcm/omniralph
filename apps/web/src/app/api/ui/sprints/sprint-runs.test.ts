import { randomBytes, randomUUID } from "node:crypto";
import {
  closeDb,
  connectRepository,
  createDb,
  createOrganization,
  createRun,
  createSprint,
  ensureLane,
  findings,
  getMainLane,
  getSprint,
  ralphRuns,
  reviewRuns,
  reviews,
  setSprintEpicState,
  sprintEpics,
  saveIntegration,
  sprints,
  updateLane,
  updateRun,
  upsertScmConnection,
  users,
  type Database,
  type RalphLane,
  type RalphRun,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { FakeLinearGateway } from "@omniralph/tracker/linear/testing";
import type { IssueSummary } from "@omniralph/tracker";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { savedSprintSchema, type SprintRow } from "@/lib/api/sprints";
import { assertRole, type Role } from "@/lib/auth/roles";
import {
  sprintEpicPullRequestClosed,
  sprintEpicRunEnded,
  sprintEpicStartRefused,
  sprintRunDeps,
  startRefusal,
} from "@/lib/sprints/run";
import { PostgresDispatcher } from "@/lib/dispatch/dispatcher";
import type { RalphDeps } from "@/lib/ralph/run";
import { FakeScmAdapter } from "@/lib/scm/fake-adapter";
import type * as ScmAdapters from "@/lib/scm/adapters";
import { laneBaseBranch, sprintBranchName } from "@/lib/sprints/branch";
import { mergeSprintEpicWhenClean } from "@/lib/sprints/merge";
import { sprintPullRequestClosedReason } from "@/lib/sprints/pull-request";
import { handleWebhook } from "@/lib/webhooks/ingest";
import type * as LinearClient from "@/lib/tracker/linear/client";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  orgId: "",
  role: "admin" as Role,
  linear: new Map<string, FakeLinearGateway>(),
  scm: undefined as unknown as FakeScmAdapter,
}));
vi.mock("@/lib/scm/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof ScmAdapters>()),
  scmAdapterFor: () => state.scm.asAdapter(),
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
process.env.CRON_SECRET = "cron-secret";

const routes = {
  start: await import("./[id]/start/route"),
  pause: await import("./[id]/pause/route"),
  resume: await import("./[id]/resume/route"),
  cancel: await import("./[id]/cancel/route"),
};
const { GET: sprintCheck } = await import("../../cron/sprint-check/route");

type Handler = (
  request: Request,
  route: { params: Promise<Record<string, string>> },
) => Promise<Response>;

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("running a sprint", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let repoId: string;
  let otherRepoId: string;
  let linear: FakeLinearGateway;

  const act = async (action: keyof typeof routes, id: string) => {
    const response = await (routes[action].POST as Handler)(
      new Request(`http://localhost/api/ui/sprints/${id}/${action}`, { method: "POST" }),
      { params: Promise.resolve({ id }) },
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  /** Runs an action the API accepts; answers the sprint it returns. */
  const accepted = async (action: keyof typeof routes, id: string): Promise<SprintRow> => {
    const result = await act(action, id);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    return savedSprintSchema.parse(result.body).sprint;
  };

  /** A Ready to start epic: a work item with a sub-issue. */
  const epic = (identifier: string, partial: Partial<IssueSummary> = {}) => {
    const issue = linear.add({
      // Unique across tests: the runs of earlier tests stay.
      id: `issue-${randomUUID()}`,
      identifier,
      title: `Epic ${identifier}`,
      stateType: "unstarted",
      stateName: "Todo",
      ...partial,
    });
    linear.add({ title: `Story of ${identifier}`, parentId: issue.id });
    return issue;
  };

  const sprintOf = async (
    issues: IssueSummary[],
    options: { mergeTogether?: boolean } = {},
  ): Promise<string> => {
    const result = await createSprint(db, {
      organizationId: orgId,
      repositoryId: repoId,
      name: "Q4",
      mergeTogether: options.mergeTogether ?? false,
      epics: issues.map((issue) => ({
        tracker: "linear",
        externalId: issue.id,
        identifier: issue.identifier,
        title: issue.title,
      })),
      createdBy: null,
    });
    if (result.status !== "created") throw new Error(result.status);
    return result.sprint.id;
  };

  const stored = async (id: string) => (await getSprint(db, orgId, id))!;
  const epicStates = async (id: string) => (await stored(id)).epics.map((e) => e.state);
  const delegated = (issue: IssueSummary) => linear.delegateOf(issue.id) === linear.viewer.id;
  const deps = () => sprintRunDeps({ db, organizationId: orgId, tracker: linear });

  /** The run the agent session webhook starts for a delegated epic, with its PR opened. */
  const runOf = async (issue: IssueSummary): Promise<{ run: RalphRun; lane: RalphLane }> => {
    const { run } = await createRun(db, {
      origin: "tracker",
      organizationId: orgId,
      trackerIssueId: issue.id,
      trackerIdentifier: issue.identifier,
      trackerSessionId: `session-${randomUUID()}`,
      kind: "prd",
      repositoryId: repoId,
      branch: issue.branchName,
      baseBranch: "main",
    });
    const lane = (await getMainLane(db, run))!;
    const opened = (await updateLane(db, lane.id, {
      prNumber: 7,
      prUrl: `https://github.com/acme/api/pull/${issue.identifier}`,
    }))!;
    return { run, lane: opened };
  };

  /** The code host's merge (or close) webhook, as `recordClosedPullRequest` records it. */
  const closePullRequest = async (lane: RalphLane, merged: boolean) => {
    const closed = (await updateLane(db, lane.id, { prClosed: true, prMerged: merged }))!;
    await sprintEpicPullRequestClosed(deps(), closed);
  };
  const merge = async (issue: IssueSummary) => {
    const { run, lane } = await runOf(issue);
    await updateRun(db, run.id, { status: "completed" });
    await closePullRequest(lane, true);
  };

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    await db.insert(users).values([{ id: "sprint-user", name: "Ada" }]);
    const org = await createOrganization(db, { name: "Acme", createdBy: "sprint-user" });
    orgId = org.id;
    state.orgId = orgId;
    const connection = (await upsertScmConnection(
      db,
      {
        organizationId: orgId,
        provider: "github",
        name: "acme",
        baseUrl: "https://api.github.com",
        // The installation the code host's webhooks name.
        externalId: "1",
        credentials: {},
      },
      randomBytes(32),
    ))!;
    repoId = (
      await connectRepository(db, {
        connectionId: connection.id,
        provider: "github",
        // The repository ID the code host's webhooks name.
        externalId: "1",
        fullPath: "acme/api",
      })
    ).id;
    otherRepoId = (
      await connectRepository(db, {
        connectionId: connection.id,
        provider: "github",
        externalId: "acme/web",
        fullPath: "acme/web",
      })
    ).id;
    const integration = await saveIntegration(db, {
      organizationId: orgId,
      provider: "linear",
      externalId: "workspace-acme",
      name: "Acme",
      credentials: { accessToken: "t" },
      installedByUserId: null,
    });
    if (integration === "other_organization") throw new Error("setup");
  });

  beforeEach(async () => {
    state.role = "admin";
    linear = new FakeLinearGateway();
    state.linear.set(orgId, linear);
    state.scm = new FakeScmAdapter();
    state.scm.defaultBranch = "main";
    state.scm.branchHeads.set("acme/api:main", "main-1");
    await db.delete(sprints);
  });

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  it("starts each of three epics only after the one before it merges, then is done", async () => {
    const [a, b, c] = [epic("ENG-1"), epic("ENG-2"), epic("ENG-3")];
    const id = await sprintOf([a, b, c]);

    const started = await accepted("start", id);
    expect(started.status).toBe("running");
    expect(started.pausedReason).toBeNull();
    expect(started.epics.map((e) => e.state)).toEqual(["running", "queued", "queued"]);
    // Through Start epic: the first epic is delegated to Om, and only it.
    expect([delegated(a), delegated(b), delegated(c)]).toEqual([true, false, false]);

    // Its run opening a PR starts nothing more.
    const first = await runOf(a);
    expect(await epicStates(id)).toEqual(["running", "queued", "queued"]);
    expect(delegated(b)).toBe(false);

    await updateRun(db, first.run.id, { status: "completed" });
    await closePullRequest(first.lane, true);
    expect(await epicStates(id)).toEqual(["merged", "running", "queued"]);
    expect([delegated(b), delegated(c)]).toEqual([true, false]);

    await merge(b);
    expect(await epicStates(id)).toEqual(["merged", "merged", "running"]);
    expect(delegated(c)).toBe(true);
    expect((await stored(id)).status).toBe("running");

    await merge(c);
    const done = await stored(id);
    expect(done.status).toBe("done");
    expect(done.epics.map((e) => e.state)).toEqual(["merged", "merged", "merged"]);
  });

  it("keeps a merge-together sprint running after its last epic, for its sprint PR", async () => {
    const a = epic("ENG-10");
    const id = await sprintOf([a], { mergeTogether: true });
    await accepted("start", id);
    await merge(a);
    const sprint = await stored(id);
    expect(sprint.status).toBe("running");
    expect(sprint.epics.map((e) => e.state)).toEqual(["merged"]);
    expect(sprint.sprintPrNumber).not.toBeNull();
  });

  it("waits for every PR of an epic's run to merge", async () => {
    const [a, b] = [epic("ENG-15"), epic("ENG-16")];
    const id = await sprintOf([a, b]);
    await accepted("start", id);
    const { run, lane } = await runOf(a);
    // A story of the epic built in another repo: a second PR.
    const other = (await updateLane(
      db,
      (
        await ensureLane(db, {
          runId: run.id,
          repositoryId: otherRepoId,
          branch: "eng-15",
          baseBranch: "main",
        })
      ).id,
      { prNumber: 3, prUrl: "https://github.com/acme/web/pull/3" },
    ))!;
    await closePullRequest(lane, true);
    expect(await epicStates(id)).toEqual(["running", "queued"]);
    expect(delegated(b)).toBe(false);
    await closePullRequest(other, true);
    expect(await epicStates(id)).toEqual(["merged", "running"]);
    expect(delegated(b)).toBe(true);
  });

  it("pauses with the reason when Start epic refuses an epic, and resume retries it", async () => {
    const [a, b] = [epic("ENG-20", { stateType: "backlog", stateName: "Backlog" }), epic("ENG-21")];
    const id = await sprintOf([a, b]);

    const paused = await accepted("start", id);
    expect(paused.status).toBe("paused");
    expect(paused.pausedReason).toBe(
      "Om didn't start ENG-20: Only a work item that's Ready to start can be started.",
    );
    expect(paused.epics.map((e) => e.state)).toEqual(["stalled", "queued"]);
    expect([delegated(a), delegated(b)]).toEqual([false, false]);

    // Resumed before it's fixed: refused again, the same way.
    expect((await accepted("resume", id)).pausedReason).toBe(paused.pausedReason);

    await linear.setIssueState(a.id, { type: "unstarted" });
    const resumed = await accepted("resume", id);
    expect(resumed.status).toBe("running");
    expect(resumed.pausedReason).toBeNull();
    expect(resumed.epics.map((e) => e.state)).toEqual(["running", "queued"]);
    expect([delegated(a), delegated(b)]).toEqual([true, false]);
  });

  it("pauses when the run's own start is refused (open questions), and resume delegates it again", async () => {
    const [a, b] = [epic("ENG-30"), epic("ENG-31")];
    const id = await sprintOf([a, b]);
    await accepted("start", id);
    expect(delegated(a)).toBe(true);

    // The agent session webhook refused to build it.
    const why = startRefusal({ status: "open_questions", identifier: "ENG-30" })!;
    await sprintEpicStartRefused({ db, organizationId: orgId, tracker: linear }, a.id, why);
    const paused = await stored(id);
    expect(paused.status).toBe("paused");
    expect(paused.pausedReason).toBe(
      "Om didn't start ENG-30: the PRD of ENG-30 still has open questions.",
    );
    expect(paused.epics.map((e) => e.state)).toEqual(["stalled", "queued"]);

    // Already delegated: resuming opens a new agent session on it, so it's handled again.
    expect(linear.sessionsCreated).toEqual([]);
    const resumed = await accepted("resume", id);
    expect(resumed.status).toBe("running");
    expect(resumed.epics.map((e) => e.state)).toEqual(["running", "queued"]);
    expect(linear.sessionsCreated.map((s) => s.issueId)).toEqual([a.id]);
    expect(delegated(b)).toBe(false);
  });

  it("ignores a refused start of an item that isn't a running sprint epic", async () => {
    const [a, b] = [epic("ENG-35"), epic("ENG-36")];
    const id = await sprintOf([a, b]);
    await accepted("start", id);
    await sprintEpicStartRefused({ db, organizationId: orgId, tracker: linear }, b.id, "no");
    expect((await stored(id)).status).toBe("running");
    expect(await epicStates(id)).toEqual(["running", "queued"]);
  });

  it.each([
    ["failed", "ENG-40's run failed: The run's repository is no longer connected, so I stopped."],
    ["stopped", "ENG-40's run was stopped."],
  ] as const)(
    "pauses when the epic's run %s, and resume starts it again",
    async (status, reason) => {
      const [a, b] = [epic("ENG-40"), epic("ENG-41")];
      const id = await sprintOf([a, b]);
      await accepted("start", id);
      const { run } = await runOf(a);
      const ended = (await updateRun(db, run.id, {
        status,
        error:
          status === "failed" ? "The run's repository is no longer connected, so I stopped." : null,
      }))!;
      await sprintEpicRunEnded({ db, organizationId: orgId }, ended);
      const paused = await stored(id);
      expect(paused.status).toBe("paused");
      expect(paused.pausedReason).toBe(reason);
      expect(paused.epics.map((e) => e.state)).toEqual(["stalled", "queued"]);

      const resumed = await accepted("resume", id);
      expect(resumed.status).toBe("running");
      expect(resumed.epics.map((e) => e.state)).toEqual(["running", "queued"]);
      // Delegated again although it has a run: a new session on the item.
      expect(linear.sessionsCreated.map((s) => s.issueId)).toEqual([a.id]);
      expect(delegated(b)).toBe(false);
    },
  );

  it("pauses when an epic's PR closes without merging", async () => {
    const [a, b] = [epic("ENG-50"), epic("ENG-51")];
    const id = await sprintOf([a, b]);
    await accepted("start", id);
    const { lane } = await runOf(a);
    await closePullRequest(lane, false);
    const paused = await stored(id);
    expect(paused.status).toBe("paused");
    expect(paused.pausedReason).toBe("ENG-50's PR was closed without merging.");
    expect(paused.epics.map((e) => e.state)).toEqual(["stalled", "queued"]);
    expect(delegated(b)).toBe(false);
  });

  it("pausing starts no new epic, but a merge still counts; resuming starts the next", async () => {
    const [a, b] = [epic("ENG-60"), epic("ENG-61")];
    const id = await sprintOf([a, b]);
    await accepted("start", id);

    const paused = await accepted("pause", id);
    expect(paused.status).toBe("paused");
    expect(paused.pausedReason).toBe("Paused by Ada.");
    expect(paused.epics.map((e) => e.state)).toEqual(["running", "queued"]);

    await merge(a);
    expect(await epicStates(id)).toEqual(["merged", "queued"]);
    expect(delegated(b)).toBe(false);

    const resumed = await accepted("resume", id);
    expect(resumed.status).toBe("running");
    expect(resumed.epics.map((e) => e.state)).toEqual(["merged", "running"]);
    expect(delegated(b)).toBe(true);
  });

  it("cancel stops starting new epics and leaves the running one alone", async () => {
    const [a, b] = [epic("ENG-70"), epic("ENG-71")];
    const id = await sprintOf([a, b]);
    await accepted("start", id);
    const { run } = await runOf(a);

    const canceled = await accepted("cancel", id);
    expect(canceled.status).toBe("canceled");
    expect(canceled.epics.map((e) => e.state)).toEqual(["running", "queued"]);

    await updateRun(db, run.id, { status: "completed" });
    const lane = (await getMainLane(db, run))!;
    await closePullRequest(lane, true);
    expect(await epicStates(id)).toEqual(["running", "queued"]);
    expect(delegated(b)).toBe(false);
    expect((await stored(id)).status).toBe("canceled");
    // Over: it doesn't resume or cancel again.
    expect((await act("resume", id)).status).toBe(409);
    expect((await act("cancel", id)).status).toBe(409);
  });

  it("counts an epic whose run's PR already merged, and moves on", async () => {
    const [a, b] = [epic("ENG-80"), epic("ENG-81")];
    const { run, lane } = await runOf(a);
    await updateRun(db, run.id, { status: "completed" });
    await updateLane(db, lane.id, { prClosed: true, prMerged: true });
    const id = await sprintOf([a, b]);
    const started = await accepted("start", id);
    expect(started.epics.map((e) => e.state)).toEqual(["merged", "running"]);
    expect([delegated(a), delegated(b)]).toEqual([false, true]);
  });

  it("refuses actions the sprint's status doesn't allow, an empty sprint, and members", async () => {
    const id = await sprintOf([epic("ENG-90")]);
    expect(await act("pause", id)).toMatchObject({
      status: 409,
      body: { code: "wrong_status", error: "“Q4” is draft: only a running sprint can be paused." },
    });
    expect((await act("resume", id)).status).toBe(409);
    // A draft is deleted, not canceled.
    expect((await act("cancel", id)).status).toBe(409);
    const empty = await sprintOf([]);
    expect(await act("start", empty)).toMatchObject({ status: 400, body: { code: "empty" } });
    expect((await act("start", randomUUID())).status).toBe(404);
    state.role = "member";
    expect((await act("start", id)).status).toBe(403);
    expect((await stored(id)).status).toBe("draft");
  });

  describe("the sprint check cron", () => {
    /** Runs the cron; answers its counts. */
    const check = async () => {
      const response = await sprintCheck(
        new Request("http://localhost/api/cron/sprint-check", {
          headers: { authorization: "Bearer cron-secret" },
        }),
      );
      expect(response.status).toBe(200);
      return (await response.json()) as Record<string, number>;
    };
    /** Moves when the sprint's running epic was claimed `ms` into the past. */
    const claimedAgo = async (id: string, ms: number) => {
      const running = (await stored(id)).epics.find((e) => e.state === "running")!;
      await db
        .update(sprintEpics)
        .set({ updatedAt: new Date(Date.now() - ms) })
        .where(eq(sprintEpics.id, running.id));
    };

    it("pauses a sprint whose running epic's run never began, once it's been a while", async () => {
      const [a, b] = [epic("ENG-100"), epic("ENG-101")];
      const id = await sprintOf([a, b]);
      await accepted("start", id);

      // Just claimed: its run may still begin.
      expect(await check()).toMatchObject({ checked: 1, paused: 0 });
      expect((await stored(id)).status).toBe("running");

      // 40 minutes without a run: Om died before delegating it, or the webhook never came.
      await claimedAgo(id, 40 * 60_000);
      expect(await check()).toMatchObject({ checked: 1, paused: 1 });
      const paused = await stored(id);
      expect(paused.status).toBe("paused");
      expect(paused.pausedReason).toBe("Om started ENG-100, but its run never began.");
      expect(paused.epics.map((e) => e.state)).toEqual(["stalled", "queued"]);
      // A paused sprint isn't checked again.
      expect(await check()).toMatchObject({ checked: 0 });

      // Resuming starts it again.
      const resumed = await accepted("resume", id);
      expect(resumed.epics.map((e) => e.state)).toEqual(["running", "queued"]);
      expect(delegated(a)).toBe(true);
      expect(delegated(b)).toBe(false);
    });

    it("leaves an epic whose run is working alone, however long ago it started", async () => {
      const [a, b] = [epic("ENG-105"), epic("ENG-106")];
      const id = await sprintOf([a, b]);
      await accepted("start", id);
      await runOf(a);
      await claimedAgo(id, 5 * 3600_000);
      expect(await check()).toMatchObject({ checked: 1, paused: 0, merged: 0 });
      expect((await stored(id)).status).toBe("running");
      expect(await epicStates(id)).toEqual(["running", "queued"]);
    });

    it("waits for a retried epic's new run, ignoring the failed run before it", async () => {
      const [a, b] = [epic("ENG-110"), epic("ENG-111")];
      // An earlier attempt of the epic failed, before the sprint started.
      const { run } = await runOf(a);
      await updateRun(db, run.id, { status: "failed", error: "Out of retries." });
      const hourAgo = new Date(Date.now() - 3600_000);
      await db
        .update(ralphRuns)
        .set({ createdAt: hourAgo, updatedAt: hourAgo })
        .where(eq(ralphRuns.id, run.id));
      const id = await sprintOf([a, b]);
      await accepted("start", id);
      expect(delegated(a)).toBe(true);

      expect(await check()).toMatchObject({ checked: 1, paused: 0 });
      expect((await stored(id)).status).toBe("running");

      // Its new run never began either.
      await claimedAgo(id, 40 * 60_000);
      await check();
      expect((await stored(id)).pausedReason).toBe("Om started ENG-110, but its run never began.");
    });

    it.each([
      ["failed", "ENG-120's run failed: The agent crashed."],
      ["stopped", "ENG-120's run was stopped."],
    ] as const)(
      "pauses the sprint when the epic's run %s without its hook pausing it",
      async (status, reason) => {
        const [a, b] = [epic("ENG-120"), epic("ENG-121")];
        const id = await sprintOf([a, b]);
        await accepted("start", id);
        const { run } = await runOf(a);
        // The run ended, but `sprintEpicRunEnded` never ran.
        await updateRun(db, run.id, {
          status,
          error: status === "failed" ? "The agent crashed." : null,
        });
        expect((await stored(id)).status).toBe("running");

        expect(await check()).toMatchObject({ checked: 1, paused: 1 });
        const paused = await stored(id);
        expect(paused.status).toBe("paused");
        expect(paused.pausedReason).toBe(reason);
        expect(paused.epics.map((e) => e.state)).toEqual(["stalled", "queued"]);
        expect(delegated(b)).toBe(false);
      },
    );

    it("pauses when the epic's run completed without opening a PR", async () => {
      const a = epic("ENG-125");
      const id = await sprintOf([a, epic("ENG-126")]);
      await accepted("start", id);
      const { run, lane } = await runOf(a);
      await updateLane(db, lane.id, { prNumber: null, prUrl: null });
      await updateRun(db, run.id, { status: "completed" });
      await check();
      expect((await stored(id)).pausedReason).toBe("ENG-125's run finished without opening a PR.");
    });

    it("counts a merge whose hook never ran, and starts the next epic", async () => {
      const [a, b] = [epic("ENG-130"), epic("ENG-131")];
      const id = await sprintOf([a, b]);
      await accepted("start", id);
      const { run, lane } = await runOf(a);
      await updateRun(db, run.id, { status: "completed" });
      // Waiting for its PR's merge.
      expect(await check()).toMatchObject({ checked: 1, merged: 0, paused: 0 });
      await updateLane(db, lane.id, { prClosed: true, prMerged: true });

      expect(await check()).toMatchObject({ checked: 1, merged: 1 });
      expect(await epicStates(id)).toEqual(["merged", "running"]);
      expect(delegated(b)).toBe(true);
    });

    it("starts the next epic of a running sprint with nothing running", async () => {
      const [a, b] = [epic("ENG-140"), epic("ENG-141")];
      const id = await sprintOf([a, b]);
      await accepted("start", id);
      // The merge was recorded, but the next start was lost.
      const running = (await stored(id)).epics[0]!;
      await setSprintEpicState(db, {
        organizationId: orgId,
        epicId: running.id,
        from: ["running"],
        state: "merged",
      });
      expect(delegated(b)).toBe(false);

      expect(await check()).toMatchObject({ checked: 1, advanced: 1 });
      expect(await epicStates(id)).toEqual(["merged", "running"]);
      expect(delegated(b)).toBe(true);
    });
  });

  describe("merging together", () => {
    let scm: FakeScmAdapter;
    let prNumber = 100;
    beforeEach(() => {
      scm = state.scm;
    });

    const ralphDeps = (): RalphDeps => ({
      db,
      organizationId: orgId,
      tracker: linear,
      dispatcher: new PostgresDispatcher({ db }),
      adapterFor: () => scm.asAdapter(),
    });

    /** A started merge-together sprint of `issues`, its first epic running. */
    const started = async (issues: IssueSummary[]) => {
      const id = await sprintOf(issues, { mergeTogether: true });
      await accepted("start", id);
      const branch = (await stored(id)).sprintBranch!;
      return { id, branch };
    };

    /**
     * The epic's run, done working, with its PR into the sprint branch open on the code host
     * (head `head`).
     */
    const openPullRequest = async (issue: IssueSummary, branch: string, head = "head-1") => {
      prNumber += 1;
      const { run } = await createRun(db, {
        origin: "tracker",
        organizationId: orgId,
        trackerIssueId: issue.id,
        trackerIdentifier: issue.identifier,
        trackerSessionId: `session-${randomUUID()}`,
        kind: "prd",
        repositoryId: repoId,
        branch: issue.branchName,
        baseBranch: branch,
      });
      const lane = (await updateLane(db, (await getMainLane(db, run))!.id, {
        prNumber,
        prUrl: `https://github.com/acme/api/pull/${prNumber}`,
      }))!;
      await updateRun(db, run.id, { status: "completed" });
      scm.changeRequests.push({
        number: prNumber,
        url: lane.prUrl!,
        fullPath: "acme/api",
        sourceBranch: issue.branchName ?? `branch-${prNumber}`,
        targetBranch: branch,
        title: issue.title,
        body: "",
        draft: false,
        state: "open",
        headSha: head,
      });
      return { run, lane, number: prNumber };
    };

    const ciOf = (number: number, state: "pending" | "passed" | "failed", head = "head-1") =>
      scm.requiredChecks.set(`acme/api#${number}`, {
        state,
        headSha: head,
        checks: [{ name: "test", state, url: null }],
      });

    /** A finished review of the PR with one finding in `status`; returns the finding's ID. */
    const reviewWithFinding = async (
      number: number,
      status: "open" | "resolved" = "open",
      head = "head-1",
    ) => {
      const [reviewRun] = await db
        .insert(reviewRuns)
        .values({
          organizationId: orgId,
          repositoryId: repoId,
          prNumber: number,
          headSha: head,
          baseSha: "base",
          trigger: "webhook",
          mode: "incremental",
          status: "completed",
        })
        .returning();
      const [review] = await db
        .insert(reviews)
        .values({
          reviewRunId: reviewRun!.id,
          repositoryId: repoId,
          prNumber: number,
          headSha: head,
          baseSha: "base",
          trigger: "webhook",
          status: "completed",
          budget: 1000,
        })
        .returning();
      const [finding] = await db
        .insert(findings)
        .values({
          reviewId: review!.id,
          path: "src/app.ts",
          startLine: 1,
          endLine: 2,
          severity: "high",
          category: "bug",
          title: "Off by one",
          body: "The loop skips the last item.",
          confidence: 0.9,
          status,
        })
        .returning();
      return finding!.id;
    };

    it("creates the sprint branch from the default branch when it starts, and records it", async () => {
      const a = epic("ENG-200");
      const { id, branch } = await started([a]);
      const sprint = await stored(id);
      expect(branch).toBe(sprintBranchName(sprint));
      expect(branch).toMatch(/^sprint\/q4-[0-9a-f]{8}$/);
      // At the default branch's head, before the first epic was delegated.
      expect(scm.createdBranches.get(`acme/api:${branch}`)).toBe("main-1");
      expect(scm.calls.indexOf("createBranch")).toBeGreaterThan(-1);
      expect(delegated(a)).toBe(true);
      // Created already: nothing to bring up to date.
      expect(scm.branchMerges).toEqual([]);
    });

    it("bases the lanes of the sprint's epics in its repo on the sprint branch", async () => {
      const [a, outsider] = [epic("ENG-205"), epic("ENG-206")];
      const { branch } = await started([a]);
      const found = (await import("@omniralph/db")).getRepositoryWithConnection;
      const target = (await found(db, repoId))!;
      const other = (await found(db, otherRepoId))!;
      const deps = { db, organizationId: orgId, adapterFor: () => scm.asAdapter() };
      const base = (issue: IssueSummary, where: typeof target) =>
        laneBaseBranch(deps, {
          tracker: "linear",
          issueId: issue.id,
          connection: where.connection,
          repository: where.repository,
        });
      expect(await base(a, target)).toBe(branch);
      // Another repo of the run, and a work item that isn't in the sprint: the default branch.
      expect(await base(a, other)).toBe("main");
      expect(await base(outsider, target)).toBe("main");
    });

    it("bases nothing on a sprint branch for a sprint that doesn't merge together", async () => {
      const a = epic("ENG-207");
      const id = await sprintOf([a]);
      await accepted("start", id);
      expect((await stored(id)).sprintBranch).toBeNull();
      expect(scm.calls).not.toContain("createBranch");
      const target = (await (
        await import("@omniralph/db")
      ).getRepositoryWithConnection(db, repoId))!;
      await expect(
        laneBaseBranch(
          { db, organizationId: orgId, adapterFor: () => scm.asAdapter() },
          { tracker: "linear", issueId: a.id, ...target },
        ),
      ).resolves.toBe("main");
    });

    it("doesn't merge while CI is red, and merges once it's green and nothing is open", async () => {
      const [a, b] = [epic("ENG-210"), epic("ENG-211")];
      const { id, branch } = await started([a, b]);
      const { lane, number } = await openPullRequest(a, branch);

      ciOf(number, "failed");
      expect(await mergeSprintEpicWhenClean(ralphDeps(), lane.id)).toEqual({
        status: "waiting",
        why: "checks_failed",
      });
      ciOf(number, "pending");
      expect(await mergeSprintEpicWhenClean(ralphDeps(), lane.id)).toEqual({
        status: "waiting",
        why: "checks_pending",
      });
      expect(scm.approvals).toEqual([]);
      expect(scm.calls).not.toContain("mergePullRequest");
      expect(await epicStates(id)).toEqual(["running", "queued"]);

      ciOf(number, "passed");
      expect(await mergeSprintEpicWhenClean(ralphDeps(), lane.id)).toEqual({ status: "merged" });
      // Approved and merged pinned to the head that passed.
      expect(scm.approvals).toEqual([`acme/api#${number}@head-1`]);
      expect(scm.changeRequests.find((c) => c.number === number)!.state).toBe("merged");
      // The epic merged; the sprint branch was brought up to date before the next one started.
      expect(await epicStates(id)).toEqual(["merged", "running"]);
      expect(delegated(b)).toBe(true);
      expect(scm.branchMerges).toEqual([
        { fullPath: "acme/api", into: branch, from: "main", message: `Update ${branch} from main` },
      ]);
    });

    it("falls back to the PR's CI when its target branch requires no checks", async () => {
      const a = epic("ENG-215");
      const { branch } = await started([a]);
      const { lane, number } = await openPullRequest(a, branch);
      scm.ciStatuses.set(`acme/api#${number}`, {
        state: "failed",
        headSha: "head-1",
        failedJobs: [],
      });
      expect(await mergeSprintEpicWhenClean(ralphDeps(), lane.id)).toEqual({
        status: "waiting",
        why: "checks_failed",
      });
    });

    it("doesn't merge while a review finding is open, and re-evaluates once it's addressed", async () => {
      const [a, b] = [epic("ENG-220"), epic("ENG-221")];
      const { id, branch } = await started([a, b]);
      const { lane, number } = await openPullRequest(a, branch);
      ciOf(number, "passed");
      const finding = await reviewWithFinding(number);

      expect(await mergeSprintEpicWhenClean(ralphDeps(), lane.id)).toEqual({
        status: "waiting",
        why: "findings",
      });
      expect(scm.calls).not.toContain("approvePullRequest");
      expect(scm.calls).not.toContain("mergePullRequest");

      // The fix push: the finding is resolved and a new review starts.
      await db.update(findings).set({ status: "resolved" }).where(eq(findings.id, finding));
      const [running] = await db
        .insert(reviewRuns)
        .values({
          organizationId: orgId,
          repositoryId: repoId,
          prNumber: number,
          headSha: "head-2",
          baseSha: "base",
          trigger: "webhook",
          mode: "incremental",
          status: "running",
        })
        .returning();
      scm.changeRequests.find((c) => c.number === number)!.headSha = "head-2";
      ciOf(number, "passed", "head-2");
      expect(await mergeSprintEpicWhenClean(ralphDeps(), lane.id)).toEqual({
        status: "waiting",
        why: "reviewing",
      });

      // Its review found something new.
      await db
        .update(reviewRuns)
        .set({ status: "completed" })
        .where(eq(reviewRuns.id, running!.id));
      const second = await reviewWithFinding(number, "open", "head-2");
      expect(await mergeSprintEpicWhenClean(ralphDeps(), lane.id)).toMatchObject({
        why: "findings",
      });

      await db.update(findings).set({ status: "dismissed" }).where(eq(findings.id, second));
      expect(await mergeSprintEpicWhenClean(ralphDeps(), lane.id)).toEqual({ status: "merged" });
      expect(scm.approvals).toEqual([`acme/api#${number}@head-2`]);
      expect(await epicStates(id)).toEqual(["merged", "running"]);
    });

    it("waits while the epic's run is still working", async () => {
      const a = epic("ENG-225");
      const { branch } = await started([a]);
      const { run, lane, number } = await openPullRequest(a, branch);
      ciOf(number, "passed");
      // A review's findings reopened the run.
      await updateRun(db, run.id, { status: "pending" });
      expect(await mergeSprintEpicWhenClean(ralphDeps(), lane.id)).toEqual({
        status: "waiting",
        why: "working",
      });
    });

    it("merges even when the code host refuses Om's approval of its own PR", async () => {
      const a = epic("ENG-230");
      const { id, branch } = await started([a]);
      const { lane, number } = await openPullRequest(a, branch);
      ciOf(number, "passed");
      scm.refusals.set("approve", {
        reason: "forbidden",
        message: "Can not approve your own pull request",
      });
      expect(await mergeSprintEpicWhenClean(ralphDeps(), lane.id)).toEqual({ status: "merged" });
      expect(await epicStates(id)).toEqual(["merged"]);
    });

    it("never merges an epic PR that targets the default branch", async () => {
      const a = epic("ENG-235");
      const { branch } = await started([a]);
      const { lane, number } = await openPullRequest(a, branch);
      scm.changeRequests.find((c) => c.number === number)!.targetBranch = "main";
      ciOf(number, "passed");
      expect(await mergeSprintEpicWhenClean(ralphDeps(), lane.id)).toEqual({ status: "skipped" });
      expect(scm.calls).not.toContain("mergePullRequest");
    });

    it("pauses the sprint with the host's reason when the merge is refused", async () => {
      const [a, b] = [epic("ENG-240"), epic("ENG-241")];
      const { id, branch } = await started([a, b]);
      const { lane, number } = await openPullRequest(a, branch);
      ciOf(number, "passed");
      scm.refusals.set("merge", {
        reason: "blocked",
        message: "At least 1 approving review is required by reviewers with write access.",
      });

      const result = await mergeSprintEpicWhenClean(ralphDeps(), lane.id);
      const reason = `The code host refused to merge ENG-240's PR into ${branch}: At least 1 approving review is required by reviewers with write access.`;
      expect(result).toEqual({ status: "paused", reason });
      const sprint = await stored(id);
      expect(sprint.status).toBe("paused");
      expect(sprint.pausedReason).toBe(reason);
      expect(sprint.epics.map((e) => e.state)).toEqual(["stalled", "queued"]);
      expect(delegated(b)).toBe(false);

      // A person approved it and resumed: the epic's open PR is adopted and merges now.
      scm.refusals.delete("merge");
      const resumed = await accepted("resume", id);
      expect(resumed.status).toBe("running");
      expect(await epicStates(id)).toEqual(["merged", "running"]);
      expect(delegated(b)).toBe(true);
    });

    it("pauses before the next epic when the sprint branch conflicts with the default branch", async () => {
      const [a, b] = [epic("ENG-250"), epic("ENG-251")];
      const { id, branch } = await started([a, b]);
      const { lane, number } = await openPullRequest(a, branch);
      ciOf(number, "passed");
      scm.branchMergeResult = { status: "conflicts", hostMessage: "Merge conflict" };

      expect(await mergeSprintEpicWhenClean(ralphDeps(), lane.id)).toEqual({ status: "merged" });
      const sprint = await stored(id);
      expect(sprint.status).toBe("paused");
      expect(sprint.pausedReason).toBe(
        `The sprint branch ${branch} conflicts with main, so Om didn't start the next epic. Merge main into ${branch} by hand, then resume. (Merge conflict)`,
      );
      // The epic that merged counts; the next waits, undelegated.
      expect(sprint.epics.map((e) => e.state)).toEqual(["merged", "queued"]);
      expect(delegated(b)).toBe(false);

      // Fixed by hand: resuming brings the branch up to date and starts it.
      scm.branchMergeResult = { status: "up_to_date" };
      await accepted("resume", id);
      expect(await epicStates(id)).toEqual(["merged", "running"]);
      expect(delegated(b)).toBe(true);
    });

    it("merges a clean epic PR from the sprint check when its events were missed", async () => {
      const [a, b] = [epic("ENG-260"), epic("ENG-261")];
      const { id, branch } = await started([a, b]);
      const { number } = await openPullRequest(a, branch);
      ciOf(number, "passed");
      const response = await sprintCheck(
        new Request("http://localhost/api/cron/sprint-check", {
          headers: { authorization: "Bearer cron-secret" },
        }),
      );
      expect(await response.json()).toMatchObject({ checked: 1, merged: 1 });
      expect(await epicStates(id)).toEqual(["merged", "running"]);
    });

    describe("the sprint PR", () => {
      /** Merges the epic's clean PR into the sprint branch, as Om does. */
      const land = async (issue: IssueSummary, branch: string) => {
        const { lane, number } = await openPullRequest(issue, branch);
        ciOf(number, "passed");
        expect(await mergeSprintEpicWhenClean(ralphDeps(), lane.id)).toEqual({ status: "merged" });
        return number;
      };
      const sprintPullRequests = (branch: string) =>
        scm.changeRequests.filter((c) => c.sourceBranch === branch);

      /** The code host's close (or merge) webhook of PR `number`. */
      const closedWebhook = async (number: number, merged: boolean) => {
        const response = await handleWebhook(
          "github",
          new Request("http://localhost/api/webhooks/github", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-github-event": "pull_request",
              "x-github-delivery": randomUUID(),
            },
            body: JSON.stringify({
              action: "closed",
              installation: { id: 1 },
              repository: { id: 1, full_name: "acme/api" },
              pull_request: { number, merged },
            }),
          }),
          {
            db,
            dispatcher: new PostgresDispatcher({ db }),
            adapterFor: () => scm.asAdapter(),
            tracker: async () => linear,
          },
        );
        return response.json();
      };

      /** A merge-together sprint of two epics whose PRs both merged; answers its sprint PR. */
      const landedSprint = async () => {
        const [a, b] = [
          epic(`ENG-${randomUUID().slice(0, 4)}`),
          epic(`ENG-${randomUUID().slice(0, 4)}`),
        ];
        const { id, branch } = await started([a, b]);
        const first = await land(a, branch);
        expect(sprintPullRequests(branch)).toEqual([]);
        const second = await land(b, branch);
        const [pr] = sprintPullRequests(branch);
        return { id, branch, a, b, first, second, pr: pr! };
      };

      it("opens one PR from the sprint branch to the default branch after the last epic merges", async () => {
        const { id, branch, a, b, first, second, pr } = await landedSprint();
        expect(sprintPullRequests(branch)).toHaveLength(1);
        expect(pr).toMatchObject({
          sourceBranch: branch,
          targetBranch: "main",
          title: "Q4",
          draft: false,
          state: "open",
        });
        const sprint = await stored(id);
        expect(sprint.status).toBe("running");
        expect(sprint.sprintPrNumber).toBe(pr.number);
        expect(sprint.sprintPrUrl).toBe(pr.url);
        // The sprint branch was brought up to date with the default branch before it opened.
        expect(scm.branchMerges.at(-1)).toMatchObject({ into: branch, from: "main" });

        // Its description lists each epic in order, with its work item and its PR.
        const lines = pr.body.split("\n");
        const listed = lines.filter((line) => /^\d+\. /.test(line));
        expect(listed).toEqual([
          `1. ${a.identifier} Epic ${a.identifier}: [#${first}](https://github.com/acme/api/pull/${first})`,
          `2. ${b.identifier} Epic ${b.identifier}: [#${second}](https://github.com/acme/api/pull/${second})`,
        ]);
        expect(pr.body).toContain(`every epic below merged into \`${branch}\``);

        // The sprint check finds it open: nothing new opens.
        const response = await sprintCheck(
          new Request("http://localhost/api/cron/sprint-check", {
            headers: { authorization: "Bearer cron-secret" },
          }),
        );
        expect(await response.json()).toMatchObject({ checked: 1, paused: 0 });
        expect(sprintPullRequests(branch)).toHaveLength(1);
        expect((await stored(id)).status).toBe("running");
      });

      it("links each epic's work item when its run knows the tracker URL", async () => {
        const a = epic("ENG-280");
        const { branch } = await started([a]);
        const { run, lane, number } = await openPullRequest(a, branch);
        await db
          .update(ralphRuns)
          .set({ trackerUrl: "https://linear.app/acme/issue/ENG-280" })
          .where(eq(ralphRuns.id, run.id));
        ciOf(number, "passed");
        await mergeSprintEpicWhenClean(ralphDeps(), lane.id);
        const [pr] = sprintPullRequests(branch);
        expect(pr!.body).toContain(
          `1. [ENG-280](https://linear.app/acme/issue/ENG-280) Epic ENG-280: [#${number}](https://github.com/acme/api/pull/${number})`,
        );
      });

      it("never approves or merges the sprint PR, even once it is clean", async () => {
        const { id, first, second, pr } = await landedSprint();
        // Green CI, a finished review with nothing open.
        ciOf(pr.number, "passed");
        await reviewWithFinding(pr.number, "resolved");
        // Every path that merges a clean epic PR runs.
        await sprintCheck(
          new Request("http://localhost/api/cron/sprint-check", {
            headers: { authorization: "Bearer cron-secret" },
          }),
        );
        await accepted("pause", id);
        await accepted("resume", id);

        expect(scm.approvals).toEqual([`acme/api#${first}@head-1`, `acme/api#${second}@head-1`]);
        expect(pr.state).toBe("open");
        expect((await stored(id)).status).toBe("running");
      });

      it("is done when the sprint PR merges", async () => {
        const { id, pr } = await landedSprint();
        pr.state = "merged";
        expect(await closedWebhook(pr.number, true)).toEqual({
          status: "accepted",
          event: "merged",
        });
        const sprint = await stored(id);
        expect(sprint.status).toBe("done");
        expect(sprint.pausedReason).toBeNull();
      });

      it("finishes from the sprint check when the merge webhook was missed", async () => {
        const { id, pr } = await landedSprint();
        pr.state = "merged";
        await sprintCheck(
          new Request("http://localhost/api/cron/sprint-check", {
            headers: { authorization: "Bearer cron-secret" },
          }),
        );
        expect((await stored(id)).status).toBe("done");
      });

      it("pauses when the sprint PR closes without merging, and resuming opens a new one", async () => {
        const { id, branch, pr } = await landedSprint();
        // A close event for a PR the code host still has open (reopened since) does nothing.
        await closedWebhook(pr.number, false);
        expect((await stored(id)).status).toBe("running");

        pr.state = "closed";
        expect(await closedWebhook(pr.number, false)).toEqual({
          status: "accepted",
          event: "closed",
        });
        const paused = await stored(id);
        expect(paused.status).toBe("paused");
        expect(paused.pausedReason).toBe(sprintPullRequestClosedReason("Q4"));
        expect(paused.epics.map((e) => e.state)).toEqual(["merged", "merged"]);

        await accepted("resume", id);
        const reopened = sprintPullRequests(branch).filter((c) => c.state === "open");
        expect(reopened).toHaveLength(1);
        expect(reopened[0]!.number).not.toBe(pr.number);
        const sprint = await stored(id);
        expect(sprint.status).toBe("running");
        expect(sprint.sprintPrNumber).toBe(reopened[0]!.number);
      });

      it("pauses with the reason when the code host refuses to open it", async () => {
        const a = epic("ENG-290");
        const { id, branch } = await started([a]);
        scm.failures.set("createChangeRequest", "Validation Failed");
        await land(a, branch);
        const sprint = await stored(id);
        expect(sprint.status).toBe("paused");
        expect(sprint.pausedReason).toBe(
          "Om couldn't open the sprint PR (Validation Failed). Resume the sprint to try again.",
        );

        scm.failures.delete("createChangeRequest");
        await accepted("resume", id);
        expect(sprintPullRequests(branch)).toHaveLength(1);
        expect((await stored(id)).status).toBe("running");
      });
    });
  });
});
