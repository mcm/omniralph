import { randomBytes, randomUUID } from "node:crypto";
import { createMockAdapter, createMockState } from "@chat-adapter/tests";
import {
  chatLinearDelegations,
  connectRepository,
  createChatLinearDelegation,
  ensureChatThread,
  saveChatConnection,
  closeDb,
  createDb,
  getMainLane,
  getRun,
  getRunBySession,
  insertJob,
  integrations,
  jobs,
  listStories,
  lockRun,
  ralphRuns,
  runMigrations,
  saveIntegration,
  updateLane,
  updateRepositoryRalphSettings,
  updateRun,
  updateStory,
  upsertScmConnection,
  webhookDeliveries,
  DEFAULT_RALPH_SETTINGS,
  type Database,
  type RalphLaneUpdate,
  type RalphRun,
  type RepositoryRalphSettingsUpdate,
  organizations,
  seedReviewProfiles,
} from "@omniralph/db";
import type { ScmAdapter } from "@omniralph/scm";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VercelQueuesDispatcher } from "@/lib/dispatch/dispatcher";
import { RecordingPublisher } from "@/lib/dispatch/recording-publisher";
import { acknowledgeLinearEvent, handleLinearEvent } from "@/lib/linear/events";
import { FakeLinearGateway } from "@/lib/linear/fake-gateway";
import { handleLinearWebhook } from "@/lib/linear/ingest";
import { signBody, type LinearWebhookEvent } from "@/lib/linear/webhook";
import { handleReply } from "./reply";
import { advanceRun, updateStoryAndPlan } from "./run";
import {
  ACKNOWLEDGEMENT,
  AGENT_SESSION_MARKER,
  startRun,
  type SessionCreatedEvent,
  type StartRunDeps,
} from "./start";

vi.mock("server-only", () => ({}));
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

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

describe.skipIf(!dockerAvailable)("starting ralph runs from Linear delegations", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let orgId: string;
  let repoId: string;
  let otherRepoId: string;
  let linear: FakeLinearGateway;
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
    linear,
    dispatcher: new VercelQueuesDispatcher({ db, publisher: new RecordingPublisher() }),
    adapterFor: () => fakeAdapter,
  });

  const routing = (
    overrides: Partial<RepositoryRalphSettingsUpdate> = {},
  ): RepositoryRalphSettingsUpdate => ({
    ralphEnabled: true,
    linearTeamKeys: [],
    linearProjectNames: [],
    linearLabels: [],
    ralphSettings: DEFAULT_RALPH_SETTINGS,
    ...overrides,
  });

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

  const created = (
    issueId: string,
    overrides: Partial<SessionCreatedEvent> = {},
  ): SessionCreatedEvent => {
    sessionSeq += 1;
    return {
      kind: "session_created",
      sessionId: `session-${sessionSeq}`,
      issueId,
      commentBody: DELEGATION,
      ...overrides,
    };
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    await seedReviewProfiles(db, org!.id);
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
    await container?.stop();
  });

  beforeEach(async () => {
    await db.delete(jobs);
    await db.delete(ralphRuns);
    await updateRepositoryRalphSettings(db, repoId, routing({ linearTeamKeys: ["ENG"] }));
    await updateRepositoryRalphSettings(db, otherRepoId, routing({ linearLabels: ["frontend"] }));
    linear = new FakeLinearGateway();
    defaultBranchCalls = [];
  });

  it("starts a children epic: run, stories, started state, description and plan", async () => {
    const epic = linear.add({
      identifier: "ENG-1",
      title: "Priorities",
      description: "Epic.\n\n> Branch: feat/prio",
      stateType: "backlog",
    });
    const a = linear.add({ identifier: "ENG-2", title: "Store", parentId: epic.id });
    const b = linear.add({
      identifier: "ENG-3",
      title: "Access",
      parentId: epic.id,
      labels: ["Manual"],
    });
    linear.add({ identifier: "ENG-4", title: "Show", parentId: epic.id, stateType: "completed" });
    await linear.createBlocksRelation(a.id, b.id);

    const event = created(epic.id);
    const outcome = await startRun(event, deps());
    expect(outcome).toMatchObject({ status: "started", created: true });

    const run = await withLane(await getRunBySession(db, event.sessionId));
    expect(run).toMatchObject({
      linearIssueId: epic.id,
      linearIdentifier: "ENG-1",
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
    expect(linear.issues.get(epic.id)?.stateType).toBe("started");
    const [thought] = linear.bodies(event.sessionId, "thought");
    expect(thought).toContain("**ENG-1** is an epic with 3 stories (1 already done)");
    expect(thought).toContain("`acme/api` (routed by team `ENG`) on branch `feat/prio`");
    expect(thought).toContain("Manual steps for a person: **ENG-3**");
    expect(linear.plan(event.sessionId)).toEqual([
      { content: "ENG-2: Store", status: "inProgress" },
      { content: "ENG-3: Access (manual)", status: "pending" },
      { content: "ENG-4: Show", status: "completed" },
    ]);
    expect(linear.bodies(event.sessionId, "error")).toEqual([]);
  });

  it("materializes a PRD's stories as sub-issues and loads it as an epic", async () => {
    const epic = linear.add({ identifier: "ENG-10", title: "PRD", description: PRD });
    const event = created(epic.id);
    await startRun(event, deps());

    const children = await linear.getChildren(epic.id);
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
    expect(linear.blocks.get(show!.id)).toEqual([store!.id]);

    const run = await withLane(await getRunBySession(db, event.sessionId));
    expect(run).toMatchObject({ kind: "prd", branch: "feat/priorities", baseBranch: "develop" });
    expect((await listStories(db, run!.id)).map((s) => [s.title, s.status])).toEqual([
      ["Store priority", "running"],
      ["Grant database access", "manual"],
      ["Show priority", "pending"],
    ]);
    expect(linear.bodies(event.sessionId, "thought")[0]).toContain(
      "Created 3 story sub-issues from the PRD",
    );
    expect(linear.plan(event.sessionId)?.map((step) => step.status)).toEqual([
      "inProgress",
      "pending",
      "pending",
    ]);
  });

  it("marks and materializes manual stories with the routed repository's manual labels", async () => {
    await updateRepositoryRalphSettings(
      db,
      repoId,
      routing({
        linearTeamKeys: ["ENG"],
        ralphSettings: { ...DEFAULT_RALPH_SETTINGS, manualLabels: ["by hand", "ops"] },
      }),
    );
    // A children epic: the custom labels (any case) mark manual stories, `manual` no longer does.
    const epic = linear.add({ identifier: "ENG-20", title: "Epic" });
    linear.add({ identifier: "ENG-21", title: "Code", parentId: epic.id, labels: ["manual"] });
    linear.add({ identifier: "ENG-22", title: "DNS", parentId: epic.id, labels: ["By Hand"] });
    linear.add({ identifier: "ENG-23", title: "Keys", parentId: epic.id, labels: ["OPS"] });
    const event = created(epic.id);
    await startRun(event, deps());
    const run = await getRunBySession(db, event.sessionId);
    expect((await listStories(db, run!.id)).map((s) => [s.identifier, s.status])).toEqual([
      ["ENG-21", "running"],
      ["ENG-22", "manual"],
      ["ENG-23", "manual"],
    ]);

    // A delegated sub-issue loads its parent's epic with the same labels.
    const parent = linear.add({ identifier: "ENG-30", title: "Epic" });
    const story = linear.add({ identifier: "ENG-31", title: "Code", parentId: parent.id });
    linear.add({ identifier: "ENG-32", title: "DNS", parentId: parent.id, labels: ["by hand"] });
    const focused = created(story.id);
    await startRun(focused, deps());
    const focusedRun = await getRunBySession(db, focused.sessionId);
    expect((await listStories(db, focusedRun!.id)).map((s) => [s.identifier, s.status])).toEqual([
      ["ENG-31", "running"],
      ["ENG-32", "manual"],
    ]);

    // A PRD's manual story is created with the first label.
    const prd = linear.add({ identifier: "ENG-40", title: "PRD", description: PRD });
    const prdEvent = created(prd.id);
    await startRun(prdEvent, deps());
    expect((await linear.getChildren(prd.id)).map((c) => [c.title, c.labels])).toEqual([
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
    const epic = linear.add({ identifier: "ENG-15", title: "PRD", description: PRD });
    // The first try created one sub-issue, then failed.
    const store = linear.add({ identifier: "ENG-16", title: "Store priority", parentId: epic.id });
    const event = created(epic.id);
    await startRun(event, deps());

    const children = await linear.getChildren(epic.id);
    expect(children.map((c) => c.title)).toEqual([
      "Store priority",
      "Grant database access",
      "Show priority",
    ]);
    expect(linear.blocks.get(children[2]!.id)).toEqual([store.id]);
    const run = await getRunBySession(db, event.sessionId);
    expect(run).toMatchObject({ kind: "prd" });
    expect((await listStories(db, run!.id)).map((s) => s.title)).toEqual([
      "Store priority",
      "Grant database access",
      "Show priority",
    ]);
    expect(linear.bodies(event.sessionId, "thought")[0]).toContain(
      "Created 2 story sub-issues from the PRD",
    );
  });

  it("treats a plain issue as a single story", async () => {
    const issue = linear.add({ identifier: "ENG-20", title: "Fix the login bug" });
    const event = created(issue.id);
    await startRun(event, deps());
    const run = await withLane(await getRunBySession(db, event.sessionId));
    expect(run).toMatchObject({
      kind: "single",
      linearIssueId: issue.id,
      branch: issue.branchName,
    });
    expect(
      (await listStories(db, run!.id)).map((s) => [s.linearIssueId, s.identifier, s.status]),
    ).toEqual([[issue.id, "ENG-20", "running"]]);
    expect(linear.issues.get(issue.id)?.stateType).toBe("started");
    expect(linear.plan(event.sessionId)).toEqual([
      { content: "ENG-20: Fix the login bug", status: "inProgress" },
    ]);
  });

  it("loads a delegated sub-issue's epic, focused on that story", async () => {
    const epic = linear.add({ identifier: "ENG-30", title: "Epic", stateType: "started" });
    linear.add({ identifier: "ENG-31", title: "One", parentId: epic.id });
    const two = linear.add({ identifier: "ENG-32", title: "Two", parentId: epic.id });
    const event = created(two.id);
    await startRun(event, deps());
    const run = await getRunBySession(db, event.sessionId);
    expect(run).toMatchObject({
      linearIssueId: epic.id,
      linearIdentifier: "ENG-30",
      kind: "children",
      focusStoryId: two.id,
    });
    expect((await listStories(db, run!.id)).map((s) => s.identifier)).toEqual(["ENG-31", "ENG-32"]);
    expect(linear.bodies(event.sessionId, "thought")[0]).toContain("I'll start with ENG-32");
  });

  it("routes by label before team; without any ralph-enabled repository explains how to enable one", async () => {
    const labelled = linear.add({ identifier: "ENG-40", title: "UI", labels: ["Frontend"] });
    const event = created(labelled.id);
    await startRun(event, deps());
    expect(await getRunBySession(db, event.sessionId)).toMatchObject({
      repositoryId: otherRepoId,
      routedBy: "label `Frontend`",
    });

    await updateRepositoryRalphSettings(db, repoId, routing({ ralphEnabled: false }));
    await updateRepositoryRalphSettings(db, otherRepoId, routing({ ralphEnabled: false }));
    const elsewhere = linear.add({ identifier: "OPS-1", title: "Infra", teamKey: "OPS" });
    const unroutable = created(elsewhere.id);
    expect(await startRun(unroutable, deps())).toEqual({ status: "unroutable" });
    const [error] = linear.bodies(unroutable.sessionId, "error");
    expect(error).toContain("no repository has ralph enabled");
    expect(error).toContain("Repository › Settings › Ralph");
    expect(error).toContain("[repo=<owner/name>]");

    expect(await db.select().from(ralphRuns)).toHaveLength(1);
    expect(linear.issues.get(elsewhere.id)?.stateType).toBe("unstarted");
  });

  describe("the repository question", () => {
    const reply = (sessionId: string, body: string) =>
      handleReply({ kind: "session_prompted", sessionId, body }, deps());
    const selects = () => linear.activities.filter((a) => a.options?.signal === "select");

    it("asks which repository when nothing matches, then continues with the reply", async () => {
      const epic = linear.add({ identifier: "OPS-10", title: "Infra", teamKey: "OPS" });
      linear.add({ identifier: "OPS-11", title: "One", teamKey: "OPS", parentId: epic.id });
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
      expect(linear.issues.get(epic.id)?.stateType).toBe("unstarted");
      const [ask] = selects();
      expect(ask?.content).toMatchObject({ type: "elicitation" });
      expect(ask?.options?.signalMetadata).toEqual({
        options: [{ value: "acme/api" }, { value: "acme/web" }],
      });
      expect(linear.bodies(event.sessionId, "elicitation")[0]).toContain(
        "Which repository should I work in for this issue?",
      );
      expect(linear.bodies(event.sessionId, "elicitation")[0]).toContain("`[repo=owner/name]`");
      expect(linear.bodies(event.sessionId, "elicitation")[0]).toContain(
        "Repository › Settings › Ralph",
      );

      // Advancing again (e.g. the reconcile cron) waits without asking twice.
      expect(await advanceRun(run.id, deps())).toMatchObject({ action: "waiting" });
      expect(selects()).toHaveLength(1);

      // An unmatched reply re-asks; a matching one picks the repository and starts.
      expect(await reply(event.sessionId, "mobile")).toEqual({ kind: "repository_selection" });
      expect(selects()).toHaveLength(2);
      expect(linear.bodies(event.sessionId, "elicitation")[1]).toContain(
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
      expect(linear.bodies(event.sessionId, "thought")).toContainEqual(
        expect.stringContaining("Using `acme/web`."),
      );
      expect(linear.issues.get(epic.id)?.stateType).toBe("started");
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
      expect(linear.bodies(again.sessionId, "thought")[0]).toContain(
        "Building it in `acme/web` (routed by your selection)",
      );
      expect(selects()).toHaveLength(2);
    });

    it("matches a reply by number, and asks again when a stopped run resumes", async () => {
      const issue = linear.add({ identifier: "OPS-15", title: "Infra", teamKey: "OPS" });
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
      const epic = linear.add({ identifier: "OPS-20", title: "Infra", teamKey: "OPS" });
      const first = created(epic.id);
      await startRun(first, deps());
      await reply(first.sessionId, "web");
      const picked = (await getRunBySession(db, first.sessionId))!;
      expect(picked).toMatchObject({ repositoryId: otherRepoId, status: "running" });

      // Team routing to api now matches, but the human's pick wins.
      await updateRun(db, picked.id, { status: "failed" });
      await db.delete(jobs);
      linear.issues.get(epic.id)!.teamKey = "ENG";
      const second = created(epic.id);
      await startRun(second, deps());
      expect(await getRunBySession(db, second.sessionId)).toMatchObject({
        repositoryId: otherRepoId,
        routedBy: "your selection",
      });

      // Routed by label to web; once the label is gone routing can't decide, so it stays in web.
      const other = linear.add({
        identifier: "OPS-21",
        title: "Other",
        teamKey: "OPS",
        labels: ["frontend"],
      });
      const third = created(other.id);
      await startRun(third, deps());
      const routed = (await getRunBySession(db, third.sessionId))!;
      expect(routed).toMatchObject({ repositoryId: otherRepoId, routedBy: "label `frontend`" });
      await updateRun(db, routed.id, { status: "failed" });
      await db.delete(jobs);
      linear.issues.get(other.id)!.labels = [];
      const fourth = created(other.id);
      expect(await startRun(fourth, deps())).toMatchObject({ status: "started", created: true });
      expect(await getRunBySession(db, fourth.sessionId)).toMatchObject({
        repositoryId: otherRepoId,
        routedBy: "label `frontend`",
      });
      expect(selects()).toHaveLength(1);
    });

    it("says why a `[repo=…]` tag didn't route", async () => {
      const tagged = linear.add({
        identifier: "ENG-41",
        title: "Tagged",
        description: "[repo=acme/unknown]",
      });
      const event = created(tagged.id);
      expect(await startRun(event, deps())).toMatchObject({ status: "selecting" });
      const [question] = linear.bodies(event.sessionId, "elicitation");
      expect(question).toContain("Its `[repo=…]` tag (`acme/unknown`) names no repository");
      expect(question).toContain("Which repository should I work in for this issue?");
    });
  });

  it("re-routing to another repository moves the run there and leaves the earlier work alone", async () => {
    const epic = linear.add({ identifier: "ENG-45", title: "UI", labels: ["Frontend"] });
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

    // A new `[repo=…]` tag sends it to api.
    linear.issues.get(epic.id)!.description = "Now \\[repo=acme/api\\]";
    const second = created(epic.id);
    await startRun(second, deps());
    const moved = await withLane(await getRunBySession(db, second.sessionId));
    expect(moved).toMatchObject({
      repositoryId: repoId,
      routedBy: "`[repo=…]` tag `acme/api`",
      prNumber: null,
      prUrl: null,
    });
    expect(moved?.branch).not.toBe("custom/branch");
    const [note] = linear.bodies(second.sessionId, "thought");
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
    const issue = linear.add({ identifier: "ENG-50", title: "Question" });
    const event = created(issue.id, { commentBody: "@omniralph" });
    expect(await startRun(event, deps())).toEqual({ status: "nothing" });
    expect(linear.bodies(event.sessionId, "response")).toEqual([
      "Nothing to do: the mention didn't include a request. Delegate the issue to me to work the epic.",
    ]);
    expect(await db.select().from(ralphRuns)).toEqual([]);
    expect(linear.issues.get(issue.id)?.stateType).toBe("unstarted");
  });

  describe("open questions", () => {
    const QUESTIONS = `${PRD}\n## Open Questions\n\n1. Which column type?\n`;

    it("refuses a delegation while the PRD has open questions", async () => {
      const issue = linear.add({ identifier: "ENG-60", title: "PRD", description: QUESTIONS });
      const event = created(issue.id);
      expect(await startRun(event, deps())).toEqual({
        status: "open_questions",
        identifier: "ENG-60",
      });
      const [response] = linear.bodies(event.sessionId, "response");
      expect(response).toContain("**ENG-60** still has open questions");
      expect(response).toContain("reply in the triage session");
      expect(await db.select().from(ralphRuns)).toEqual([]);
      // Nothing materialized, no state change.
      expect(await linear.getChildren(issue.id)).toEqual([]);
      expect(linear.issues.get(issue.id)?.stateType).toBe("unstarted");
    });

    it("refuses a delegated sub-issue of an epic with open questions, and `/ralph` mentions", async () => {
      const epic = linear.add({
        identifier: "ENG-61",
        title: "Epic",
        description: "Epic.\n\n## Open Questions\n\n1. Which team?",
      });
      const story = linear.add({ identifier: "ENG-62", title: "Store", parentId: epic.id });
      const event = created(story.id);
      expect(await startRun(event, deps())).toEqual({
        status: "open_questions",
        identifier: "ENG-61",
      });
      expect(linear.bodies(event.sessionId, "response")[0]).toContain(
        "the epic **ENG-61** still has open questions",
      );

      const mention = created(epic.id, { commentBody: "@omniralph /ralph go" });
      expect(await startRun(mention, deps())).toMatchObject({ status: "open_questions" });
      expect(await db.select().from(ralphRuns)).toEqual([]);
    });

    it("starts issues without open questions, and request-mode mentions regardless", async () => {
      const issue = linear.add({
        identifier: "ENG-63",
        title: "Plain",
        description: "Do it.\n\n## Open Questions\n\n",
      });
      expect(await startRun(created(issue.id), deps())).toMatchObject({
        status: "started",
        created: true,
      });

      const asked = linear.add({ identifier: "ENG-64", title: "PRD", description: QUESTIONS });
      expect(
        await startRun(
          created(asked.id, { commentBody: "@omniralph what does this need?" }),
          deps(),
        ),
      ).toMatchObject({ status: "started", created: true });
    });

    it("refuses a delegation when Linear can't be read for the check", async () => {
      const issue = linear.add({ identifier: "ENG-65", title: "PRD", description: PRD });
      linear.failures.set("getIssue", new Error("rate limited"));
      const event = created(issue.id);
      expect(await startRun(event, deps())).toEqual({
        status: "load_failed",
        error: "rate limited",
      });
      expect(linear.bodies(event.sessionId, "error")[0]).toContain(
        "I couldn't check the issue for open questions in Linear, so I didn't start: rate limited.",
      );
      expect(await db.select().from(ralphRuns)).toEqual([]);
      expect(linear.issues.get(issue.id)?.stateType).toBe("unstarted");
    });
  });

  it("re-delegation reuses the previous run's branch, PR, guidance and progress", async () => {
    const epic = linear.add({ identifier: "ENG-60", title: "Epic" });
    linear.add({ identifier: "ENG-61", title: "One", parentId: epic.id });
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
    expect(linear.bodies(second.sessionId, "thought")[0]).toContain(
      "Picking up where the previous session for this issue left off (https://github.com/acme/api/pull/7)",
    );
  });

  it("re-delegating an unfinished run supersedes it; a delegated story joins it", async () => {
    const epic = linear.add({ identifier: "ENG-70", title: "Epic" });
    const story = linear.add({ identifier: "ENG-71", title: "One", parentId: epic.id });
    const first = created(epic.id);
    await startRun(first, deps());
    const previous = (await getRunBySession(db, first.sessionId))!;
    const { job } = await insertJob(db, {
      organizationId: orgId,
      capability: "ralph",
      type: "ralph.story",
      ralphRunId: previous.id,
    });

    const focused = created(story.id);
    expect(await startRun(focused, deps())).toMatchObject({ status: "already_running" });
    expect(linear.bodies(focused.sessionId, "response")[0]).toContain(
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
    expect(linear.bodies(first.sessionId, "response")[0]).toContain("delegated to me again");
    expect(linear.bodies(first.sessionId, "response")[0]).toContain(
      "https://github.com/acme/api/pull/7",
    );
    expect(await withLane(await getRunBySession(db, again.sessionId))).toMatchObject({
      branch: (await getMainLane(db, previous))!.branch,
      status: "running",
    });
  });

  it("a repeated session event doesn't start a second run", async () => {
    const issue = linear.add({ identifier: "ENG-80", title: "Once" });
    const event = created(issue.id);
    await startRun(event, deps());
    const again = await startRun(event, deps());
    expect(again).toMatchObject({ status: "started", created: false });
    expect(await db.select().from(ralphRuns)).toHaveLength(1);
    // The run's description and its first story; nothing new for the repeat.
    expect(linear.bodies(event.sessionId, "thought")).toHaveLength(2);
    expect(await db.select().from(jobs)).toHaveLength(1);
  });

  describe("advanceRun", () => {
    it("is idempotent, syncs stories from Linear and re-posts the plan on changes", async () => {
      const epic = linear.add({ identifier: "ENG-90", title: "Epic" });
      const one = linear.add({
        identifier: "ENG-91",
        title: "One",
        parentId: epic.id,
        labels: ["manual"],
      });
      const event = created(epic.id);
      await startRun(event, deps());
      const run = (await getRunBySession(db, event.sessionId))!;
      const plans = () => linear.plans.get(event.sessionId) ?? [];
      const posted = plans().length;
      const elicitations = linear.bodies(event.sessionId, "elicitation").length;

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
      expect(linear.bodies(event.sessionId, "elicitation")).toHaveLength(elicitations);

      // A story added and one canceled in Linear: the new one runs.
      linear.add({ identifier: "ENG-92", title: "Two", parentId: epic.id });
      await linear.setIssueState(one.id, { type: "canceled" });
      expect(await advanceRun(run.id, deps())).toMatchObject({ action: "enqueued" });
      expect(linear.plan(event.sessionId)).toEqual([
        { content: "ENG-91: One", status: "canceled" },
        { content: "ENG-92: Two", status: "inProgress" },
      ]);
      // A job is queued: nothing else happens until its outcome.
      expect(await advanceRun(run.id, deps())).toMatchObject({ action: "busy" });

      // A status change by the orchestrator updates the plan.
      await lockRun(db, run.id, async (tx, locked) => {
        const [, two] = await listStories(tx, run.id);
        await updateStoryAndPlan(linear, tx, locked, two!, { status: "pending" });
      });
      expect(linear.plan(event.sessionId)?.[1]).toEqual({
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
      const issue = linear.add({ identifier: "ENG-95", title: "Solo" });
      const event = created(issue.id);
      await startRun(event, deps());
      const run = (await getRunBySession(db, event.sessionId))!;
      let inside = 0;
      let overlap = false;
      const getIssue = linear.getIssue.bind(linear);
      linear.getIssue = async (id: string) => {
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

  describe("through the webhook", () => {
    const SECRET = "linear-secret";

    beforeEach(async () => {
      await db.delete(webhookDeliveries);
      await db.delete(integrations);
      await saveIntegration(db, {
        organizationId: orgId,
        provider: "linear",
        externalId: "org-1",
        name: "Acme",
        credentials: { accessToken: "t" },
        installedByUserId: null,
      });
    });

    it("acknowledges before responding, starts the run after, and dedupes redeliveries", async () => {
      const issue = linear.add({ identifier: "ENG-100", title: "Hooked" });
      const deferred: Array<() => Promise<void>> = [];
      const payload = {
        type: "AgentSessionEvent",
        action: "created",
        organizationId: "org-1",
        webhookTimestamp: Date.now(),
        agentSession: {
          id: "session-hook",
          issue: { id: issue.id, identifier: "ENG-100" },
          comment: { body: DELEGATION },
        },
      };
      const deliver = (deliveryId: string) => {
        const body = JSON.stringify(payload);
        return handleLinearWebhook(
          new Request("https://omniralph.example.com/api/webhooks/linear", {
            method: "POST",
            headers: { "linear-signature": signBody(body, SECRET), "linear-delivery": deliveryId },
            body,
          }),
          {
            db,
            secret: SECRET,
            acknowledge: (event, context) => acknowledgeLinearEvent(event, context, linear),
            handle: async (event: Exclude<LinearWebhookEvent, { kind: "ignored" }>) => {
              if (event.kind === "session_created") await startRun(event, deps());
            },
            defer: (task) => {
              deferred.push(task);
            },
          },
        );
      };

      const id = randomUUID();
      expect(await (await deliver(id)).json()).toEqual({
        status: "accepted",
        kind: "session_created",
      });
      // Only the acknowledgement so far.
      expect(linear.activities).toEqual([
        {
          sessionId: "session-hook",
          content: { type: "thought", body: ACKNOWLEDGEMENT },
          options: { ephemeral: true },
        },
      ]);
      expect(await db.select().from(ralphRuns)).toEqual([]);

      expect(await (await deliver(id)).json()).toEqual({ status: "duplicate" });
      for (const task of deferred.splice(0)) await task();

      expect(await db.select().from(ralphRuns)).toHaveLength(1);
      expect(linear.bodies("session-hook", "thought")).toHaveLength(3);
      expect(linear.plan("session-hook")).toEqual([
        { content: "ENG-100: Hooked", status: "inProgress" },
      ]);
    });

    it("ties the run of an issue delegated from chat to the thread, keeping its Linear origin", async () => {
      const connection = await saveChatConnection(db, {
        organizationId: orgId,
        platform: "discord",
        externalId: "G-webhook",
        name: "Acme",
        credentials: null,
        installedByUserId: null,
      });
      if (connection === "other_organization") throw new Error("connected elsewhere");
      const thread = (await ensureChatThread(db, {
        connectionId: connection.id,
        externalThreadId: "discord:G-webhook:CH1:TH1",
        channelId: "discord:G-webhook:CH1",
        startedByExternalUserId: "D-ADA",
      }))!;
      const issue = linear.add({ identifier: "ENG-110", title: "From chat" });
      await createChatLinearDelegation(db, {
        organizationId: orgId,
        threadId: thread.id,
        linearIssueId: issue.id,
      });
      const adapter = createMockAdapter("discord");
      const chat = {
        db,
        adapters: { discord: adapter },
        state: createMockState(),
        appUrl: "https://omniralph.example.com",
      };
      const body = JSON.stringify({
        type: "AgentSessionEvent",
        action: "created",
        organizationId: "org-1",
        webhookTimestamp: Date.now(),
        agentSession: {
          id: "session-from-chat",
          issue: { id: issue.id, identifier: "ENG-110" },
          comment: { body: DELEGATION },
        },
      });
      await handleLinearWebhook(
        new Request("https://omniralph.example.com/api/webhooks/linear", {
          method: "POST",
          headers: { "linear-signature": signBody(body, SECRET), "linear-delivery": randomUUID() },
          body,
        }),
        {
          db,
          secret: SECRET,
          handle: (event, context) =>
            handleLinearEvent(event, context, {
              linear,
              dispatcher: new VercelQueuesDispatcher({ db, publisher: new RecordingPublisher() }),
              adapterFor: () => fakeAdapter,
              chat,
            }),
        },
      );

      expect(await getRunBySession(db, "session-from-chat")).toMatchObject({
        origin: "linear",
        linearIssueId: issue.id,
        chatThreadId: thread.id,
        status: "running",
      });
      expect(await db.select().from(chatLinearDelegations)).toEqual([]);
      expect(adapter.postMessage).toHaveBeenCalledOnce();
      expect(adapter.postMessage).toHaveBeenCalledWith("discord:G-webhook:CH1:TH1", {
        markdown: expect.stringContaining("🚀 Ralph started building [ENG-110 From chat]"),
      });
    });

    it("routes only to repositories of the organization that connected the workspace", async () => {
      // Another organization, with its own workspace and a repository matching team OPS.
      const [other] = await db.insert(organizations).values({ name: "Other" }).returning();
      await seedReviewProfiles(db, other!.id);
      const otherConnection = (await upsertScmConnection(
        db,
        {
          organizationId: other!.id,
          provider: "github",
          name: "other",
          baseUrl: "https://api.github.com",
          externalId: "other-installation",
          credentials: {},
        },
        randomBytes(32),
      ))!;
      const foreignRepoId = (
        await connectRepository(db, {
          connectionId: otherConnection.id,
          provider: "github",
          externalId: "99",
          fullPath: "other/ops",
        })
      ).id;
      await updateRepositoryRalphSettings(db, foreignRepoId, routing({ linearTeamKeys: ["OPS"] }));
      await saveIntegration(db, {
        organizationId: other!.id,
        provider: "linear",
        externalId: "org-2",
        name: "Other",
        credentials: { accessToken: "t2" },
        installedByUserId: null,
      });

      const deliver = (workspaceId: string, sessionId: string, issue: { id: string }) => {
        const body = JSON.stringify({
          type: "AgentSessionEvent",
          action: "created",
          organizationId: workspaceId,
          webhookTimestamp: Date.now(),
          agentSession: {
            id: sessionId,
            issue: { id: issue.id, identifier: "OPS-1" },
            comment: { body: DELEGATION },
          },
        });
        return handleLinearWebhook(
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
                linear,
                dispatcher: new VercelQueuesDispatcher({ db, publisher: new RecordingPublisher() }),
                adapterFor: () => fakeAdapter,
              }),
          },
        );
      };

      // From our workspace: team OPS matches only the other organization's repository,
      // which is ignored, so a person is asked to pick one of ours.
      const ours = linear.add({ identifier: "OPS-1", title: "Infra", teamKey: "OPS" });
      await deliver("org-1", "session-ours", ours);
      const run = await getRunBySession(db, "session-ours");
      expect(run).toMatchObject({ organizationId: orgId, repositoryId: null, status: "waiting" });
      expect(run!.pendingElicitation).toMatchObject({ kind: "repository" });
      const offered = (run!.pendingElicitation as { repositoryIds: string[] }).repositoryIds;
      expect(offered.sort()).toEqual([repoId, otherRepoId].sort());
      expect(linear.bodies("session-ours", "elicitation").join("\n")).not.toContain("other/ops");

      // From the other organization's workspace, the same team routes to its repository.
      const theirs = linear.add({ identifier: "OPS-2", title: "Infra", teamKey: "OPS" });
      await deliver("org-2", "session-theirs", theirs);
      expect(await getRunBySession(db, "session-theirs")).toMatchObject({
        organizationId: other!.id,
        repositoryId: foreignRepoId,
        routedBy: "team `OPS`",
      });
    });
  });
});
