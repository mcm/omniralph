import { randomBytes, randomUUID } from "node:crypto";
import {
  connectRepository,
  createDb,
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
  updateRepositoryRalphSettings,
  updateRun,
  updateStory,
  upsertScmConnection,
  webhookDeliveries,
  DEFAULT_RALPH_SETTINGS,
  type Database,
  type RepositoryRalphSettingsUpdate,
} from "@omniralph/db";
import type { ScmAdapter } from "@omniralph/scm";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VercelQueuesDispatcher } from "@/lib/dispatch/dispatcher";
import { RecordingPublisher } from "@/lib/dispatch/recording-publisher";
import { acknowledgeLinearEvent } from "@/lib/linear/events";
import { FakeLinearGateway } from "@/lib/linear/fake-gateway";
import { handleLinearWebhook } from "@/lib/linear/ingest";
import { signBody, type LinearWebhookEvent } from "@/lib/linear/webhook";
import { advanceRun, updateStoryAndPlan } from "./run";
import {
  ACKNOWLEDGEMENT,
  AGENT_SESSION_MARKER,
  MENTION_RESPONSE,
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
    const connection = await upsertScmConnection(
      db,
      {
        provider: "github",
        name: "acme",
        baseUrl: "https://api.github.com",
        externalId: "1",
        credentials: {},
      },
      randomBytes(32),
    );
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
    await db?.$client.end();
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

    const run = await getRunBySession(db, event.sessionId);
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

    const run = await getRunBySession(db, event.sessionId);
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
    const run = await getRunBySession(db, event.sessionId);
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

  it("routes by label before team, and explains how to route an unroutable issue", async () => {
    const labelled = linear.add({ identifier: "ENG-40", title: "UI", labels: ["Frontend"] });
    const event = created(labelled.id);
    await startRun(event, deps());
    expect(await getRunBySession(db, event.sessionId)).toMatchObject({
      repositoryId: otherRepoId,
    });

    const elsewhere = linear.add({ identifier: "OPS-1", title: "Infra", teamKey: "OPS" });
    const unroutable = created(elsewhere.id);
    expect(await startRun(unroutable, deps())).toEqual({ status: "unroutable" });
    const [error] = linear.bodies(unroutable.sessionId, "error");
    expect(error).toContain("no repository with ralph enabled is routed to it");
    expect(error).toContain("Repository › Settings › Ralph");
    expect(error).toContain("[repo=<owner/name>]");

    const tagged = linear.add({
      identifier: "ENG-41",
      title: "Tagged",
      description: "[repo=acme/unknown]",
    });
    const taggedEvent = created(tagged.id);
    expect(await startRun(taggedEvent, deps())).toEqual({ status: "unroutable" });
    expect(linear.bodies(taggedEvent.sessionId, "error")[0]).toContain("`acme/unknown`");

    const runs = await db.select().from(ralphRuns);
    expect(runs).toHaveLength(1);
    expect(linear.issues.get(elsewhere.id)?.stateType).toBe("unstarted");
  });

  it("answers a mention that isn't a delegation without starting a run", async () => {
    const issue = linear.add({ identifier: "ENG-50", title: "Question" });
    const event = created(issue.id, { commentBody: "@omniralph can you push this?" });
    expect(await startRun(event, deps())).toEqual({ status: "mention" });
    expect(linear.bodies(event.sessionId, "response")).toEqual([MENTION_RESPONSE]);
    expect(await db.select().from(ralphRuns)).toEqual([]);
    expect(linear.issues.get(issue.id)?.stateType).toBe("unstarted");
  });

  it("re-delegation reuses the previous run's branch, PR, guidance and progress", async () => {
    const epic = linear.add({ identifier: "ENG-60", title: "Epic" });
    linear.add({ identifier: "ENG-61", title: "One", parentId: epic.id });
    const first = created(epic.id);
    await startRun(first, deps());
    const previous = (await getRunBySession(db, first.sessionId))!;
    await updateRun(db, previous.id, {
      status: "failed",
      branch: "custom/branch",
      prNumber: 7,
      prUrl: "https://github.com/acme/api/pull/7",
      guidance: [{ text: "Use tabs", at: "2026-10-01T00:00:00.000Z" }],
      progress: "## Story ENG-61\nlearned things",
    });

    const second = created(epic.id);
    expect(await startRun(second, deps())).toMatchObject({ status: "started", created: true });
    const run = await getRunBySession(db, second.sessionId);
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
    await updateRun(db, previous.id, {
      prNumber: 7,
      prUrl: "https://github.com/acme/api/pull/7",
      prJobId: job.id,
    });

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
    expect(await getRunBySession(db, again.sessionId)).toMatchObject({
      branch: previous.branch,
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
  });
});
