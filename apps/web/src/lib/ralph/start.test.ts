import { randomBytes, randomUUID } from "node:crypto";
import {
  connectRepository,
  closeDb,
  createDb,
  getMainLane,
  getRun,
  getRunBySession,
  insertJob,
  jobs,
  listStories,
  lockRun,
  ralphRuns,
  updateLane,
  updateRepositoryCoding,
  setTrackerLabels,
  updateRun,
  updateStory,
  upsertScmConnection,
  type Database,
  type RalphLaneUpdate,
  type RalphRun,
  organizations,
  replaceRoutingRules,
} from "@omniralph/db";
import type { ScmAdapter } from "@omniralph/scm";
import type { RoutingQuery } from "@omniralph/shared";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
  setCodingEnabled,
} from "@omniralph/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureChanges } from "@omniralph/db/changes";
import { PostgresDispatcher } from "@/lib/dispatch/dispatcher";
import { FakeLinearGateway } from "@omniralph/tracker/linear/testing";
import { AGENT_SESSION_MARKER } from "@omniralph/tracker/linear";
import { cachedBacklog, hasCachedBacklog } from "@/lib/work-items/backlog-cache";
import { handleReply } from "./reply";
import { advanceRun, updateStoryAndPlan } from "./run";
import { startRun, type SessionCreatedEvent, type StartRunDeps } from "./start";

vi.mock("server-only", () => ({}));
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const databaseAvailable = testDatabaseAvailable();

const labels = (...values: string[]): RoutingQuery => ({
  combinator: "and",
  rules: [{ field: "labels", operator: "containsAny", value: values }],
});
const team = (key: string): RoutingQuery => ({
  combinator: "and",
  rules: [{ field: "team", operator: "=", value: key }],
});
const BY_FRONTEND = "rule 1 (Labels contains any of frontend)";
const BY_ENG = "rule 2 (Team is ENG)";

const DELEGATION = `${AGENT_SESSION_MARKER}. Delegated by Steve.`;

const PRD = `# PRD: Priorities

> Branch: feat/priorities

## Quality Gates
- \`pnpm test\`

## User Stories

### US-001: Store priority
**Description:** Add a column.
**Acceptance Criteria:**
- [ ] column exists

### US-002: Grant database access
**Labels:** manual

### US-003: Show priority
**Priority:** 1
**Depends on:** US-001
**Acceptance Criteria:**
- [ ] badge shows
`;

describe.skipIf(!databaseAvailable)("starting ralph runs from Linear delegations", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let repoId: string;
  let otherRepoId: string;
  let tracker: FakeLinearGateway;
  let defaultBranchCalls: string[];
  let sessionSeq = 0;

  const fakeAdapter = {
    getDefaultBranch: async (repo: { fullPath: string }) => {
      defaultBranchCalls.push(repo.fullPath);
      return "develop";
    },
  } as unknown as ScmAdapter;

  const deps = (): StartRunDeps => ({
    db,
    organizationId: orgId,
    tracker,
    dispatcher: new PostgresDispatcher({ db }),
    adapterFor: () => fakeAdapter,
  });

  /** Replaces the organization's routing rules. */
  const setRules = async (...list: Array<[string, RoutingQuery]>) => {
    const saved = await replaceRoutingRules(
      db,
      orgId,
      list.map(([repositoryId, query]) => ({ repositoryId, query })),
    );
    expect(saved.ok).toBe(true);
  };

  /** A run with its main lane's branches and PR/MR (where v2a kept them on the run). */
  const withLane = async (run: RalphRun | null) => {
    const lane = run && (await getMainLane(db, run));
    return (
      run && {
        ...run,
        branch: lane?.branch ?? null,
        baseBranch: lane?.baseBranch ?? null,
        prNumber: lane?.prNumber ?? null,
        prUrl: lane?.prUrl ?? null,
      }
    );
  };
  const updateMainLane = async (run: RalphRun, update: RalphLaneUpdate) =>
    updateLane(db, (await getMainLane(db, run))!.id, update);

  /** A new session: a mention when `commentBody` is a comment, else a delegation (as Linear's are). */
  const created = (
    issueId: string,
    overrides: Partial<Omit<SessionCreatedEvent, "kind">> = {},
  ): SessionCreatedEvent => {
    sessionSeq += 1;
    const { commentBody = DELEGATION, ...rest } = overrides;
    const fields = { sessionId: `session-${sessionSeq}`, issueId, ...rest };
    return commentBody.trim() && !commentBody.includes(AGENT_SESSION_MARKER)
      ? { kind: "issue_mentioned", ...fields, commentBody }
      : { kind: "issue_delegated", ...fields, commentBody };
  };

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
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
        fullPath: "acme/api",
      })
    ).id;
    otherRepoId = (
      await connectRepository(db, {
        connectionId: connection.id,
        provider: "github",
        externalId: "2",
        fullPath: "acme/web",
      })
    ).id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    await db.delete(jobs);
    await db.delete(ralphRuns);
    await setCodingEnabled(db, repoId);
    await setCodingEnabled(db, otherRepoId);
    await setTrackerLabels(db, orgId, null, null);
    await setRules([otherRepoId, labels("frontend")], [repoId, team("ENG")]);
    tracker = new FakeLinearGateway();
    defaultBranchCalls = [];
  });

  it("records a work_item change and drops the Backlog cache when it creates a run", async () => {
    const issue = tracker.add({ identifier: "ENG-1", title: "Single", stateType: "unstarted" });
    await cachedBacklog(orgId, async () => ({ entries: [], truncated: false }));
    expect(hasCachedBacklog(orgId)).toBe(true);
    const { result, changes } = await captureChanges(() => startRun(created(issue.id), deps()));
    expect(result).toMatchObject({ status: "started", created: true });
    expect(changes).toContainEqual(
      expect.objectContaining({
        resource: "work_item",
        organizationId: orgId,
        ids: [`linear-${issue.id}`],
      }),
    );
    expect(hasCachedBacklog(orgId)).toBe(false);
  });

  it("starts a children epic: run, stories, started state, description and plan", async () => {
    const epic = tracker.add({
      identifier: "ENG-1",
      title: "Priorities",
      description: "Epic.\n\n> Branch: feat/prio",
      stateType: "backlog",
    });
    const a = tracker.add({ identifier: "ENG-2", title: "Store", parentId: epic.id });
    const b = tracker.add({
      identifier: "ENG-3",
      title: "Access",
      parentId: epic.id,
      labels: ["Manual"],
    });
    tracker.add({ identifier: "ENG-4", title: "Show", parentId: epic.id, stateType: "completed" });
    await tracker.createBlocksRelation(a.id, b.id);

    const event = created(epic.id);
    const outcome = await startRun(event, deps());
    expect(outcome).toMatchObject({ status: "started", created: true });

    const run = await withLane(await getRunBySession(db, event.sessionId));
    expect(run).toMatchObject({
      trackerIssueId: epic.id,
      trackerIdentifier: "ENG-1",
      kind: "children",
      focusStoryId: null,
      repositoryId: repoId,
      branch: "feat/prio",
      baseBranch: "develop",
      // The first story was enqueued right away.
      status: "running",
    });
    expect(defaultBranchCalls).toEqual(["acme/api"]);
    expect(
      (await listStories(db, run!.id)).map((s) => [s.identifier, s.title, s.status, s.position]),
    ).toEqual([
      ["ENG-2", "Store", "running", 0],
      ["ENG-3", "Access", "manual", 1],
      ["ENG-4", "Show", "completed", 2],
    ]);
    expect(tracker.issues.get(epic.id)?.stateType).toBe("started");
    const [thought] = tracker.bodies(event.sessionId, "thought");
    expect(thought).toContain("**ENG-1** is an epic with 3 stories (1 already done)");
    expect(thought).toContain(`\`acme/api\` (routed by ${BY_ENG}) on branch \`feat/prio\``);
    expect(thought).toContain("Manual steps for a person: **ENG-3**");
    expect(tracker.plan(event.sessionId)).toEqual([
      { content: "ENG-2: Store", status: "inProgress" },
      { content: "ENG-3: Access (manual)", status: "pending" },
      { content: "ENG-4: Show", status: "completed" },
    ]);
    expect(tracker.bodies(event.sessionId, "error")).toEqual([]);
  });

  it("materializes a PRD's stories as sub-issues and loads it as an epic", async () => {
    const epic = tracker.add({ identifier: "ENG-10", title: "PRD", description: PRD });
    const event = created(epic.id);
    await startRun(event, deps());

    const children = await tracker.getChildren(epic.id);
    expect(
      children.map((c) => [c.title, c.priority, c.subIssueSortOrder, c.labels, c.description]),
    ).toEqual([
      ["Store priority", 3, 0, [], "Add a column.\n\n## Acceptance Criteria\n- [ ] column exists"],
      [
        "Grant database access",
        3,
        1,
        ["manual"],
        "## Acceptance Criteria\n*No acceptance criteria defined.*",
      ],
      ["Show priority", 1, 2, [], "## Acceptance Criteria\n- [ ] badge shows"],
    ]);
    const [store, , show] = children;
    expect(tracker.blocks.get(show!.id)).toEqual([store!.id]);

    const run = await withLane(await getRunBySession(db, event.sessionId));
    expect(run).toMatchObject({ kind: "prd", branch: "feat/priorities", baseBranch: "develop" });
    expect((await listStories(db, run!.id)).map((s) => [s.title, s.status])).toEqual([
      ["Store priority", "running"],
      ["Grant database access", "manual"],
      ["Show priority", "pending"],
    ]);
    expect(tracker.bodies(event.sessionId, "thought")[0]).toContain(
      "Created 3 story sub-issues from the PRD",
    );
    expect(tracker.plan(event.sessionId)?.map((step) => step.status)).toEqual([
      "inProgress",
      "pending",
      "pending",
    ]);
  });

  it("marks and materializes manual stories with the organization's manual labels", async () => {
    await setTrackerLabels(
      db,
      orgId,
      { manualLabels: ["by hand", "ops"], blockedLabels: [] },
      null,
    );
    // A children epic: the custom labels (any case) mark manual stories, `manual` no longer does.
    const epic = tracker.add({ identifier: "ENG-20", title: "Epic" });
    tracker.add({ identifier: "ENG-21", title: "Code", parentId: epic.id, labels: ["manual"] });
    tracker.add({ identifier: "ENG-22", title: "DNS", parentId: epic.id, labels: ["By Hand"] });
    tracker.add({ identifier: "ENG-23", title: "Keys", parentId: epic.id, labels: ["OPS"] });
    const event = created(epic.id);
    await startRun(event, deps());
    const run = await getRunBySession(db, event.sessionId);
    expect((await listStories(db, run!.id)).map((s) => [s.identifier, s.status])).toEqual([
      ["ENG-21", "running"],
      ["ENG-22", "manual"],
      ["ENG-23", "manual"],
    ]);

    // A delegated sub-issue loads its parent's epic with the same labels.
    const parent = tracker.add({ identifier: "ENG-30", title: "Epic" });
    const story = tracker.add({ identifier: "ENG-31", title: "Code", parentId: parent.id });
    tracker.add({ identifier: "ENG-32", title: "DNS", parentId: parent.id, labels: ["by hand"] });
    const focused = created(story.id);
    await startRun(focused, deps());
    const focusedRun = await getRunBySession(db, focused.sessionId);
    expect((await listStories(db, focusedRun!.id)).map((s) => [s.identifier, s.status])).toEqual([
      ["ENG-31", "running"],
      ["ENG-32", "manual"],
    ]);

    // A PRD's manual story is created with the first label.
    const prd = tracker.add({ identifier: "ENG-40", title: "PRD", description: PRD });
    const prdEvent = created(prd.id);
    await startRun(prdEvent, deps());
    expect((await tracker.getChildren(prd.id)).map((c) => [c.title, c.labels])).toEqual([
      ["Store priority", []],
      ["Grant database access", ["by hand"]],
      ["Show priority", []],
    ]);
    const prdRun = await getRunBySession(db, prdEvent.sessionId);
    expect((await listStories(db, prdRun!.id)).map((s) => [s.title, s.status])).toEqual([
      ["Store priority", "running"],
      ["Grant database access", "manual"],
      ["Show priority", "pending"],
    ]);
  });

  it("creates the PRD stories an interrupted materialization left out, once", async () => {
    const epic = tracker.add({ identifier: "ENG-15", title: "PRD", description: PRD });
    // The first try created one sub-issue, then failed.
    const store = tracker.add({ identifier: "ENG-16", title: "Store priority", parentId: epic.id });
    const event = created(epic.id);
    await startRun(event, deps());

    const children = await tracker.getChildren(epic.id);
    expect(children.map((c) => c.title)).toEqual([
      "Store priority",
      "Grant database access",
      "Show priority",
    ]);
    expect(tracker.blocks.get(children[2]!.id)).toEqual([store.id]);
    const run = await getRunBySession(db, event.sessionId);
    expect(run).toMatchObject({ kind: "prd" });
    expect((await listStories(db, run!.id)).map((s) => s.title)).toEqual([
      "Store priority",
      "Grant database access",
      "Show priority",
    ]);
    expect(tracker.bodies(event.sessionId, "thought")[0]).toContain(
      "Created 2 story sub-issues from the PRD",
    );
  });

  it("treats a plain issue as a single story", async () => {
    const issue = tracker.add({ identifier: "ENG-20", title: "Fix the login bug" });
    const event = created(issue.id);
    await startRun(event, deps());
    const run = await withLane(await getRunBySession(db, event.sessionId));
    expect(run).toMatchObject({
      kind: "single",
      trackerIssueId: issue.id,
      branch: issue.branchName,
    });
    expect(
      (await listStories(db, run!.id)).map((s) => [s.trackerIssueId, s.identifier, s.status]),
    ).toEqual([[issue.id, "ENG-20", "running"]]);
    expect(tracker.issues.get(issue.id)?.stateType).toBe("started");
    expect(tracker.plan(event.sessionId)).toEqual([
      { content: "ENG-20: Fix the login bug", status: "inProgress" },
    ]);
  });

  it("treats an issue whose sub-issues are all canceled as a single story", async () => {
    const issue = tracker.add({ identifier: "ENG-25", title: "Former epic" });
    tracker.add({
      identifier: "ENG-26",
      title: "Dropped",
      parentId: issue.id,
      stateType: "canceled",
    });
    tracker.add({ identifier: "ENG-27", title: "Also", parentId: issue.id, stateType: "canceled" });
    const event = created(issue.id);
    await startRun(event, deps());
    const run = await withLane(await getRunBySession(db, event.sessionId));
    expect(run).toMatchObject({ kind: "single", trackerIssueId: issue.id });
    expect(
      (await listStories(db, run!.id)).map((s) => [s.trackerIssueId, s.identifier, s.status]),
    ).toEqual([[issue.id, "ENG-25", "running"]]);
    expect(tracker.issues.get(issue.id)?.stateType).toBe("started");
  });

  it("keeps an issue with canceled and open sub-issues a children epic", async () => {
    const epic = tracker.add({ identifier: "ENG-35", title: "Epic" });
    tracker.add({
      identifier: "ENG-36",
      title: "Dropped",
      parentId: epic.id,
      stateType: "canceled",
    });
    tracker.add({ identifier: "ENG-37", title: "Kept", parentId: epic.id });
    const event = created(epic.id);
    await startRun(event, deps());
    const run = await getRunBySession(db, event.sessionId);
    expect(run).toMatchObject({ kind: "children", trackerIssueId: epic.id });
    expect((await listStories(db, run!.id)).map((s) => s.identifier)).toEqual(["ENG-36", "ENG-37"]);
  });

  it("loads a delegated sub-issue's epic, focused on that story", async () => {
    const epic = tracker.add({ identifier: "ENG-30", title: "Epic", stateType: "started" });
    tracker.add({ identifier: "ENG-31", title: "One", parentId: epic.id });
    const two = tracker.add({ identifier: "ENG-32", title: "Two", parentId: epic.id });
    const event = created(two.id);
    await startRun(event, deps());
    const run = await getRunBySession(db, event.sessionId);
    expect(run).toMatchObject({
      trackerIssueId: epic.id,
      trackerIdentifier: "ENG-30",
      kind: "children",
      focusStoryId: two.id,
    });
    expect((await listStories(db, run!.id)).map((s) => s.identifier)).toEqual(["ENG-31", "ENG-32"]);
    expect(tracker.bodies(event.sessionId, "thought")[0]).toContain("I'll start with ENG-32");
  });

  it("routes by the first rule that matches; without any ralph-enabled repository explains how to enable one", async () => {
    const labelled = tracker.add({ identifier: "ENG-40", title: "UI", labels: ["Frontend"] });
    const event = created(labelled.id);
    await startRun(event, deps());
    expect(await getRunBySession(db, event.sessionId)).toMatchObject({
      repositoryId: otherRepoId,
      routedBy: BY_FRONTEND,
    });

    await setRules();
    await updateRepositoryCoding(db, repoId, { codingEnabled: false });
    await updateRepositoryCoding(db, otherRepoId, { codingEnabled: false });
    const elsewhere = tracker.add({ identifier: "OPS-1", title: "Infra", teamKey: "OPS" });
    const unroutable = created(elsewhere.id);
    expect(await startRun(unroutable, deps())).toEqual({ status: "unroutable" });
    const [error] = tracker.bodies(unroutable.sessionId, "error");
    expect(error).toContain("no repo has Coding on");
    expect(error).toContain("work item match");
    expect(error).toContain("**Coding** switch under **Repos**");
    expect(error).not.toContain("Task types");
    expect(error).not.toContain("[repo=");

    expect(await db.select().from(ralphRuns)).toHaveLength(1);
    expect(tracker.issues.get(elsewhere.id)?.stateType).toBe("unstarted");
  });

  it("doesn't build an issue whose rule routes to a repository with coding off", async () => {
    await updateRepositoryCoding(db, otherRepoId, { codingEnabled: false });
    const issue = tracker.add({
      identifier: "ENG-55",
      title: "Docs",
      labels: ["frontend"],
      stateType: "backlog",
      description: PRD,
    });
    const event = created(issue.id);
    expect(await startRun(event, deps())).toEqual({ status: "manual", repository: "acme/web" });
    expect(tracker.bodies(event.sessionId, "response")).toEqual([
      "This routes to `acme/web` (rule 1), which has coding off, so it's for a person.",
    ]);
    // No run, no stories materialized from its PRD, and its state is left alone.
    expect(await db.select().from(ralphRuns)).toEqual([]);
    expect(await tracker.getChildren(issue.id)).toEqual([]);
    expect(tracker.stateChanges).toEqual([]);
    expect(tracker.issues.get(issue.id)?.stateType).toBe("backlog");

    // A mention asking for work is refused the same way.
    const mention = created(issue.id, { commentBody: "@omniralph fix the typo" });
    expect(await startRun(mention, deps())).toEqual({ status: "manual", repository: "acme/web" });
    expect(await db.select().from(ralphRuns)).toEqual([]);
  });

  it("routes by the repository's own Coding switch, whatever the organization's task types", async () => {
    // Coding off blocks it: its rule makes the issue manual.
    await updateRepositoryCoding(db, otherRepoId, { codingEnabled: false });
    await updateRepositoryCoding(db, repoId, { codingEnabled: false });
    const blocked = created(tracker.add({ identifier: "ENG-51", title: "Blocked" }).id);
    expect(await startRun(blocked, deps())).toEqual({ status: "manual", repository: "acme/api" });

    // Coding on builds it.
    await setCodingEnabled(db, repoId);
    const on = created(tracker.add({ identifier: "ENG-53", title: "On" }).id);
    expect(await startRun(on, deps())).toMatchObject({ status: "started" });
    expect(await getRunBySession(db, on.sessionId)).toMatchObject({ repositoryId: repoId });
  });

  describe("the repository question", () => {
    const reply = (sessionId: string, body: string) =>
      handleReply({ kind: "session_prompted", sessionId, body }, deps());
    const selects = () => tracker.activities.filter((a) => a.options?.signal === "select");

    it("asks which repository when nothing matches, then continues with the reply", async () => {
      const epic = tracker.add({ identifier: "OPS-10", title: "Infra", teamKey: "OPS" });
      tracker.add({ identifier: "OPS-11", title: "One", teamKey: "OPS", parentId: epic.id });
      const event = created(epic.id);
      const outcome = await startRun(event, deps());
      expect(outcome).toMatchObject({ status: "selecting" });

      const run = (await getRunBySession(db, event.sessionId))!;
      expect(run).toMatchObject({
        status: "waiting",
        repositoryId: null,
        routedBy: null,
        pendingElicitation: { kind: "repository", repositoryIds: [repoId, otherRepoId] },
      });
      expect(await db.select().from(jobs)).toEqual([]);
      expect(tracker.issues.get(epic.id)?.stateType).toBe("unstarted");
      const [ask] = selects();
      expect(ask?.content).toMatchObject({ type: "elicitation" });
      expect(ask?.options?.signalMetadata).toEqual({
        options: [{ value: "acme/api" }, { value: "acme/web" }],
      });
      expect(tracker.bodies(event.sessionId, "elicitation")[0]).toContain(
        "Which repository should I work in for this issue?",
      );
      expect(tracker.bodies(event.sessionId, "elicitation")[0]).not.toContain("[repo=");
      expect(tracker.bodies(event.sessionId, "elicitation")[0]).toContain(
        "Settings › Advanced › Routing rules",
      );

      // Advancing again (e.g. the reconcile cron) waits without asking twice.
      expect(await advanceRun(run.id, deps())).toMatchObject({ action: "waiting" });
      expect(selects()).toHaveLength(1);

      // An unmatched reply re-asks; a matching one picks the repository and starts.
      expect(await reply(event.sessionId, "mobile")).toEqual({ kind: "repository_selection" });
      expect(selects()).toHaveLength(2);
      expect(tracker.bodies(event.sessionId, "elicitation")[1]).toContain(
        `I couldn't match "mobile" to a repository. Which one should I use?`,
      );
      expect((await getRun(db, run.id))?.repositoryId).toBeNull();

      const picked = await reply(event.sessionId, "acme/web");
      expect(picked).toMatchObject({
        kind: "repository_selection",
        advanced: { action: "enqueued" },
      });
      expect(await withLane(await getRun(db, run.id))).toMatchObject({
        repositoryId: otherRepoId,
        routedBy: "your selection",
        branch: epic.branchName,
        baseBranch: "develop",
        pendingElicitation: null,
        status: "running",
        // The selection isn't story guidance.
        guidance: [],
      });
      expect(defaultBranchCalls).toEqual(["acme/web"]);
      expect(tracker.bodies(event.sessionId, "thought")).toContainEqual(
        expect.stringContaining("Using `acme/web`."),
      );
      expect(tracker.issues.get(epic.id)?.stateType).toBe("started");
      const [job] = await db.select().from(jobs);
      expect(job).toMatchObject({ type: "ralph.story", repositoryId: otherRepoId });

      // Re-delegating the same issue keeps the chosen repository without asking again.
      await updateRun(db, run.id, { status: "failed" });
      await db.delete(jobs);
      const again = created(epic.id);
      expect(await startRun(again, deps())).toMatchObject({ status: "started", created: true });
      expect(await getRunBySession(db, again.sessionId)).toMatchObject({
        repositoryId: otherRepoId,
        routedBy: "your selection",
      });
      expect(tracker.bodies(again.sessionId, "thought")[0]).toContain(
        "Building it in `acme/web` (routed by your selection)",
      );
      expect(selects()).toHaveLength(2);
    });

    it("matches a reply by number, and asks again when a stopped run resumes", async () => {
      const issue = tracker.add({ identifier: "OPS-15", title: "Infra", teamKey: "OPS" });
      const event = created(issue.id);
      await startRun(event, deps());
      const run = (await getRunBySession(db, event.sessionId))!;

      // Stopped while asking: a later reply resumes it and the question comes back.
      await reply(event.sessionId, "stop");
      expect(await getRun(db, run.id)).toMatchObject({
        status: "stopped",
        pendingElicitation: null,
      });
      await reply(event.sessionId, "go on");
      expect(await getRun(db, run.id)).toMatchObject({
        status: "waiting",
        repositoryId: null,
        pendingElicitation: { kind: "repository" },
      });
      expect(selects()).toHaveLength(2);

      await reply(event.sessionId, "1");
      expect(await getRun(db, run.id)).toMatchObject({
        repositoryId: repoId,
        routedBy: "your selection",
        status: "running",
      });
    });

    it("keeps a repository a human picked, and the current one when routing would have to ask", async () => {
      const epic = tracker.add({ identifier: "OPS-20", title: "Infra", teamKey: "OPS" });
      const first = created(epic.id);
      await startRun(first, deps());
      await reply(first.sessionId, "web");
      const picked = (await getRunBySession(db, first.sessionId))!;
      expect(picked).toMatchObject({ repositoryId: otherRepoId, status: "running" });

      // Team routing to api now matches, but the human's pick wins.
      await updateRun(db, picked.id, { status: "failed" });
      await db.delete(jobs);
      tracker.issues.get(epic.id)!.teamKey = "ENG";
      const second = created(epic.id);
      await startRun(second, deps());
      expect(await getRunBySession(db, second.sessionId)).toMatchObject({
        repositoryId: otherRepoId,
        routedBy: "your selection",
      });

      // Routed by label to web; once the label is gone routing can't decide, so it stays in web.
      const other = tracker.add({
        identifier: "OPS-21",
        title: "Other",
        teamKey: "OPS",
        labels: ["frontend"],
      });
      const third = created(other.id);
      await startRun(third, deps());
      const routed = (await getRunBySession(db, third.sessionId))!;
      expect(routed).toMatchObject({ repositoryId: otherRepoId, routedBy: BY_FRONTEND });
      await updateRun(db, routed.id, { status: "failed" });
      await db.delete(jobs);
      tracker.issues.get(other.id)!.labels = [];
      const fourth = created(other.id);
      expect(await startRun(fourth, deps())).toMatchObject({ status: "started", created: true });
      expect(await getRunBySession(db, fourth.sessionId)).toMatchObject({
        repositoryId: otherRepoId,
        routedBy: BY_FRONTEND,
      });
      expect(selects()).toHaveLength(1);
    });

    it("ignores a `[repo=…]` tag in the description", async () => {
      const tagged = tracker.add({
        identifier: "OPS-41",
        title: "Tagged",
        teamKey: "OPS",
        description: "[repo=acme/api]",
      });
      const event = created(tagged.id);
      expect(await startRun(event, deps())).toMatchObject({ status: "selecting" });
      const [question] = tracker.bodies(event.sessionId, "elicitation");
      expect(question).not.toContain("[repo=");
      expect(question).toContain("Which repository should I work in for this issue?");
    });
  });

  it("re-routing to another repository moves the run there and leaves the earlier work alone", async () => {
    const epic = tracker.add({ identifier: "ENG-45", title: "UI", labels: ["Frontend"] });
    const first = created(epic.id);
    await startRun(first, deps());
    const previous = (await getRunBySession(db, first.sessionId))!;
    expect(previous.repositoryId).toBe(otherRepoId);
    await updateRun(db, previous.id, { status: "failed" });
    await updateMainLane(previous, {
      branch: "custom/branch",
      prNumber: 9,
      prUrl: "https://github.com/acme/web/pull/9",
    });
    await db.delete(jobs);

    // Without its label, its team sends it to api.
    tracker.issues.get(epic.id)!.labels = [];
    const second = created(epic.id);
    await startRun(second, deps());
    const moved = await withLane(await getRunBySession(db, second.sessionId));
    expect(moved).toMatchObject({
      repositoryId: repoId,
      routedBy: BY_ENG,
      prNumber: null,
      prUrl: null,
    });
    expect(moved?.branch).not.toBe("custom/branch");
    const [note] = tracker.bodies(second.sessionId, "thought");
    expect(note).toBe(
      "Routing now sends this to `acme/api` instead of `acme/web`, so I'm working there. " +
        "The earlier work in `acme/web` stays as it is (branch `custom/branch`, " +
        "Pull request https://github.com/acme/web/pull/9); I won't touch it again.",
    );
    // The previous run is left alone.
    expect(await withLane(await getRun(db, previous.id))).toMatchObject({
      repositoryId: otherRepoId,
      branch: "custom/branch",
      prNumber: 9,
    });
  });

  it("a bare mention with no instruction does nothing", async () => {
    const issue = tracker.add({ identifier: "ENG-50", title: "Question" });
    const event = created(issue.id, { commentBody: "@omniralph" });
    expect(await startRun(event, deps())).toEqual({ status: "nothing" });
    expect(tracker.bodies(event.sessionId, "response")).toEqual([
      "Nothing to do: the mention didn't include a request. Delegate the issue to me to work the epic.",
    ]);
    expect(await db.select().from(ralphRuns)).toEqual([]);
    expect(tracker.issues.get(issue.id)?.stateType).toBe("unstarted");
  });

  describe("open questions", () => {
    const QUESTIONS = `${PRD}\n## Open Questions\n\n1. Which column type?\n`;

    it("refuses a delegation while the PRD has open questions", async () => {
      const issue = tracker.add({ identifier: "ENG-60", title: "PRD", description: QUESTIONS });
      const event = created(issue.id);
      expect(await startRun(event, deps())).toEqual({
        status: "open_questions",
        identifier: "ENG-60",
      });
      const [response] = tracker.bodies(event.sessionId, "response");
      expect(response).toContain("**ENG-60** still has open questions");
      expect(response).toContain("reply in the triage session");
      expect(await db.select().from(ralphRuns)).toEqual([]);
      // Nothing materialized, no state change.
      expect(await tracker.getChildren(issue.id)).toEqual([]);
      expect(tracker.issues.get(issue.id)?.stateType).toBe("unstarted");
    });

    it("refuses a delegated sub-issue of an epic with open questions, and `/ralph` mentions", async () => {
      const epic = tracker.add({
        identifier: "ENG-61",
        title: "Epic",
        description: "Epic.\n\n## Open Questions\n\n1. Which team?",
      });
      const story = tracker.add({ identifier: "ENG-62", title: "Store", parentId: epic.id });
      const event = created(story.id);
      expect(await startRun(event, deps())).toEqual({
        status: "open_questions",
        identifier: "ENG-61",
      });
      expect(tracker.bodies(event.sessionId, "response")[0]).toContain(
        "the epic **ENG-61** still has open questions",
      );

      const mention = created(epic.id, { commentBody: "@omniralph /ralph go" });
      expect(await startRun(mention, deps())).toMatchObject({ status: "open_questions" });
      expect(await db.select().from(ralphRuns)).toEqual([]);
    });

    it("starts issues without open questions, and request-mode mentions regardless", async () => {
      const issue = tracker.add({
        identifier: "ENG-63",
        title: "Plain",
        description: "Do it.\n\n## Open Questions\n\n",
      });
      expect(await startRun(created(issue.id), deps())).toMatchObject({
        status: "started",
        created: true,
      });

      const asked = tracker.add({ identifier: "ENG-64", title: "PRD", description: QUESTIONS });
      expect(
        await startRun(
          created(asked.id, { commentBody: "@omniralph what does this need?" }),
          deps(),
        ),
      ).toMatchObject({ status: "started", created: true });
    });

    it("refuses a delegation when Linear can't be read for the check", async () => {
      const issue = tracker.add({ identifier: "ENG-65", title: "PRD", description: PRD });
      tracker.failures.set("getIssue", new Error("rate limited"));
      const event = created(issue.id);
      expect(await startRun(event, deps())).toEqual({
        status: "load_failed",
        error: "rate limited",
      });
      expect(tracker.bodies(event.sessionId, "error")[0]).toContain(
        "I couldn't load the issue from Linear, so I didn't start: rate limited.",
      );
      expect(await db.select().from(ralphRuns)).toEqual([]);
      expect(tracker.issues.get(issue.id)?.stateType).toBe("unstarted");
    });
  });

  describe("features", () => {
    /** ENG-70, a feature: the epic ENG-71 (with the task ENG-72) and the task ENG-73. */
    const addFeature = () => {
      const feature = tracker.add({ identifier: "ENG-70", title: "Feature", description: PRD });
      const epic = tracker.add({ identifier: "ENG-71", title: "Epic", parentId: feature.id });
      const story = tracker.add({ identifier: "ENG-72", title: "Story", parentId: epic.id });
      const task = tracker.add({ identifier: "ENG-73", title: "Loose", parentId: feature.id });
      return { feature, epic, story, task };
    };
    const issueCount = () => tracker.issues.size;

    it("refuses a delegated feature, creating nothing", async () => {
      const { feature } = addFeature();
      const before = issueCount();
      const event = created(feature.id);
      expect(await startRun(event, deps())).toEqual({ status: "feature", identifier: "ENG-70" });
      expect(tracker.bodies(event.sessionId, "response")).toEqual([
        "I won't build this. **ENG-70** is a feature: it holds epics (**ENG-71**). " +
          "Each epic is started on its own: delegate each epic to me instead.",
      ]);
      expect(await db.select().from(ralphRuns)).toEqual([]);
      expect(await db.select().from(jobs)).toEqual([]);
      expect(defaultBranchCalls).toEqual([]);
      // Its PRD wasn't materialized, and nothing moved.
      expect(issueCount()).toBe(before);
      expect(tracker.issues.get(feature.id)?.stateType).toBe("unstarted");
    });

    it("refuses a task directly under a feature, and a `/coding` mention of the feature", async () => {
      const { feature, task } = addFeature();
      const event = created(task.id);
      expect(await startRun(event, deps())).toEqual({ status: "feature", identifier: "ENG-70" });
      expect(tracker.bodies(event.sessionId, "response")[0]).toContain(
        "**ENG-73** is a task directly under **ENG-70**, which is a feature: it holds epics " +
          "(**ENG-71**). Each epic is started on its own: move **ENG-73** into one of them",
      );
      const mention = created(feature.id, { commentBody: "@omniralph /coding go" });
      expect(await startRun(mention, deps())).toEqual({ status: "feature", identifier: "ENG-70" });
      expect(await db.select().from(ralphRuns)).toEqual([]);
      expect(await db.select().from(jobs)).toEqual([]);
    });

    it("refuses switching a mention's run of a feature to coding", async () => {
      const { feature } = addFeature();
      const event = created(feature.id, { commentBody: "@omniralph what is left here?" });
      expect(await startRun(event, deps())).toMatchObject({ status: "started" });
      const reply = await handleReply(
        { kind: "session_prompted", sessionId: event.sessionId, body: "/coding" },
        deps(),
      );
      expect(reply).toEqual({ kind: "feature" });
      expect(tracker.bodies(event.sessionId, "response").at(-1)).toContain(
        "**ENG-70** is a feature: it holds epics (**ENG-71**).",
      );
      expect((await getRunBySession(db, event.sessionId))?.mode).toBe("request");
    });

    it("starts an epic of a feature, one of its tasks, and a standalone task", async () => {
      const { epic, story } = addFeature();
      expect(await startRun(created(epic.id), deps())).toMatchObject({
        status: "started",
        created: true,
        run: { trackerIdentifier: "ENG-71" },
      });
      await db.delete(jobs);
      await db.delete(ralphRuns);
      expect(await startRun(created(story.id), deps())).toMatchObject({
        status: "started",
        run: { trackerIdentifier: "ENG-71" },
      });
      const standalone = tracker.add({ identifier: "ENG-74", title: "Standalone" });
      expect(await startRun(created(standalone.id), deps())).toMatchObject({
        status: "started",
        run: { trackerIdentifier: "ENG-74" },
      });
    });

    it("counts only open sub-issues: an epic whose story's sub-issues are canceled starts", async () => {
      const epic = tracker.add({ identifier: "ENG-75", title: "Epic" });
      const story = tracker.add({ identifier: "ENG-76", title: "Story", parentId: epic.id });
      tracker.add({
        identifier: "ENG-77",
        title: "Dropped",
        parentId: story.id,
        stateType: "canceled",
        stateName: "Canceled",
      });
      expect(await startRun(created(epic.id), deps())).toMatchObject({ status: "started" });
    });
  });

  describe("dependency rules", () => {
    /** ENG-80, an epic with the tasks ENG-81 and ENG-82; OPS-90, another epic with the task OPS-91. */
    const addEpics = () => {
      const epic = tracker.add({ identifier: "ENG-80", title: "Epic" });
      const first = tracker.add({ identifier: "ENG-81", title: "First", parentId: epic.id });
      const second = tracker.add({ identifier: "ENG-82", title: "Second", parentId: epic.id });
      const other = tracker.add({ identifier: "OPS-90", title: "Other epic", teamKey: "OPS" });
      const otherTask = tracker.add({
        identifier: "OPS-91",
        title: "Their task",
        teamKey: "OPS",
        parentId: other.id,
      });
      return { epic, first, second, other, otherTask };
    };
    const noRun = async () => {
      expect(await db.select().from(ralphRuns)).toEqual([]);
      expect(await db.select().from(jobs)).toEqual([]);
    };

    it("starts a valid epic: blocked by another epic, a standalone task and its own task", async () => {
      const { epic, first, second, other } = addEpics();
      const standalone = tracker.add({ identifier: "OPS-92", title: "Alone", teamKey: "OPS" });
      await tracker.createBlocksRelation(other.id, epic.id);
      await tracker.createBlocksRelation(standalone.id, second.id);
      await tracker.createBlocksRelation(first.id, second.id);
      expect(await startRun(created(epic.id), deps())).toMatchObject({
        status: "started",
        run: { trackerIdentifier: "ENG-80" },
      });
    });

    it("refuses an epic whose task is blocked by a task in another epic, naming the fix", async () => {
      const { epic, second, otherTask } = addEpics();
      await tracker.createBlocksRelation(otherTask.id, second.id);
      const event = created(epic.id);
      const outcome = await startRun(event, deps());
      expect(outcome).toMatchObject({
        status: "relations",
        violations: [
          {
            blocker: { identifier: "OPS-91" },
            blocked: { identifier: "ENG-82" },
            reason: "task-in-other-epic",
            blockOn: { identifier: "OPS-90" },
          },
        ],
      });
      const [response] = tracker.bodies(event.sessionId, "response");
      expect(response).toContain("I won't start this: this relation breaks the dependency rules.");
      expect(response).toContain(
        "- ENG-82 is blocked by OPS-91: OPS-91 is a task in another epic, OPS-90. " +
          "Block ENG-82 on OPS-90 instead.",
      );
      expect(response).toContain("then delegate me again.");
      await noRun();
    });

    it("refuses an epic blocked by a task (another epic's, or its own), listing each relation", async () => {
      const { epic, first, otherTask } = addEpics();
      await tracker.createBlocksRelation(otherTask.id, epic.id);
      await tracker.createBlocksRelation(first.id, epic.id);
      const event = created(epic.id);
      const outcome = await startRun(event, deps());
      expect(outcome).toMatchObject({
        status: "relations",
        violations: [
          { blocker: { identifier: "OPS-91" }, reason: "task-in-other-epic" },
          { blocker: { identifier: "ENG-81" }, reason: "own-task" },
        ],
      });
      const [response] = tracker.bodies(event.sessionId, "response");
      expect(response).toContain("these relations break the dependency rules");
      expect(response).toContain("Block ENG-80 on OPS-90 instead.");
      expect(response).toContain("ENG-81 is a task in ENG-80, so it can't block its own epic.");
      await noRun();
    });

    it("refuses a delegated task of an epic whose relations break the rules", async () => {
      const { first, second, otherTask } = addEpics();
      await tracker.createBlocksRelation(otherTask.id, second.id);
      expect(await startRun(created(first.id), deps())).toMatchObject({ status: "relations" });
      await noRun();
    });

    it("refuses a standalone task blocked by a task in an epic", async () => {
      const { otherTask } = addEpics();
      const standalone = tracker.add({ identifier: "ENG-83", title: "Alone" });
      await tracker.createBlocksRelation(otherTask.id, standalone.id);
      const event = created(standalone.id);
      expect(await startRun(event, deps())).toMatchObject({
        status: "relations",
        violations: [{ blocked: { identifier: "ENG-83" }, blockOn: { identifier: "OPS-90" } }],
      });
      expect(tracker.bodies(event.sessionId, "response")[0]).toContain(
        "Block ENG-83 on OPS-90 instead.",
      );
      await noRun();
    });

    it("ignores canceled blockers and tasks already done", async () => {
      const { epic, first, otherTask } = addEpics();
      await tracker.createBlocksRelation(otherTask.id, first.id);
      await tracker.setIssueState(first.id, { type: "completed" });
      const dropped = tracker.add({
        identifier: "OPS-93",
        title: "Dropped",
        teamKey: "OPS",
        parentId: otherTask.parentId,
        stateType: "canceled",
        stateName: "Canceled",
      });
      await tracker.createBlocksRelation(dropped.id, epic.id);
      expect(await startRun(created(epic.id), deps())).toMatchObject({ status: "started" });
    });

    it("refuses a `/coding` mention and a `/coding` reply on a mention's run", async () => {
      const { epic, second, otherTask } = addEpics();
      await tracker.createBlocksRelation(otherTask.id, second.id);
      const coding = created(epic.id, { commentBody: "@omniralph /coding go" });
      expect(await startRun(coding, deps())).toMatchObject({ status: "relations" });
      await noRun();

      const mention = created(epic.id, { commentBody: "@omniralph what is left here?" });
      expect(await startRun(mention, deps())).toMatchObject({ status: "started" });
      const reply = await handleReply(
        { kind: "session_prompted", sessionId: mention.sessionId, body: "/coding" },
        deps(),
      );
      expect(reply).toEqual({ kind: "relations" });
      expect(tracker.bodies(mention.sessionId, "response").at(-1)).toContain(
        "then reply `/coding` again.",
      );
      expect((await getRunBySession(db, mention.sessionId))?.mode).toBe("request");
    });
  });

  describe("blocked labels", () => {
    it("refuses a delegation or mention of an issue with a default blocked label, before materializing", async () => {
      const issue = tracker.add({
        identifier: "ENG-70",
        title: "PRD",
        description: PRD,
        labels: ["Under-Review"],
      });
      const event = created(issue.id);
      expect(await startRun(event, deps())).toEqual({
        status: "blocked_labels",
        labels: ["Under-Review"],
      });
      const [response] = tracker.bodies(event.sessionId, "response");
      expect(response).toContain("I won't work on **ENG-70**");
      expect(response).toContain(
        "work items labeled `Under-Review` are blocked for Om in this organization",
      );
      expect(await db.select().from(ralphRuns)).toEqual([]);
      expect(await tracker.getChildren(issue.id)).toEqual([]);
      expect(tracker.issues.get(issue.id)?.stateType).toBe("unstarted");

      const mention = created(issue.id, { commentBody: "@omniralph fix the typo" });
      expect(await startRun(mention, deps())).toMatchObject({ status: "blocked_labels" });
      expect(await db.select().from(ralphRuns)).toEqual([]);
    });

    it("refuses a delegated story of a blocked epic", async () => {
      const epic = tracker.add({ identifier: "ENG-71", title: "Epic", labels: ["blocked"] });
      const story = tracker.add({ identifier: "ENG-72", title: "Store", parentId: epic.id });
      const event = created(story.id);
      expect(await startRun(event, deps())).toEqual({
        status: "blocked_labels",
        labels: ["blocked"],
      });
      expect(await db.select().from(ralphRuns)).toEqual([]);
    });

    it("uses the organization's labels, whichever repository the issue routes to; none blocks nothing", async () => {
      await setTrackerLabels(
        db,
        orgId,
        { manualLabels: ["manual"], blockedLabels: ["on hold"] },
        null,
      );
      // Routed to acme/api (team ENG) or acme/web (label frontend): refused either way.
      const held = tracker.add({ identifier: "ENG-73", title: "Held", labels: ["On Hold"] });
      expect(await startRun(created(held.id), deps())).toMatchObject({
        status: "blocked_labels",
        labels: ["On Hold"],
      });
      const web = tracker.add({
        identifier: "ENG-76",
        title: "UI",
        labels: ["Frontend", "on hold"],
      });
      expect(await startRun(created(web.id), deps())).toMatchObject({
        status: "blocked_labels",
        labels: ["on hold"],
      });
      // `blocked` is no longer one of them.
      const blocked = tracker.add({ identifier: "ENG-74", title: "Fine", labels: ["blocked"] });
      expect(await startRun(created(blocked.id), deps())).toMatchObject({ status: "started" });

      await setTrackerLabels(db, orgId, { manualLabels: ["manual"], blockedLabels: [] }, null);
      const ui = tracker.add({
        identifier: "ENG-75",
        title: "UI",
        labels: ["Frontend", "blocked"],
      });
      expect(await startRun(created(ui.id), deps())).toMatchObject({ status: "started" });
    });

    it("refuses an unrouted issue with a blocked label instead of asking for a repository", async () => {
      const issue = tracker.add({
        identifier: "OPS-70",
        title: "Infra",
        teamKey: "OPS",
        labels: ["blocked"],
      });
      const refused = created(issue.id);
      expect(await startRun(refused, deps())).toMatchObject({
        status: "blocked_labels",
        labels: ["blocked"],
      });
      expect(tracker.bodies(refused.sessionId, "response")[0]).toContain(
        "work items labeled `blocked` are blocked for Om in this organization",
      );
      expect(await db.select().from(ralphRuns)).toEqual([]);

      // Without a blocked label, every repository with coding on is offered.
      const other = tracker.add({ identifier: "OPS-71", title: "Infra", teamKey: "OPS" });
      const event = created(other.id);
      expect(await startRun(event, deps())).toMatchObject({ status: "selecting" });
      expect(
        (await getRunBySession(db, event.sessionId))?.pendingElicitation?.repositoryIds?.sort(),
      ).toEqual([repoId, otherRepoId].sort());
    });
  });

  it("re-delegation reuses the previous run's branch, PR, guidance and progress", async () => {
    const epic = tracker.add({ identifier: "ENG-60", title: "Epic" });
    tracker.add({ identifier: "ENG-61", title: "One", parentId: epic.id });
    const first = created(epic.id);
    await startRun(first, deps());
    const previous = (await getRunBySession(db, first.sessionId))!;
    await updateMainLane(previous, {
      branch: "custom/branch",
      prNumber: 7,
      prUrl: "https://github.com/acme/api/pull/7",
    });
    await updateRun(db, previous.id, {
      status: "failed",
      guidance: [{ text: "Use tabs", at: "2026-10-01T00:00:00.000Z" }],
      progress: "## Story ENG-61\nlearned things",
    });

    const second = created(epic.id);
    expect(await startRun(second, deps())).toMatchObject({ status: "started", created: true });
    const run = await withLane(await getRunBySession(db, second.sessionId));
    expect(run).toMatchObject({
      branch: "custom/branch",
      prNumber: 7,
      prUrl: "https://github.com/acme/api/pull/7",
      guidance: [{ text: "Use tabs", at: "2026-10-01T00:00:00.000Z" }],
      progress: "## Story ENG-61\nlearned things",
      status: "running",
    });
    expect(run!.id).not.toBe(previous.id);
    expect(tracker.bodies(second.sessionId, "thought")[0]).toContain(
      "Picking up where the previous session for this issue left off (https://github.com/acme/api/pull/7)",
    );
  });

  it("re-delegating an unfinished run supersedes it; a delegated story joins it", async () => {
    const epic = tracker.add({ identifier: "ENG-70", title: "Epic" });
    const story = tracker.add({ identifier: "ENG-71", title: "One", parentId: epic.id });
    const first = created(epic.id);
    await startRun(first, deps());
    const previous = (await getRunBySession(db, first.sessionId))!;
    const { job } = await insertJob(db, {
      organizationId: orgId,
      type: "ralph.story",
      taskType: "coding",
      ralphRunId: previous.id,
    });

    const focused = created(story.id);
    expect(await startRun(focused, deps())).toMatchObject({ status: "already_running" });
    expect(tracker.bodies(focused.sessionId, "response")[0]).toContain(
      "already being built in another session",
    );
    expect((await getRun(db, previous.id))?.status).toBe("running");

    // It was running the story with an early draft open.
    const [running] = await listStories(db, previous.id);
    await updateStory(db, running!.id, { status: "running", lastJobId: job.id });
    await updateRun(db, previous.id, { prJobId: job.id });
    await updateMainLane(previous, { prNumber: 7, prUrl: "https://github.com/acme/api/pull/7" });

    const again = created(epic.id);
    await startRun(again, deps());
    expect(await getRun(db, previous.id)).toMatchObject({
      status: "stopped",
      prJobId: null,
      error: `Superseded by agent session ${again.sessionId}`,
    });
    expect((await listStories(db, previous.id)).map((s) => s.status)).toEqual(["pending"]);
    const [canceled] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(canceled).toMatchObject({ status: "canceled", cancelRequested: true });
    expect(tracker.bodies(first.sessionId, "response")[0]).toContain("delegated to me again");
    expect(tracker.bodies(first.sessionId, "response")[0]).toContain(
      "https://github.com/acme/api/pull/7",
    );
    expect(await withLane(await getRunBySession(db, again.sessionId))).toMatchObject({
      branch: (await getMainLane(db, previous))!.branch,
      status: "running",
    });
  });

  it("a repeated session event doesn't start a second run", async () => {
    const issue = tracker.add({ identifier: "ENG-80", title: "Once" });
    const event = created(issue.id);
    await startRun(event, deps());
    const again = await startRun(event, deps());
    expect(again).toMatchObject({ status: "started", created: false });
    expect(await db.select().from(ralphRuns)).toHaveLength(1);
    // The run's description and its first story; nothing new for the repeat.
    expect(tracker.bodies(event.sessionId, "thought")).toHaveLength(2);
    expect(await db.select().from(jobs)).toHaveLength(1);
  });

  describe("advanceRun", () => {
    it("is idempotent, syncs stories from Linear and re-posts the plan on changes", async () => {
      const epic = tracker.add({ identifier: "ENG-90", title: "Epic" });
      const one = tracker.add({
        identifier: "ENG-91",
        title: "One",
        parentId: epic.id,
        labels: ["manual"],
      });
      const event = created(epic.id);
      await startRun(event, deps());
      const run = (await getRunBySession(db, event.sessionId))!;
      const plans = () => tracker.plans.get(event.sessionId) ?? [];
      const posted = plans().length;
      const elicitations = tracker.bodies(event.sessionId, "elicitation").length;

      // Waiting on the manual story: nothing changes, nothing is asked again.
      const first = await advanceRun(run.id, deps());
      const second = await advanceRun(run.id, deps());
      expect(first.action).toBe("waiting");
      expect(second).toMatchObject({ action: "waiting" });
      expect(await listStories(db, run.id)).toHaveLength(1);
      expect(plans().slice(posted)).toEqual([
        [{ content: "ENG-91: One (manual)", status: "pending" }],
        [{ content: "ENG-91: One (manual)", status: "pending" }],
      ]);
      expect(tracker.bodies(event.sessionId, "elicitation")).toHaveLength(elicitations);

      // A story added and one canceled in Linear: the new one runs.
      tracker.add({ identifier: "ENG-92", title: "Two", parentId: epic.id });
      await tracker.setIssueState(one.id, { type: "canceled" });
      expect(await advanceRun(run.id, deps())).toMatchObject({ action: "enqueued" });
      expect(tracker.plan(event.sessionId)).toEqual([
        { content: "ENG-91: One", status: "canceled" },
        { content: "ENG-92: Two", status: "inProgress" },
      ]);
      // A job is queued: nothing else happens until its outcome.
      expect(await advanceRun(run.id, deps())).toMatchObject({ action: "busy" });

      // A status change by the orchestrator updates the plan.
      await lockRun(db, run.id, async (tx, locked) => {
        const [, two] = await listStories(tx, run.id);
        await updateStoryAndPlan(tracker, tx, locked, two!, { status: "pending" });
      });
      expect(tracker.plan(event.sessionId)?.[1]).toEqual({
        content: "ENG-92: Two",
        status: "pending",
      });

      await updateRun(db, run.id, { status: "stopped" });
      const before = plans().length;
      expect(await advanceRun(run.id, deps())).toMatchObject({ action: "finished" });
      expect(plans()).toHaveLength(before);
      expect(await advanceRun(randomUUID(), deps())).toEqual({ action: "gone" });
    });

    it("runs one advance at a time per run", async () => {
      const issue = tracker.add({ identifier: "ENG-95", title: "Solo" });
      const event = created(issue.id);
      await startRun(event, deps());
      const run = (await getRunBySession(db, event.sessionId))!;
      let inside = 0;
      let overlap = false;
      const getIssue = tracker.getIssue.bind(tracker);
      tracker.getIssue = async (id: string) => {
        inside += 1;
        if (inside > 1) overlap = true;
        await new Promise((r) => setTimeout(r, 30));
        inside -= 1;
        return getIssue(id);
      };
      await Promise.all([advanceRun(run.id, deps()), advanceRun(run.id, deps())]);
      expect(overlap).toBe(false);
    });
  });
});
