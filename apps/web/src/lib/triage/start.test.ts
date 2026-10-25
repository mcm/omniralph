import { randomBytes } from "node:crypto";
import { InvalidInputLinearError } from "@linear/sdk";
import {
  closeDb,
  connectRepository,
  createDb,
  getJob,
  getTriageRunBySession,
  jobs,
  organizations,
  ralphRuns,
  createRun,
  repositories,
  seedReviewProfiles,
  setAllowedTaskTypeDefaults,
  triageRuns,
  updateRepositoryRalphSettings,
  upsertScmConnection,
  DEFAULT_RALPH_SETTINGS,
  replaceRoutingRules,
  type Database,
} from "@omniralph/db";
import type { ScmAdapter } from "@omniralph/scm";
import type { TriageTemplateContext } from "@omniralph/ralph";
import { QUERY_TASKS_MIN_HARNESS_VERSION, RunSpecJobPayload } from "@omniralph/shared";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresDispatcher } from "@/lib/dispatch/dispatcher";
import { handleLinearEvent } from "@/lib/linear/events";
import { AGENT_SESSION_MARKER } from "@/lib/ralph/start";
import { WorkItemNotFoundError } from "@/lib/work-items/tracker";
import { FakeLinearGateway } from "@/lib/linear/fake-gateway";
import type { TriageDeps } from "./start";
import { startTriage, type SessionCreatedEvent } from "./start";

vi.mock("server-only", () => ({}));
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("starting triage from an @omniralph /triage mention", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let repoId: string;
  let linear: FakeLinearGateway;
  let sessionSeq = 0;

  const fakeAdapter = {
    getDefaultBranch: async () => "develop",
  } as unknown as ScmAdapter;

  const deps = (): TriageDeps => ({
    db,
    organizationId: orgId,
    linear,
    dispatcher: new PostgresDispatcher({ db }),
    adapterFor: () => fakeAdapter,
  });

  const mention = (
    issueId: string,
    commentBody = "@omniralph /triage",
    overrides: Partial<SessionCreatedEvent> = {},
  ): SessionCreatedEvent => {
    sessionSeq += 1;
    return {
      kind: "session_created",
      sessionId: `triage-session-${sessionSeq}`,
      issueId,
      commentBody,
      creatorName: "Steve",
      ...overrides,
    };
  };

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
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
    await updateRepositoryRalphSettings(db, repoId, {
      ralphEnabled: true,
      ralphSettings: DEFAULT_RALPH_SETTINGS,
    });
    await replaceRoutingRules(db, orgId, [
      {
        repositoryId: repoId,
        query: {
          combinator: "and",
          rules: [{ field: "labels", operator: "containsAny", value: ["backend"] }],
        },
      },
    ]);
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    await db.delete(triageRuns);
    await db.delete(jobs);
    await db.delete(ralphRuns);
    linear = new FakeLinearGateway();
  });

  /** The queued run's payload, parsed, with its trigger context. */
  const payloadOf = async (jobId: string) => {
    const payload = RunSpecJobPayload.parse((await getJob(db, jobId))!.payload);
    expect(payload.trigger.kind).toBe("linear.triage");
    const context = payload.trigger.context as unknown as TriageTemplateContext & {
      triageRunId: string;
    };
    return { payload, context };
  };

  it("queues a builtin:triage run for a routed issue with its comments, children and blockers", async () => {
    const issue = linear.add({
      identifier: "ENG-1",
      title: "Priorities",
      description: "Let people set a priority.",
      stateType: "backlog",
      labels: ["Backend"],
      creator: { id: "user-1", name: "Ada" },
    });
    const child = linear.add({
      identifier: "ENG-2",
      title: "Store it",
      parentId: issue.id,
      stateType: "unstarted",
      priority: 2,
    });
    linear.add({
      identifier: "ENG-3",
      title: "Dropped",
      parentId: issue.id,
      stateType: "canceled",
    });
    const blocker = linear.add({ identifier: "ENG-9", title: "Schema", stateType: "started" });
    await linear.createBlocksRelation(blocker.id, child.id);
    linear.commentsByIssue.set(issue.id, [
      { body: "Only admins can set it.", author: "Bo", createdAt: "2026-10-01T00:00:00.000Z" },
    ]);

    const event = mention(issue.id, "@omniralph /triage it's for the API");
    // Through the webhook handler: `/triage` goes to triage, not to ralph.
    await handleLinearEvent(
      event,
      { db, organizationId: orgId, workspaceId: "ws-1" },
      {
        linear,
        dispatcher: new PostgresDispatcher({ db }),
        adapterFor: () => fakeAdapter,
      },
    );

    const run = await getTriageRunBySession(db, event.sessionId);
    expect(run).toMatchObject({
      organizationId: orgId,
      linearIssueId: issue.id,
      trigger: "mention",
      status: "queued",
    });
    expect(await db.select().from(ralphRuns)).toEqual([]);
    expect(run!.currentJobId).not.toBeNull();

    const job = (await getJob(db, run!.currentJobId!))!;
    expect(job).toMatchObject({
      type: "triage.run",
      taskType: "query",
      pool: "short",
      taskId: "builtin:triage",
      minHarnessVersion: QUERY_TASKS_MIN_HARNESS_VERSION,
      repositoryId: repoId,
      organizationId: orgId,
      status: "queued",
      targetHarnessId: null,
      triageRunId: run!.id,
      dedupeKey: `triage:${run!.id}`,
    });

    const { payload, context } = await payloadOf(job.id);
    // The default branch is checked out when it exists.
    expect(payload).toMatchObject({ repositoryId: repoId, ref: "develop" });
    expect(payload.requireCheckout).toBeUndefined();
    expect(context).toMatchObject({
      triageRunId: run!.id,
      issue: {
        identifier: "ENG-1",
        title: "Priorities",
        description: "Let people set a priority.",
        stateType: "backlog",
        creator: { name: "Ada" },
      },
      comments: {
        items: [
          { author: "Bo", body: "Only admins can set it.", createdAt: "2026-10-01T00:00:00.000Z" },
        ],
      },
      repository: "acme/api",
      branch: "develop",
      reply: "it's for the API",
      previousResult: null,
    });
    expect(context.children?.items.map((c) => [c.identifier, c.stateType, c.priority])).toEqual([
      ["ENG-2", "unstarted", "High"],
      ["ENG-3", "canceled", "No priority"],
    ]);
    expect(context.blockers).toEqual({
      items: [{ identifier: "ENG-9", title: "Schema", stateType: "started", blocks: "ENG-2" }],
    });

    const [thought] = linear.bodies(event.sessionId, "thought");
    expect(thought).toContain(
      "`acme/api` (routed by rule 1 (Labels contains any of backend)) at `develop`",
    );
    expect(linear.bodies(event.sessionId, "error")).toEqual([]);
    // Starting triage changes nothing in Linear.
    expect(linear.issueUpdates).toEqual([]);
    expect(linear.stateChanges).toEqual([]);
  });

  it("queues an unrouted issue without a repository", async () => {
    const issue = linear.add({ identifier: "OPS-1", title: "Rotate keys", teamKey: "OPS" });
    const event = mention(issue.id);

    const outcome = await startTriage(event, deps());
    expect(outcome).toMatchObject({ status: "queued", repository: null });

    const run = await getTriageRunBySession(db, event.sessionId);
    const job = (await getJob(db, run!.currentJobId!))!;
    expect(job.repositoryId).toBeNull();
    expect(job).toMatchObject({ status: "queued", targetHarnessId: null });
    const { payload, context } = await payloadOf(job.id);
    expect(payload.ref).toBeUndefined();
    expect(payload.repositoryId).toBeUndefined();
    expect(context).toMatchObject({
      repository: null,
      branch: null,
      reply: null,
      comments: null,
      children: null,
      blockers: null,
    });
    expect(context.issue.creator).toBeNull();
    expect(linear.bodies(event.sessionId, "thought")[0]).toContain("No repository routes it");

    // A redelivered event doesn't queue a second job.
    expect(await startTriage(event, deps())).toMatchObject({ status: "exists" });
    expect(await db.select().from(jobs)).toHaveLength(1);
  });

  it("skips an issue routed to a repository whose query tasks are off, without posting", async () => {
    const setQuery = (queryEnabled: boolean | null) =>
      db.update(repositories).set({ queryEnabled }).where(eq(repositories.id, repoId));
    const issue = linear.add({ identifier: "ENG-40", title: "Off", labels: ["backend"] });
    try {
      await setQuery(false);
      const event = mention(issue.id);
      expect(await startTriage(event, deps())).toEqual({
        status: "query_disabled",
        repository: "acme/api",
      });
      expect(await db.select().from(jobs)).toEqual([]);
      expect(await db.select().from(triageRuns)).toEqual([]);
      expect(linear.activities).toEqual([]);

      // Inheriting an organization default without query tasks.
      await setQuery(null);
      await setAllowedTaskTypeDefaults(db, orgId, ["review", "coding"], null);
      expect(await startTriage(mention(issue.id), deps())).toMatchObject({
        status: "query_disabled",
      });
      expect(await db.select().from(jobs)).toEqual([]);
      expect(linear.activities).toEqual([]);

      // Inheriting the built-in default (every task type) triages it.
      await setAllowedTaskTypeDefaults(db, orgId, null, null);
      expect(await startTriage(mention(issue.id), deps())).toMatchObject({ status: "queued" });
    } finally {
      await setQuery(null);
      await setAllowedTaskTypeDefaults(db, orgId, null, null);
    }
  });

  it("reads the routed repository even when its coding is off", async () => {
    const setCoding = (ralphEnabled: boolean | null) =>
      db.update(repositories).set({ ralphEnabled }).where(eq(repositories.id, repoId));
    const issue = linear.add({ identifier: "ENG-41", title: "Manual", labels: ["backend"] });
    try {
      await setCoding(false);
      const event = mention(issue.id);
      const outcome = await startTriage(event, deps());
      expect(outcome).toMatchObject({
        status: "queued",
        repository: { repositoryId: repoId, defaultBranch: "develop" },
      });
      expect(linear.bodies(event.sessionId, "thought")[0]).toContain(
        "`acme/api` (routed by rule 1 (Labels contains any of backend))",
      );
    } finally {
      await setCoding(true);
    }
  });

  it("triages a sub-issue in its epic's run repository", async () => {
    const epic = linear.add({ identifier: "OPS-50", title: "Epic", teamKey: "OPS" });
    const story = linear.add({ identifier: "OPS-51", title: "Story", parentId: epic.id });
    await createRun(db, {
      organizationId: orgId,
      linearIssueId: epic.id,
      linearIdentifier: "OPS-50",
      linearAgentSessionId: "session-epic",
      kind: "children",
      mode: "epic",
      repositoryId: repoId,
      routedBy: "your selection",
      branch: "feat/ops",
      baseBranch: "main",
    });
    const event = mention(story.id);
    expect(await startTriage(event, deps())).toMatchObject({
      status: "queued",
      repository: { repositoryId: repoId },
    });
    expect(linear.bodies(event.sessionId, "thought")[0]).toContain(
      "(routed by sub-issue of OPS-50 → your selection)",
    );
  });

  it("changes nothing for an issue in progress", async () => {
    const issue = linear.add({
      identifier: "ENG-20",
      title: "Busy",
      stateType: "started",
      labels: ["backend"],
    });
    const event = mention(issue.id);

    const outcome = await startTriage(event, deps());
    expect(outcome).toEqual({ status: "in_progress", issues: ["ENG-20"] });
    expect(await getTriageRunBySession(db, event.sessionId)).toBeNull();
    expect(await db.select().from(jobs)).toEqual([]);
    const [response] = linear.bodies(event.sessionId, "response");
    expect(response).toContain("**ENG-20** is already in progress or done");
    expect(response).toContain("changed nothing in Linear");
    expect(linear.issueUpdates).toEqual([]);
    expect(linear.stateChanges).toEqual([]);
    expect(linear.labelChanges).toEqual([]);
    expect(linear.comments).toEqual([]);
  });

  it("changes nothing for an epic with a done child", async () => {
    const epic = linear.add({ identifier: "ENG-30", title: "Epic", stateType: "backlog" });
    linear.add({ identifier: "ENG-31", title: "Open", parentId: epic.id });
    linear.add({ identifier: "ENG-32", title: "Done", parentId: epic.id, stateType: "completed" });
    linear.add({
      identifier: "ENG-33",
      title: "Dropped",
      parentId: epic.id,
      stateType: "canceled",
    });
    const event = mention(epic.id);

    const outcome = await startTriage(event, deps());
    expect(outcome).toEqual({ status: "in_progress", issues: ["ENG-32"] });
    expect(await db.select().from(jobs)).toEqual([]);
    expect(await db.select().from(triageRuns)).toEqual([]);
    expect(linear.bodies(event.sessionId, "response")[0]).toContain(
      "**ENG-32** is already in progress or done, so I didn't triage **ENG-30**",
    );
    expect(linear.issueUpdates).toEqual([]);
    expect(linear.stateChanges).toEqual([]);
  });

  it("refuses a second session while the issue is being triaged", async () => {
    const issue = linear.add({ identifier: "OPS-2", title: "Twice", teamKey: "OPS" });
    await startTriage(mention(issue.id), deps());
    const second = mention(issue.id);

    expect(await startTriage(second, deps())).toMatchObject({ status: "already_running" });
    expect(await db.select().from(jobs)).toHaveLength(1);
    expect(linear.bodies(second.sessionId, "response")[0]).toContain(
      "already being triaged in another session",
    );
  });

  it("sends a mention without /triage to ralph", async () => {
    const issue = linear.add({ identifier: "OPS-3", title: "Ralph", teamKey: "OPS" });
    const event = mention(issue.id, "@omniralph /ralph");
    await handleLinearEvent(
      event,
      { db, organizationId: orgId, workspaceId: "ws-1" },
      {
        linear,
        dispatcher: new PostgresDispatcher({ db }),
        adapterFor: () => fakeAdapter,
      },
    );
    expect(await db.select().from(triageRuns)).toEqual([]);
    expect(await db.select().from(ralphRuns)).toHaveLength(1);
  });

  it("sends a delegation to ralph even when the issue's text mentions /triage", async () => {
    // A delegation's session has no comment; its prompt context quotes the issue (and its
    // comments), which may mention `/triage` without asking for it.
    const issue = linear.add({
      identifier: "OPS-4",
      title: "Run /triage on new issues",
      description: "Use /triage first.",
      teamKey: "OPS",
    });
    const event = mention(issue.id, undefined, {
      commentBody: undefined,
      promptContext: `<issue identifier="OPS-4"><title>Run /triage on new issues</title></issue>`,
    });
    await handleLinearEvent(
      event,
      { db, organizationId: orgId, workspaceId: "ws-1" },
      {
        linear,
        dispatcher: new PostgresDispatcher({ db }),
        adapterFor: () => fakeAdapter,
      },
    );
    expect(await db.select().from(triageRuns)).toEqual([]);
    expect(await db.select().from(ralphRuns)).toHaveLength(1);
  });
  describe("a delegation reads the work item's readiness (default mapping)", () => {
    const delegation = (issueId: string, identifier?: string): SessionCreatedEvent =>
      mention(issueId, `${AGENT_SESSION_MARKER}. Delegated by Steve.`, {
        ...(identifier && { issueIdentifier: identifier }),
      });

    const handle = (event: SessionCreatedEvent) =>
      handleLinearEvent(
        event,
        { db, organizationId: orgId, workspaceId: "ws-1" },
        {
          linear,
          dispatcher: new PostgresDispatcher({ db }),
          adapterFor: () => fakeAdapter,
        },
      );

    const ready = (identifier: string, stateType: string, stateName: string) =>
      linear.add({
        identifier,
        title: "Priorities",
        description: "Let people set a priority.",
        stateType,
        stateName,
        labels: ["backend"],
      });

    it("triages a Backlog item in the delegation's own session, saying why first", async () => {
      const issue = ready("ENG-40", "backlog", "Backlog");
      const event = delegation(issue.id, "ENG-40");
      await handle(event);

      const run = await getTriageRunBySession(db, event.sessionId);
      expect(run).toMatchObject({ linearIssueId: issue.id, status: "queued" });
      expect(await db.select().from(ralphRuns)).toEqual([]);
      const activities = linear.activities.filter((a) => a.sessionId === event.sessionId);
      expect(activities[0]!.content).toEqual({
        type: "thought",
        body: "ENG-40 needs refining, so Om is triaging it first.",
      });
      // The delegation's system note guides nothing.
      const { context } = await payloadOf(run!.currentJobId!);
      expect(context.reply).toBeNull();

      // A redelivered event changes nothing.
      await handle(event);
      expect(await db.select().from(triageRuns)).toHaveLength(1);
      expect(await db.select().from(jobs)).toHaveLength(1);
      expect(await db.select().from(ralphRuns)).toEqual([]);
      expect(
        linear.bodies(event.sessionId, "thought").filter((b) => b.includes("needs refining")),
      ).toHaveLength(1);
    });

    it.each([
      ["Todo", "unstarted"],
      ["In Progress", "started"],
    ])("starts a run for a %s item", async (stateName, stateType) => {
      const issue = ready(`ENG-${stateType}`, stateType, stateName);
      const event = delegation(issue.id);
      await handle(event);
      expect(await db.select().from(triageRuns)).toEqual([]);
      expect(await db.select().from(ralphRuns)).toEqual([
        expect.objectContaining({ linearIssueId: issue.id, linearAgentSessionId: event.sessionId }),
      ]);
      expect(linear.bodies(event.sessionId, "thought").join("\n")).not.toContain("needs refining");
    });

    it("does nothing new for a redelivered delegation that already has its run", async () => {
      const issue = ready("ENG-41", "unstarted", "Todo");
      const event = delegation(issue.id);
      await handle(event);
      const [run] = await db.select().from(ralphRuns);
      const jobCount = (await db.select().from(jobs)).length;
      // Since moved to Backlog: the session's run is what counts, not the readiness.
      linear.issues.get(issue.id)!.stateType = "backlog";
      linear.issues.get(issue.id)!.stateName = "Backlog";
      await handle(event);
      expect(await db.select().from(ralphRuns)).toEqual([expect.objectContaining({ id: run!.id })]);
      expect(await db.select().from(triageRuns)).toEqual([]);
      expect(await db.select().from(jobs)).toHaveLength(jobCount);
    });

    it("runs what a mention asks for on a Backlog item: /coding starts a run", async () => {
      const issue = ready("ENG-42", "backlog", "Backlog");
      const event = mention(issue.id, "@omniralph /coding");
      await handle(event);
      expect(await db.select().from(triageRuns)).toEqual([]);
      expect(await db.select().from(ralphRuns)).toEqual([
        expect.objectContaining({ linearIssueId: issue.id, mode: "epic" }),
      ]);
    });

    it("starts a run, and logs why, when the work item can't be loaded", async () => {
      const issue = ready("ENG-43", "backlog", "Backlog");
      const load = linear.getIssue.bind(linear);
      let failed = false;
      linear.getIssue = async (id: string) => {
        if (!failed) {
          failed = true;
          throw new Error("Linear is down");
        }
        return load(id);
      };
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const event = delegation(issue.id, "ENG-43");
        await handle(event);
        expect(await db.select().from(triageRuns)).toEqual([]);
        expect(await db.select().from(ralphRuns)).toEqual([
          expect.objectContaining({ linearIssueId: issue.id }),
        ]);
        expect(logged).toHaveBeenCalledWith(
          expect.stringContaining("Reading the readiness of ENG-43 failed"),
          expect.objectContaining({ message: "Linear is down" }),
        );
      } finally {
        logged.mockRestore();
      }
    });

    it("starts a run when the work item isn't found", async () => {
      const issue = ready("ENG-44", "backlog", "Backlog");
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const load = linear.getIssue.bind(linear);
      let failed = false;
      // Linear answers an issue it can't see with an invalid input error.
      linear.getIssue = async (id: string) => {
        if (!failed) {
          failed = true;
          throw new InvalidInputLinearError({ message: "Entity not found" });
        }
        return load(id);
      };
      try {
        await handle(delegation(issue.id));
        expect(await db.select().from(ralphRuns)).toHaveLength(1);
        expect(logged).toHaveBeenCalledWith(
          expect.stringContaining("Reading the readiness"),
          expect.any(WorkItemNotFoundError),
        );
      } finally {
        logged.mockRestore();
      }
    });
  });
});
