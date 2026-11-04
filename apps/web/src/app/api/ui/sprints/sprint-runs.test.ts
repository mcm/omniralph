import { randomBytes, randomUUID } from "node:crypto";
import {
  closeDb,
  connectRepository,
  createDb,
  createOrganization,
  createRun,
  createSprint,
  ensureLane,
  getMainLane,
  getSprint,
  ralphRuns,
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
        externalId: "installation-acme",
        credentials: {},
      },
      randomBytes(32),
    ))!;
    repoId = (
      await connectRepository(db, {
        connectionId: connection.id,
        provider: "github",
        externalId: "acme/api",
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
});
