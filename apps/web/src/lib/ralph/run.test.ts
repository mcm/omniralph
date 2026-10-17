import { randomBytes } from "node:crypto";
import { createMockAdapter, createMockState } from "@chat-adapter/tests";
import {
  harnessRepoPins,
  insertTaskDefinition,
  chatLinearDelegations,
  chatMessages,
  chatRunEvents,
  createChatLinearDelegation,
  ensureChatThread,
  saveChatConnection,
  harnesses,
  hiddenRefs,
  completeJob,
  connectRepository,
  closeDb,
  createDb,
  ensureLane,
  failJob,
  getJob,
  getMainLane,
  updateLane,
  getRun,
  getRunBySession,
  getRunDetail,
  insertMessage,
  listLanes,
  jobs,
  listStories,
  pinRepositoryToHarness,
  ralphLanes,
  ralphRuns,
  repositories,
  claimJob,
  updateRepositoryRalphSettings,
  updateRun,
  upsertScmConnection,
  DEFAULT_RALPH_SETTINGS,
  type Database,
  type Job,
  organizations,
  seedReviewProfiles,
  setAllowedTaskTypeDefaults,
  type LinearRun,
} from "@omniralph/db";
import { teamIs, projectIs, setRoutingRules } from "@/lib/routing/testing";
import {
  CODING_TASKS_MIN_HARNESS_VERSION,
  MAX_JOB_DELIVERIES,
  QUERY_TASKS_MIN_HARNESS_VERSION,
  RalphPushPayload,
  RalphRequestPayload,
  ralphHiddenRef,
  type RalphDescribePrPayload,
  type RalphPushResult,
  RalphStoryPayload,
  WorktreeCleanupPayload,
  type WorktreeCleanupResult,
  type RalphDescribePrResult,
  type RalphRequestResult,
  type RalphStoryResult,
} from "@omniralph/shared";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { revokeHarness } from "@/lib/harness-auth/revoke";
import { PostgresDispatcher } from "@/lib/dispatch/dispatcher";
import { handleLinearEvent } from "@/lib/linear/events";
import { FakeLinearGateway, linearRun } from "@/lib/linear/fake-gateway";
import { FakeScmAdapter } from "@/lib/scm/fake-adapter";
import { taskSink } from "@/lib/sinks";
import { describePrPayload, ralphJobPayload } from "./coding";
import { onRalphCleanupJobFinished, onRalphJobFinished, onRalphJobStarted } from "./jobs";
import { FOLLOW_UP_MARK } from "./outcome";
import { reconcileRuns, RECONCILE_STALE_MS } from "./reconcile";
import type { Adapter } from "chat";
import type { ChatChannel } from "./conversation";
import { fitTitle } from "@omniralph/ralph";
import { CODING_DEFAULTS, getBuiltinTask, type TaskDefinition } from "@omniralph/tasks";
import type * as Tasks from "@omniralph/tasks";
import { organizationDefinitions } from "@/lib/definitions";
import { advanceRun, laneHarnessId, MAX_ITERATIONS_PER_RUN, runDedupeKey } from "./run";
import { AGENT_SESSION_MARKER, startRun, type StartRunDeps } from "./start";

vi.mock("server-only", () => ({}));
/** Built-in tasks some tests change (the resolver reads built-ins through `getBuiltinTask`). */
const changedBuiltins = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@omniralph/tasks", async (importOriginal) => {
  const actual = await importOriginal<typeof Tasks>();
  return {
    ...actual,
    getBuiltinTask: (id: string) =>
      (changedBuiltins.get(id) as TaskDefinition | undefined) ?? actual.getBuiltinTask(id),
  };
});
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
process.env.CRON_SECRET = "cron-secret";

const databaseAvailable = testDatabaseAvailable();

const sha = (n: number) => n.toString(16).padStart(40, "0");

const EPIC_DESCRIPTION = `Build the thing.

## Quality Gates
- \`pnpm test\`
- \`pnpm lint\`
`;

it("caps a run's story attempts at the coding tasks' default maxIterationsPerRun", () => {
  expect(CODING_DEFAULTS.maxIterationsPerRun).toBe(MAX_ITERATIONS_PER_RUN);
});

describe.skipIf(!databaseAvailable)("driving the ralph loop from story results", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let repoId: string;
  let gitlabRepoId: string;
  let agentA: string;
  let agentB: string;
  let linear: FakeLinearGateway;
  let dispatcher: PostgresDispatcher;
  let sessionSeq = 0;

  let scm: FakeScmAdapter;
  /** The chat bot runs delegated from a chat thread notify (set by those tests). */
  let chat: ChatChannel | undefined;
  const deps = (): StartRunDeps => ({
    db,
    organizationId: orgId,
    linear,
    dispatcher,
    adapterFor: () => scm.asAdapter(),
    ...(chat && { chat }),
  });

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
      linearTeamKeys: ["ENG"],
      linearProjectNames: [],
      linearLabels: [],
      ralphSettings: { ...DEFAULT_RALPH_SETTINGS, setupCommand: "pnpm install" },
    });
    const gitlab = (await upsertScmConnection(
      db,
      {
        organizationId: orgId,
        provider: "gitlab",
        name: "gitlab",
        baseUrl: "https://gitlab.example.com",
        externalId: "gitlab.example.com",
        credentials: { token: "t", webhookSecret: "s" },
      },
      randomBytes(32),
    ))!;
    gitlabRepoId = (
      await connectRepository(db, {
        connectionId: gitlab.id,
        provider: "gitlab",
        externalId: "42",
        fullPath: "group/app",
      })
    ).id;
    await updateRepositoryRalphSettings(db, gitlabRepoId, {
      ralphEnabled: true,
      linearTeamKeys: ["GL"],
      linearProjectNames: ["Web"],
      linearLabels: [],
      ralphSettings: DEFAULT_RALPH_SETTINGS,
    });
    await setRoutingRules(
      db,
      orgId,
      [gitlabRepoId, projectIs("Web")],
      [repoId, teamIs("ENG")],
      [gitlabRepoId, teamIs("GL")],
    );
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    await db.delete(jobs);
    await db.delete(ralphRuns);
    await db.delete(harnessRepoPins);
    await db.delete(harnesses);
    [{ id: agentA }, { id: agentB }] = (await db
      .insert(harnesses)
      .values([
        {
          organizationId: orgId,
          name: "agent-a",
          acceptedTaskTypes: ["query", "review", "coding"],
        },
        {
          organizationId: orgId,
          name: "agent-b",
          acceptedTaskTypes: ["query", "review", "coding"],
        },
      ])
      .returning({ id: harnesses.id })) as [{ id: string }, { id: string }];
    linear = new FakeLinearGateway();
    scm = new FakeScmAdapter();
    dispatcher = new PostgresDispatcher({ db });
    chat = undefined;
  });

  /** Delegates `issueId` and returns its run. */
  async function delegate(issueId: string): Promise<LinearRun> {
    sessionSeq += 1;
    const sessionId = `session-${sessionSeq}`;
    await startRun(
      {
        kind: "session_created",
        sessionId,
        issueId,
        commentBody: `${AGENT_SESSION_MARKER}.`,
      },
      deps(),
    );
    return linearRun((await getRunBySession(db, sessionId))!);
  }

  const activeJobs = (runId: string) =>
    db
      .select()
      .from(jobs)
      .where(and(eq(jobs.ralphRunId, runId), inArray(jobs.status, ["queued", "running"])));

  async function activeJob(runId: string): Promise<Job> {
    const [job, ...more] = await activeJobs(runId);
    expect(job, "the run has a queued job").toBeDefined();
    expect(more).toEqual([]);
    return job!;
  }

  const result = (overrides: Partial<RalphStoryResult> = {}): RalphStoryResult => ({
    status: "complete",
    summary: "Did the work.",
    followUps: [],
    feedback: null,
    usage: { inputTokens: 10, outputTokens: 20 },
    durationMs: 1000,
    ...overrides,
  });

  type Outcome = Partial<RalphStoryResult> | { jobError: string };

  /** A story job's own payload (a coding run's trigger context). */
  const storyPayload = (job: Job) => RalphStoryPayload.parse(ralphJobPayload(job));

  /** The job's outcome hooks: a coding run's are the `ralph-run` sink's, the same ralph hooks. */
  const expectRalphHooks = async (job: Job) => {
    if (job.taskId !== null)
      expect((await taskSink(job, organizationDefinitions(db, job.organizationId)))?.kind).toBe(
        "ralph-run",
      );
  };

  /**
   * Plays the agent's part for the run's queued job (start, then a result or a
   * failure) through the job lifecycle and its outcome hooks. Returns the payload.
   */
  async function work(
    runId: string,
    outcome: Outcome = {},
    harnessId = agentA,
  ): Promise<RalphStoryPayload> {
    const job = await activeJob(runId);
    const started = await claimJob(db, {
      organizationId: orgId,
      harnessId,
      acceptedTaskTypes: ["query", "coding"],
      pools: ["short", "long"],
      harnessVersion: CODING_TASKS_MIN_HARNESS_VERSION,
      maxDeliveries: MAX_JOB_DELIVERIES,
    });
    expect(started.claim?.job.id).toBe(job.id);
    expect(await onRalphJobStarted(db, job, harnessId)).toEqual({ skip: false });
    if ("jobError" in outcome) {
      await failJob(db, {
        jobId: job.id,
        harnessId,
        retryable: false,
        error: outcome.jobError,
        maxDeliveries: MAX_JOB_DELIVERIES,
      });
    } else {
      const status = await completeJob(db, {
        jobId: job.id,
        harnessId,
        result: result(outcome),
      });
      expect(status).toEqual({ status: "completed" });
    }
    await expectRalphHooks(job);
    await onRalphJobFinished(db, (await getJob(db, job.id))!, deps());
    return storyPayload(job);
  }

  const description = (overrides: Partial<RalphDescribePrResult> = {}): RalphDescribePrResult => ({
    title: "Build the epic",
    body: "Builds it.\n\n**Stories**\n- ENG-2: Alpha\n\n**Verification**\n- `pnpm test`",
    usage: { inputTokens: 5, outputTokens: 5 },
    ...overrides,
  });

  type DescribeOutcome =
    | Partial<RalphDescribePrResult>
    | { jobError: string }
    /** A completed run whose result isn't a title and body. */
    | { invalid: true };

  /**
   * Plays the agent's part for the run's queued describe job (a description,
   * an invalid result or a failure): a `ralph.describe-pr` job, or on the
   * `tasks` path a query run whose `run-result` sink hands it to the ralph
   * run (its `onStarted`, then the ralph hooks). Returns the
   * `ralph.describe-pr` payload (a query run's is in its trigger context).
   */
  async function describePr(
    runId: string,
    outcome: DescribeOutcome = {},
    harnessId = agentA,
  ): Promise<RalphDescribePrPayload> {
    const job = await activeJob(runId);
    expect(job.type).toBe("ralph.describe-pr");
    const { claim } = await claimJob(db, {
      organizationId: orgId,
      harnessId,
      acceptedTaskTypes: ["query", "coding"],
      pools: ["short", "long"],
      // A query run needs a harness that runs query tasks.
      harnessVersion: "99.0.0",
      maxDeliveries: MAX_JOB_DELIVERIES,
    });
    expect(claim?.job.id).toBe(job.id);
    const sink = await taskSink(job, organizationDefinitions(db, job.organizationId));
    if (job.taskId !== null) expect(sink?.kind).toBe("run-result");
    expect(await (sink?.onStarted ?? onRalphJobStarted)(db, job, harnessId)).toEqual({
      skip: false,
    });
    if ("jobError" in outcome) {
      await failJob(db, {
        jobId: job.id,
        harnessId,
        retryable: false,
        error: outcome.jobError,
        maxDeliveries: MAX_JOB_DELIVERIES,
      });
    } else {
      const { title, body, usage } = description("invalid" in outcome ? {} : outcome);
      const text = "invalid" in outcome ? { summary: body } : { title, body };
      const result =
        job.taskId === null
          ? { ...text, usage }
          : {
              outcome: "answered",
              answer: null,
              structured: text,
              references: [],
              usage,
              durationMs: 1000,
            };
      if (job.taskId !== null) expect(sink?.parseResult?.(result)).not.toBeNull();
      await completeJob(db, { jobId: job.id, harnessId, result });
    }
    await onRalphJobFinished(db, (await getJob(db, job.id))!, deps());
    const payload = describePrPayload(job);
    expect(payload).not.toBeNull();
    return payload!;
  }

  /** The run with its main lane's PR/MR (where v2a kept them on the run). */
  const withPullRequest = async (runId: string) => {
    const run = await getRun(db, runId);
    const lane = run && (await getMainLane(db, run));
    return run && { ...run, prNumber: lane?.prNumber ?? null, prUrl: lane?.prUrl ?? null };
  };

  const storyStates = async (runId: string) =>
    (await listStories(db, runId)).map((s) => [s.identifier, s.status, s.attempts]);

  /** A story's status, attempts and rounds. */
  const storyRounds = async (runId: string, identifier: string) => {
    const story = (await listStories(db, runId)).find((s) => s.identifier === identifier)!;
    return { status: story.status, attempts: story.attempts, rounds: story.rounds };
  };

  /** A review loop's round: blocked, with a follow-up to fix and (optionally) its score. */
  const reviewRound = (n: number, value?: number): Partial<RalphStoryResult> => ({
    status: "blocked",
    summary: `Round ${n} found problems.`,
    followUps: [{ title: `Fix round ${n}`, description: "Fix it.", manual: false }],
    ...(value !== undefined && {
      metric: { name: "critique score", value, direction: "higher" as const },
    }),
  });

  describe.each(["legacy", "tasks"] as const)("on the %s coding path", (path) => {
    beforeEach(async () => {
      await db.update(repositories).set({ codingPath: path });
    });

    afterEach(async () => {
      await db.update(repositories).set({
        codingPath: "legacy",
        storyTaskId: "builtin:implement-story",
        requestTaskId: "builtin:handle-request",
      });
    });

    /** A story or request job's routing on this path: a coding run of `taskId`, or a legacy job. */
    const routing = (taskId: string) => ({
      taskType: "coding",
      pool: "long",
      taskId: path === "tasks" ? taskId : null,
      minHarnessVersion: path === "tasks" ? CODING_TASKS_MIN_HARNESS_VERSION : null,
    });

    it("builds a 3-story epic in priority and blocker order, then completes", async () => {
      const epic = linear.add({
        identifier: "ENG-1",
        title: "Epic",
        description: `${EPIC_DESCRIPTION}\n> Branch: feat/epic`,
      });
      const alpha = linear.add({
        identifier: "ENG-2",
        title: "Alpha",
        parentId: epic.id,
        priority: 3,
      });
      const beta = linear.add({
        identifier: "ENG-3",
        title: "Beta",
        parentId: epic.id,
        priority: 1,
      });
      const gamma = linear.add({
        identifier: "ENG-4",
        title: "Gamma",
        parentId: epic.id,
        priority: 2,
      });
      await linear.createBlocksRelation(gamma.id, beta.id);

      const run = await delegate(epic.id);
      const first = await activeJob(run.id);
      expect(first).toMatchObject({
        type: "ralph.story",
        ...routing("builtin:implement-story"),
        repositoryId: repoId,
        ralphRunId: run.id,
        targetHarnessId: null,
      });
      const payload = storyPayload(first);
      if (path === "tasks") {
        // Today's payload is the coding run's trigger context.
        expect(first.payload).toMatchObject({
          trigger: { kind: "linear.delegated", context: payload },
          repositoryId: repoId,
        });
      }
      expect(payload).toMatchObject({
        runId: run.id,
        repositoryId: repoId,
        repository: {
          provider: "github",
          fullPath: "acme/api",
          cloneUrl: "https://github.com/acme/api.git",
        },
        branch: "feat/epic",
        baseBranch: "develop",
        settings: { model: "opus", setupCommand: "pnpm install" },
        attempt: 1,
        epic: { identifier: "ENG-1", title: "Epic", kind: "children" },
        story: { identifier: "ENG-4", title: "Gamma", linearIssueId: gamma.id },
        commitMessage: "feat(ENG-4): Gamma",
        qualityGates: ["pnpm test", "pnpm lint"],
        lastFeedback: null,
        guidance: [],
      });
      expect(payload.epic.prd).toContain("Build the thing.");
      expect(payload.progress).toContain("# Progress Log");
      expect(payload.stories).toEqual([
        ...[
          { identifier: "ENG-2", title: "Alpha", status: "open", manual: false, dependsOn: [] },
          {
            identifier: "ENG-3",
            title: "Beta",
            status: "open",
            manual: false,
            dependsOn: ["ENG-4"],
          },
          { identifier: "ENG-4", title: "Gamma", status: "open", manual: false, dependsOn: [] },
        ].map((s) => ({ ...s, repository: null })),
      ]);
      expect(linear.issues.get(gamma.id)?.stateType).toBe("started");
      expect(linear.plan(run.linearAgentSessionId)?.map((s) => s.status)).toEqual([
        "pending",
        "pending",
        "inProgress",
      ]);

      // Gamma completes: Beta (priority 1, now unblocked) is next, on the sticky agent.
      await work(run.id, { commitSha: sha(1), summary: "Gamma done." });
      expect(linear.issues.get(gamma.id)?.stateType).toBe("completed");
      expect(linear.comments).toEqual([
        {
          issueId: gamma.id,
          body: `✅ Completed by Omniralph in \`${sha(1).slice(0, 10)}\` on \`feat/epic\`.\n\nGamma done.`,
        },
      ]);
      expect((await getRun(db, run.id))?.harnessId).toBe(agentA);
      const second = await activeJob(run.id);
      expect(second.targetHarnessId).toBe(agentA);
      expect(second).toMatchObject(routing("builtin:implement-story"));
      const betaPayload = storyPayload(second);
      expect(betaPayload.story.identifier).toBe("ENG-3");
      expect(betaPayload.progress).toContain("ENG-4: Gamma");
      expect(betaPayload.progress).toContain("Gamma done.");

      // The session's own progress log replaces the run's.
      await work(run.id, { commitSha: sha(2), progress: "# Log\n\n## Beta learnings\n" });
      expect((await getRun(db, run.id))?.progress).toBe("# Log\n\n## Beta learnings\n");
      const alphaPayload = await work(run.id, { commitSha: sha(3) });
      expect(alphaPayload.story.identifier).toBe("ENG-2");
      expect(alphaPayload.progress).toBe("# Log\n\n## Beta learnings\n");

      // Every story is done: one describe job on the sticky agent, then the PR.
      expect((await getRun(db, run.id))?.status).toBe("running");
      const describeJob = await activeJob(run.id);
      expect(describeJob).toMatchObject({
        type: "ralph.describe-pr",
        taskType: "query",
        pool: "short",
        targetHarnessId: agentA,
        ralphRunId: run.id,
        dedupeKey: runDedupeKey(run.id),
        taskId: path === "tasks" ? "builtin:describe-pr" : null,
        minHarnessVersion: path === "tasks" ? QUERY_TASKS_MIN_HARNESS_VERSION : null,
      });
      if (path === "tasks") {
        // A query run of the story task's `prDescriptionTaskId` in a checkout of the branch, with
        // today's payload and the values its template renders.
        expect(describeJob.payload).toMatchObject({
          trigger: {
            kind: "run.invoked",
            context: {
              invoker: { kind: "ralph-run", id: run.id },
              payload: describePrPayload(describeJob),
              branch: "feat/epic",
              baseBranch: "develop",
              prTerm: "pull request",
              epic: { identifier: "ENG-1", title: "Epic" },
              stories: {
                items: [
                  { identifier: "ENG-2", title: "Alpha", commit: sha(3).slice(0, 10) },
                  { identifier: "ENG-3", title: "Beta", commit: sha(2).slice(0, 10) },
                  { identifier: "ENG-4", title: "Gamma", commit: sha(1).slice(0, 10) },
                ],
              },
              qualityGates: { items: ["pnpm test", "pnpm lint"] },
            },
          },
          repositoryId: repoId,
          ref: "feat/epic",
          requireCheckout: true,
        });
      }
      const describePayload = await describePr(run.id);
      expect(describePayload).toMatchObject({
        runId: run.id,
        branch: "feat/epic",
        baseBranch: "develop",
        epic: {
          identifier: "ENG-1",
          title: "Epic",
          prd: expect.stringContaining("Build the thing."),
        },
        stories: [
          { identifier: "ENG-2", title: "Alpha", status: "completed", commitSha: sha(3) },
          { identifier: "ENG-3", title: "Beta", status: "completed", commitSha: sha(2) },
          { identifier: "ENG-4", title: "Gamma", status: "completed", commitSha: sha(1) },
        ],
        progress: expect.stringContaining("## Beta learnings\n\n## [") as string,
        qualityGates: ["pnpm test", "pnpm lint"],
      });

      const done = (await withPullRequest(run.id))!;
      expect(done).toMatchObject({
        status: "completed",
        iterations: 3,
        waitingOn: null,
        prNumber: 1,
        prUrl: "https://github.com/acme/api/pull/1",
        prJobId: null,
      });
      expect(await storyStates(run.id)).toEqual([
        ["ENG-2", "completed", 1],
        ["ENG-3", "completed", 1],
        ["ENG-4", "completed", 1],
      ]);
      expect((await listStories(db, run.id)).map((s) => s.commitSha)).toEqual([
        sha(3),
        sha(2),
        sha(1),
      ]);
      expect(linear.issues.get(alpha.id)?.stateType).toBe("completed");
      expect(linear.plan(run.linearAgentSessionId)?.map((s) => s.status)).toEqual([
        "completed",
        "completed",
        "completed",
      ]);
      expect(linear.bodies(run.linearAgentSessionId, "response")).toEqual([
        [
          "Finished all 3 stories of **ENG-1** on `feat/epic`. Opened [Pull request #1](https://github.com/acme/api/pull/1), ready for review.",
          "",
          `- ✅ **ENG-2**: Alpha (\`${sha(3).slice(0, 10)}\`)`,
          `- ✅ **ENG-3**: Beta (\`${sha(2).slice(0, 10)}\`)`,
          `- ✅ **ENG-4**: Gamma (\`${sha(1).slice(0, 10)}\`)`,
        ].join("\n"),
      ]);
      expect(scm.changeRequests).toEqual([
        expect.objectContaining({
          number: 1,
          sourceBranch: "feat/epic",
          targetBranch: "develop",
          title: "Build the epic",
          body: expect.stringMatching(
            /^Builds it\.\n\n\*\*Stories\*\*\n- ENG-2: Alpha[\s\S]*\n\n---\nLinear: \[ENG-1\]\(https:\/\/linear\.app\/.+\) · _Opened by Omniralph\._$/,
          ),
          draft: false,
        }),
      ]);
      expect(scm.calls).toEqual([
        "getDefaultBranch",
        "findOpenChangeRequest",
        "createChangeRequest",
        "findOpenChangeRequest",
        "markChangeRequestReady",
      ]);
      expect(linear.urls).toEqual([
        {
          sessionId: run.linearAgentSessionId,
          label: "Pull request #1",
          url: "https://github.com/acme/api/pull/1",
        },
      ]);
      expect(await db.select().from(jobs).where(eq(jobs.ralphRunId, run.id))).toHaveLength(4);
      expect(linear.bodies(run.linearAgentSessionId, "error")).toEqual([]);
    });

    it("sends the first job to the pinned agent, then sticks to the agent that ran it until it's revoked", async () => {
      await pinRepositoryToHarness(db, { harnessId: agentB, repositoryId: repoId });
      const epic = linear.add({ identifier: "ENG-10", title: "Epic" });
      for (const [i, title] of ["One", "Two", "Three"].entries()) {
        linear.add({ identifier: `ENG-1${i + 1}`, title, parentId: epic.id, subIssueSortOrder: i });
      }
      const run = await delegate(epic.id);
      expect((await activeJob(run.id)).targetHarnessId).toBe(agentB);

      // The pin is removed and the job retargeted, so agent A takes it: the run sticks to A from now on.
      await db.delete(harnessRepoPins);
      expect(await dispatcher.republish((await activeJob(run.id)).id)).toBe(true);
      expect((await activeJob(run.id)).targetHarnessId).toBeNull();
      await work(run.id, {}, agentA);
      const second = await activeJob(run.id);
      expect(second.targetHarnessId).toBe(agentA);

      // A is revoked while the job waits for it: it goes back to any of the org's ralph harnesses.
      await revokeHarness(agentA, { db, dispatcher });
      expect(await getJob(db, second.id)).toMatchObject({
        status: "queued",
        targetHarnessId: null,
      });
      await work(run.id, {}, agentB);
      expect((await getRun(db, run.id))?.harnessId).toBe(agentB);
      expect((await activeJob(run.id)).targetHarnessId).toBe(agentB);
    });

    it("retries a failed attempt with its feedback and completes", async () => {
      const epic = linear.add({
        identifier: "ENG-20",
        title: "Epic",
        description: EPIC_DESCRIPTION,
      });
      linear.add({ identifier: "ENG-21", title: "Only", parentId: epic.id });
      const run = await delegate(epic.id);

      await work(run.id, {
        status: "failed",
        summary: "Gate failed",
        feedback: "The quality gate `pnpm test` failed:\n\n1 test failed",
      });
      expect(await storyStates(run.id)).toEqual([["ENG-21", "running", 1]]);
      expect(linear.bodies(run.linearAgentSessionId, "thought").join("\n")).toContain(
        "**ENG-21** attempt 1/3 did not complete; retrying with feedback.",
      );
      const retry = await work(run.id, { commitSha: sha(9) });
      expect(retry).toMatchObject({
        attempt: 2,
        lastFeedback: "The quality gate `pnpm test` failed:\n\n1 test failed",
      });
      expect(await storyStates(run.id)).toEqual([["ENG-21", "completed", 2]]);
      expect((await listStories(db, run.id))[0]).toMatchObject({
        lastFeedback: null,
        commitSha: sha(9),
      });
      await describePr(run.id);
      expect((await getRun(db, run.id))?.status).toBe("completed");
    });

    it("exhausts a story after 3 attempts and carries on with stories that don't depend on it", async () => {
      const epic = linear.add({ identifier: "ENG-30", title: "Epic" });
      const x = linear.add({ identifier: "ENG-31", title: "X", parentId: epic.id, priority: 1 });
      const y = linear.add({ identifier: "ENG-32", title: "Y", parentId: epic.id, priority: 2 });
      linear.add({ identifier: "ENG-33", title: "Z", parentId: epic.id, priority: 3 });
      await linear.createBlocksRelation(x.id, y.id);
      const run = await delegate(epic.id);

      expect((await work(run.id, { jobError: "Agent crashed" })).story.identifier).toBe("ENG-31");
      const second = await work(run.id, { status: "incomplete", summary: "Half way" });
      expect(second.lastFeedback).toBe("The previous attempt failed: Agent crashed.");
      const third = await work(run.id, { status: "failed", summary: "Nope" });
      expect(third).toMatchObject({ attempt: 3 });
      expect(third.lastFeedback).toContain("reported the story incomplete");

      const [error] = linear.bodies(run.linearAgentSessionId, "error");
      expect(error).toContain("**ENG-31** did not complete after 3 attempts");
      expect(error).toContain("Stories that don't depend on it carry on.");
      // Z runs next; Y (blocked by X) never does.
      expect((await work(run.id)).story.identifier).toBe("ENG-33");
      expect(await activeJobs(run.id)).toEqual([]);
      expect(await storyStates(run.id)).toEqual([
        ["ENG-31", "exhausted", 3],
        ["ENG-32", "pending", 0],
        ["ENG-33", "completed", 1],
      ]);
      expect(linear.plan(run.linearAgentSessionId)?.map((s) => s.status)).toEqual([
        "canceled",
        "pending",
        "completed",
      ]);
      const paused = (await getRun(db, run.id))!;
      expect(paused).toMatchObject({ status: "waiting", waitingOn: { blockers: [], manual: [] } });
      const [elicitation] = linear.bodies(run.linearAgentSessionId, "elicitation");
      expect(elicitation).toContain("Paused with 1/3 stories complete");
      expect(elicitation).toContain("**ENG-31: X** didn't complete after 3 attempts");
      expect(elicitation).toContain("**ENG-32** is blocked by ENG-31");
      expect(elicitation).toContain("Reply with guidance");
      expect((await db.select().from(jobs).where(eq(jobs.ralphRunId, run.id))).length).toBe(4);
    });

    it("pauses with a readable gate failure and names the stuck story a chain waits on", async () => {
      const epic = linear.add({ identifier: "ENG-40", title: "Epic" });
      const x = linear.add({ identifier: "ENG-41", title: "X", parentId: epic.id, priority: 1 });
      const y = linear.add({ identifier: "ENG-42", title: "Y", parentId: epic.id, priority: 2 });
      const z = linear.add({ identifier: "ENG-43", title: "Z", parentId: epic.id, priority: 3 });
      await linear.createBlocksRelation(x.id, y.id);
      await linear.createBlocksRelation(y.id, z.id);
      const run = await delegate(epic.id);
      const output = Array.from({ length: 300 }, (_, i) => `\u001b[31mline ${i}\u001b[39m`);
      const feedback = [
        "The agent reported the story complete, but the quality gate `pnpm test` failed (exit 1):",
        "",
        "```",
        ...output,
        "```",
      ].join("\n");
      for (let attempt = 0; attempt < 3; attempt++) {
        await work(run.id, { status: "failed", summary: "Gate failed", feedback });
      }

      const [error] = linear.bodies(run.linearAgentSessionId, "error");
      const [elicitation] = linear.bodies(run.linearAgentSessionId, "elicitation");
      for (const body of [error!, elicitation!]) {
        expect(body).toContain(
          "The agent reported the story complete, but the quality gate `pnpm test` failed (exit 1):\n\n```\n…\n",
        );
        expect(body).toContain("line 299\n```");
        expect(body).not.toContain("\u001b");
      }
      expect(elicitation).toContain("**ENG-42** is blocked by ENG-41.");
      expect(elicitation).toContain("**ENG-43** is blocked by ENG-42, which waits on **ENG-41**.");
    });

    it("builds a single issue as one story", async () => {
      const issue = linear.add({ identifier: "ENG-80", title: "Fix the login bug" });
      const run = await delegate(issue.id);
      const payload = await work(run.id, { commitSha: sha(5) });
      expect(payload).toMatchObject({
        epic: { identifier: "ENG-80", kind: "single", prd: "" },
        story: { identifier: "ENG-80", linearIssueId: issue.id },
        commitMessage: "ENG-80: Fix the login bug",
      });
      // The issue stays open for review; no story comment.
      expect(linear.issues.get(issue.id)?.stateType).toBe("started");
      expect(linear.comments).toEqual([]);
      const described = await describePr(run.id);
      expect(described.epic).toMatchObject({ identifier: "ENG-80", title: "Fix the login bug" });
      expect(await withPullRequest(run.id)).toMatchObject({ status: "completed", prNumber: 1 });
      expect(await storyStates(run.id)).toEqual([["ENG-80", "completed", 1]]);
      expect(linear.bodies(run.linearAgentSessionId, "response")[0]).toContain(
        `Finished **ENG-80** on \`${issue.branchName}\`. Opened [Pull request #1]`,
      );
    });

    const requestResult = (overrides: Partial<RalphRequestResult> = {}): RalphRequestResult => ({
      summary: "Done as asked.",
      error: null,
      sessionId: "claude-req-1",
      usage: { inputTokens: 1, outputTokens: 1 },
      durationMs: 10,
      ...overrides,
    });

    /** Plays the run's queued request job. Returns it and its payload. */
    async function request(
      runId: string,
      outcome: Partial<RalphRequestResult> = {},
    ): Promise<{ job: Job; payload: RalphRequestPayload }> {
      const job = await activeJob(runId);
      const { claim } = await claimJob(db, {
        organizationId: orgId,
        harnessId: agentA,
        acceptedTaskTypes: ["query", "coding"],
        pools: ["short", "long"],
        harnessVersion: CODING_TASKS_MIN_HARNESS_VERSION,
        maxDeliveries: MAX_JOB_DELIVERIES,
      });
      expect(claim?.job.id).toBe(job.id);
      expect(await onRalphJobStarted(db, job, agentA)).toEqual({ skip: false });
      const result = requestResult(outcome);
      expect(await completeJob(db, { jobId: job.id, harnessId: agentA, result })).toEqual({
        status: "completed",
      });
      await expectRalphHooks(job);
      await onRalphJobFinished(db, (await getJob(db, job.id))!, deps());
      return { job, payload: RalphRequestPayload.parse(ralphJobPayload(job)) };
    }

    it("works a mention's requests lane by lane, main lane first, then completes", async () => {
      const epic = linear.add({
        identifier: "ENG-60",
        title: "Epic",
        description: EPIC_DESCRIPTION,
      });
      linear.add({ identifier: "ENG-61", title: "Story", parentId: epic.id });
      sessionSeq += 1;
      const sessionId = `session-${sessionSeq}`;
      await startRun(
        {
          kind: "session_created",
          sessionId,
          issueId: epic.id,
          commentBody: "@omniralph rename the badge",
          creatorName: "Steve",
        },
        deps(),
      );
      const run = linearRun((await getRunBySession(db, sessionId))!);
      expect(run.mode).toBe("request");
      const main = (await getMainLane(db, run))!;
      const app = await ensureLane(db, {
        runId: run.id,
        repositoryId: gitlabRepoId,
        branch: main.branch,
        baseBranch: "main",
      });
      await insertMessage(db, {
        runId: run.id,
        laneId: app.id,
        kind: "request",
        text: "fix CI",
        trigger: "pr.ci-failed",
      });

      const first = await request(run.id, {
        summary: "Renamed it.",
        pullRequest: { action: "open", title: "Rename the badge" },
      });
      expect(first.job).toMatchObject({
        type: "ralph.request",
        ...routing("builtin:handle-request"),
        repositoryId: repoId,
        targetHarnessId: null,
      });
      expect(first.payload).toMatchObject({
        repositoryId: repoId,
        branch: main.branch,
        epic: { identifier: "ENG-60", title: "Epic" },
        requests: [{ text: "rename the badge" }],
        ship: false,
      });
      const second = await request(run.id, { summary: "Fixed CI." });
      // The app lane has no harness of its own yet: any harness may take its job.
      expect(second.job).toMatchObject({
        type: "ralph.request",
        ...routing("builtin:handle-request"),
        repositoryId: gitlabRepoId,
        targetHarnessId: null,
      });
      expect(second.payload).toMatchObject({
        repositoryId: gitlabRepoId,
        baseBranch: "main",
        requests: [{ text: "fix CI" }],
      });
      if (path === "tasks") {
        // The request run's trigger is its oldest request's origin.
        expect(first.job.payload).toMatchObject({ trigger: { kind: "linear.mention" } });
        expect(second.job.payload).toMatchObject({ trigger: { kind: "pr.ci-failed" } });
      }

      expect(await activeJobs(run.id)).toEqual([]);
      expect((await getRun(db, run.id))?.status).toBe("completed");
      const [response] = linear.bodies(sessionId, "response");
      expect(response).toContain("**acme/api**: Renamed it.");
      expect(response).toContain("**group/app**: Fixed CI.");
      expect(scm.changeRequests).toEqual([
        expect.objectContaining({
          number: 1,
          title: "Rename the badge",
          sourceBranch: main.branch,
        }),
      ]);
      expect((await listLanes(db, run.id)).map((l) => l.requestClaudeSessionId)).toEqual([
        "claude-req-1",
        "claude-req-1",
      ]);
      // No story loop and no Linear state changes for a mention.
      expect(linear.comments).toEqual([]);
      expect(await storyStates(run.id)).toEqual([["ENG-61", "pending", 0]]);
    });

    it("leaves coding runs queued for harnesses older than the coding lifecycle", async () => {
      const epic = linear.add({ identifier: "ENG-67", title: "Epic" });
      linear.add({ identifier: "ENG-68", title: "Only", parentId: epic.id });
      const run = await delegate(epic.id);
      const job = await activeJob(run.id);
      expect(job).toMatchObject({ type: "ralph.story", ...routing("builtin:implement-story") });
      if (path === "tasks") {
        // 0.10.0 has no coding lifecycle: it would fail the run as an unsupported task type.
        for (const harnessVersion of [null, "0.10.0"]) {
          const { claim } = await claimJob(db, {
            organizationId: orgId,
            harnessId: agentA,
            acceptedTaskTypes: ["query", "coding"],
            pools: ["short", "long"],
            harnessVersion,
            maxDeliveries: MAX_JOB_DELIVERIES,
          });
          expect(claim).toBeNull();
        }
      }
      // A harness on the coding tasks' minimum (or later) runs it.
      await work(run.id, { commitSha: sha(67) });
      expect(await activeJob(run.id)).toMatchObject({ type: "ralph.describe-pr" });
    });

    it("runs stories with the repository's story task on the tasks path only", async () => {
      await db
        .update(repositories)
        .set({ storyTaskId: "builtin:describe-pr" })
        .where(eq(repositories.id, repoId));
      const epic = linear.add({ identifier: "ENG-65", title: "Epic" });
      linear.add({ identifier: "ENG-66", title: "Only", parentId: epic.id });
      const run = await delegate(epic.id);
      if (path === "legacy") {
        expect(await activeJob(run.id)).toMatchObject({ type: "ralph.story", taskId: null });
        return;
      }
      // Not a coding task: the run can't go on.
      expect(await activeJobs(run.id)).toEqual([]);
      expect(await getRun(db, run.id)).toMatchObject({
        status: "failed",
        error: expect.stringContaining("`builtin:describe-pr`, which isn't a coding task"),
      });
    });

    it("runs stories with the organization's custom story task on the tasks path", async () => {
      const { id: _id, name: _name, ...definition } = getBuiltinTask("builtin:implement-story")!;
      const custom = await insertTaskDefinition(db, orgId, {
        name: "Careful story",
        definition: { ...definition, promptTemplate: `Be careful.\n${definition.promptTemplate}` },
        requirements: { minHarnessVersion: CODING_TASKS_MIN_HARNESS_VERSION },
        createdBy: null,
      });
      await db
        .update(repositories)
        .set({ storyTaskId: custom.id })
        .where(eq(repositories.id, repoId));
      const epic = linear.add({ identifier: "ENG-69", title: "Epic" });
      linear.add({ identifier: "ENG-70", title: "Only", parentId: epic.id });
      const run = await delegate(epic.id);
      expect(await activeJob(run.id)).toMatchObject({ type: "ralph.story", ...routing(custom.id) });
      await work(run.id, { commitSha: sha(69) });
      expect(await activeJob(run.id)).toMatchObject({ type: "ralph.describe-pr" });
    });

    /** A one-story epic whose story is done: the run is describing its PR. */
    async function describingRun(n: number): Promise<LinearRun> {
      const epic = linear.add({
        identifier: `ENG-${n}`,
        title: "Gadgets",
        description: `${EPIC_DESCRIPTION}\n> Branch: feat/gadgets-${n}`,
      });
      linear.add({ identifier: `ENG-${n + 1}`, title: "Add gadgets", parentId: epic.id });
      const run = await delegate(epic.id);
      await work(run.id, { commitSha: sha(n) });
      const job = await activeJob(run.id);
      expect(job).toMatchObject({
        type: "ralph.describe-pr",
        taskId: path === "tasks" ? "builtin:describe-pr" : null,
      });
      expect((await getRun(db, run.id))?.prJobId).toBe(job.id);
      expect((await getMainLane(db, (await getRun(db, run.id))!))?.publish).toEqual({
        status: "describing",
        jobId: job.id,
      });
      return run;
    }

    const replyTo = (run: LinearRun, body: string) =>
      handleLinearEvent(
        { kind: "session_prompted", sessionId: run.linearAgentSessionId, body },
        { db, organizationId: orgId, workspaceId: "org-1" },
        { linear, dispatcher, adapterFor: () => scm.asAdapter() },
      );

    it("opens the PR with the describe run's title and body, the title fitted", async () => {
      const run = await describingRun(150);
      const long =
        "Add gadgets with configurable widgets, sprockets and a settings page for all of them";
      // A legacy job's title arrives fitted by the harness; a query run's is fitted by the control panel.
      await describePr(run.id, {
        title: path === "tasks" ? long : fitTitle(long),
        body: "Adds gadgets.",
      });
      expect(fitTitle(long)).toBe(
        "Add gadgets with configurable widgets, sprockets and a settings page…",
      );
      expect(scm.changeRequests).toEqual([
        expect.objectContaining({
          sourceBranch: "feat/gadgets-150",
          title: fitTitle(long),
          body: expect.stringMatching(/^Adds gadgets\.\n\n---\nLinear: /) as string,
          draft: false,
        }),
      ]);
      expect(await withPullRequest(run.id)).toMatchObject({
        status: "completed",
        prNumber: 1,
        prJobId: null,
      });
    });

    it("waits when the describe run fails or sends no title and body, and a reply retries the PR step", async () => {
      const run = await describingRun(160);
      await describePr(run.id, { jobError: "the session ran out of turns" });
      const failed = (await withPullRequest(run.id))!;
      expect(failed).toMatchObject({ status: "waiting", prJobId: null, prNumber: null });
      expect(linear.bodies(run.linearAgentSessionId, "elicitation").at(-1)).toContain(
        "Every story is done, but I couldn't open the pull request: writing its description failed: the session ran out of turns.",
      );
      expect(await activeJobs(run.id)).toEqual([]);

      await replyTo(run, "retry");
      await describePr(run.id, { invalid: true });
      expect(await withPullRequest(run.id)).toMatchObject({ status: "waiting", prNumber: null });
      expect(linear.bodies(run.linearAgentSessionId, "elicitation").at(-1)).toContain(
        "Every story is done, but I couldn't open the pull request: writing its description failed: the agent sent an invalid result.",
      );
      expect(scm.changeRequests).toEqual([]);

      await replyTo(run, "retry again");
      await describePr(run.id, { title: "Add gadgets", body: "Adds gadgets." });
      expect(await withPullRequest(run.id)).toMatchObject({
        status: "completed",
        prNumber: 1,
        error: null,
      });
      expect(scm.changeRequests.map((c) => c.title)).toEqual(["Add gadgets"]);
    });

    it("counts redeliveries as one attempt, and a job that runs out of deliveries as a failed one", async () => {
      const epic = linear.add({ identifier: "ENG-25", title: "Epic" });
      linear.add({ identifier: "ENG-26", title: "Only", parentId: epic.id });
      const run = await delegate(epic.id);

      // The agent crashes (lease lost) on every delivery: no outcome is reported.
      const job = await activeJob(run.id);
      const lapseLease = () =>
        db
          .update(jobs)
          .set({ leaseExpiresAt: new Date(0) })
          .where(eq(jobs.id, job.id));
      for (let delivery = 1; delivery <= MAX_JOB_DELIVERIES; delivery += 1) {
        await lapseLease();
        const started = await claimJob(db, {
          organizationId: orgId,
          harnessId: agentA,
          acceptedTaskTypes: ["query", "coding"],
          pools: ["short", "long"],
          harnessVersion: CODING_TASKS_MIN_HARNESS_VERSION,
          maxDeliveries: MAX_JOB_DELIVERIES,
        });
        expect(started.claim?.job.id).toBe(job.id);
        await advanceRun(run.id, deps());
        expect(await storyStates(run.id)).toEqual([["ENG-26", "running", 0]]);
        expect((await activeJob(run.id)).id).toBe(job.id);
      }
      await lapseLease();
      const gaveUp = await claimJob(db, {
        organizationId: orgId,
        harnessId: agentA,
        acceptedTaskTypes: ["query", "coding"],
        pools: ["short", "long"],
        harnessVersion: CODING_TASKS_MIN_HARNESS_VERSION,
        maxDeliveries: MAX_JOB_DELIVERIES,
      });
      expect(gaveUp).toMatchObject({
        claim: null,
        settled: [{ outcome: "failed", job: { id: job.id, status: "failed" } }],
      });
      await onRalphJobFinished(db, (await getJob(db, job.id))!, deps());

      expect(await storyStates(run.id)).toEqual([["ENG-26", "running", 1]]);
      const retry = await work(run.id, { commitSha: sha(4) });
      expect(retry).toMatchObject({
        attempt: 2,
        lastFeedback: `The previous attempt failed: Gave up after ${MAX_JOB_DELIVERIES} deliveries.`,
      });
      expect(await storyStates(run.id)).toEqual([["ENG-26", "completed", 2]]);
    });

    it("doesn't count a retried delivery (a rate limit) as an attempt", async () => {
      const epic = linear.add({ identifier: "ENG-34", title: "Epic" });
      linear.add({ identifier: "ENG-35", title: "Only", parentId: epic.id });
      const run = await delegate(epic.id);
      const job = await activeJob(run.id);
      const { claim } = await claimJob(db, {
        organizationId: orgId,
        harnessId: agentA,
        acceptedTaskTypes: ["query", "coding"],
        pools: ["short", "long"],
        harnessVersion: CODING_TASKS_MIN_HARNESS_VERSION,
        maxDeliveries: MAX_JOB_DELIVERIES,
      });
      expect(claim?.job.id).toBe(job.id);
      const failed = await failJob(db, {
        jobId: job.id,
        harnessId: agentA,
        retryable: true,
        error: "Claude rate limit",
        maxDeliveries: MAX_JOB_DELIVERIES,
      });
      expect(failed).toEqual({ status: "retry" });
      await advanceRun(run.id, deps());
      expect(await storyStates(run.id)).toEqual([["ENG-35", "running", 0]]);
      expect((await activeJob(run.id)).id).toBe(job.id);

      const redelivered = await work(run.id, { commitSha: sha(6) });
      expect(redelivered).toMatchObject({ attempt: 1, lastFeedback: null });
      expect(await storyStates(run.id)).toEqual([["ENG-35", "completed", 1]]);
    });

    it("stops enqueueing at the per-run iteration cap", async () => {
      const run = await unblockedWaitingRun();
      await updateRun(db, run.id, { iterations: MAX_ITERATIONS_PER_RUN });
      expect(await advanceRun(run.id, deps())).toMatchObject({ action: "waiting" });
      expect(await activeJobs(run.id)).toEqual([]);
      expect(linear.bodies(run.linearAgentSessionId, "elicitation").at(-1)).toContain(
        `I reached the per-run iteration cap (${MAX_ITERATIONS_PER_RUN} story attempts).`,
      );
    });
  });

  describe("push and draft PR timing on the tasks path", () => {
    const setEarly = (openPullRequestEarly: boolean) =>
      updateRepositoryRalphSettings(db, repoId, {
        ralphEnabled: true,
        linearTeamKeys: ["ENG"],
        linearProjectNames: [],
        linearLabels: [],
        ralphSettings: {
          ...DEFAULT_RALPH_SETTINGS,
          setupCommand: "pnpm install",
          openPullRequestEarly,
        },
      });

    beforeEach(async () => {
      await db.update(repositories).set({ codingPath: "tasks" });
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      changedBuiltins.clear();
      await db
        .update(repositories)
        .set({ codingPath: "legacy", storyTaskId: "builtin:implement-story" });
      await setEarly(false);
    });

    /** `builtin:implement-story` with `settings` (the built-in definitions are read through `getBuiltinTask`). */
    function storyTaskWith(settings: Partial<TaskDefinition>): void {
      changedBuiltins.delete("builtin:implement-story");
      const builtin = getBuiltinTask("builtin:implement-story")!;
      changedBuiltins.set(builtin.id, { ...builtin, ...settings });
    }

    /**
     * Plays the agent's part for the run's queued push run: the branch pushed
     * at `sha`, or a failure. Returns its trigger context.
     */
    async function push(
      runId: string,
      outcome: { sha: string } | { jobError: string },
    ): Promise<RalphPushPayload> {
      const job = await activeJob(runId);
      expect(job).toMatchObject({
        type: "ralph.push",
        taskType: "coding",
        pool: "long",
        taskId: "builtin:implement-story",
      });
      const payload = RalphPushPayload.parse(ralphJobPayload(job));
      const { claim } = await claimJob(db, {
        organizationId: orgId,
        harnessId: agentA,
        acceptedTaskTypes: ["query", "coding"],
        pools: ["short", "long"],
        harnessVersion: CODING_TASKS_MIN_HARNESS_VERSION,
        maxDeliveries: MAX_JOB_DELIVERIES,
      });
      expect(claim?.job.id).toBe(job.id);
      expect(await onRalphJobStarted(db, job, agentA)).toEqual({ skip: false });
      if ("jobError" in outcome) {
        await failJob(db, {
          jobId: job.id,
          harnessId: agentA,
          retryable: false,
          error: outcome.jobError,
          maxDeliveries: MAX_JOB_DELIVERIES,
        });
      } else {
        const result: RalphPushResult = {
          pushed: { branch: payload.branch, sha: outcome.sha },
          durationMs: 10,
        };
        expect(
          (await taskSink(job, organizationDefinitions(db, job.organizationId)))?.parseResult?.(
            result,
          ),
        ).toEqual(result);
        await completeJob(db, { jobId: job.id, harnessId: agentA, result });
      }
      await expectRalphHooks(job);
      await onRalphJobFinished(db, (await getJob(db, job.id))!, deps());
      return payload;
    }

    /** The run's recorded hidden refs: ref, SHA, deleted. */
    const recordedHiddenRefs = async (runId: string) =>
      (await db.select().from(hiddenRefs).where(eq(hiddenRefs.runId, runId))).map((r) => ({
        repositoryId: r.repositoryId,
        ref: r.ref,
        sha: r.sha,
        deleted: r.deletedAt !== null,
      }));

    /**
     * Plays a harness's part for the queued deletion of the run's hidden refs
     * (a `worktree.cleanup` RPC with only `hiddenRefs`, on any harness): claimed
     * by `agentB`, which never held the run, and reporting `deletedRefs`.
     */
    async function deleteHiddenRefs(runId: string, deletedRefs: string[]): Promise<Job> {
      const job = await activeJob(runId);
      expect(job).toMatchObject({
        type: "worktree.cleanup",
        taskType: "system",
        pool: null,
        targetHarnessId: null,
        repositoryId: repoId,
      });
      const payload = WorktreeCleanupPayload.parse(job.payload);
      expect(payload.action).toBeUndefined();
      const { claim } = await claimJob(db, {
        organizationId: orgId,
        harnessId: agentB,
        acceptedTaskTypes: ["query", "coding"],
        pools: ["short", "long"],
        harnessVersion: CODING_TASKS_MIN_HARNESS_VERSION,
        maxDeliveries: MAX_JOB_DELIVERIES,
      });
      expect(claim?.job.id).toBe(job.id);
      const result: WorktreeCleanupResult = {
        error: null,
        removedWorktree: false,
        hadBranch: false,
        stashed: null,
        unmerged: 0,
        stashes: [],
        handled: 0,
        deletedRefs,
        durationMs: 10,
      };
      await completeJob(db, { jobId: job.id, harnessId: agentB, result });
      await onRalphCleanupJobFinished(db, (await getJob(db, job.id))!, deps());
      return job;
    }

    /** Story results of a run pushing only at the end: the commit is on the hidden ref. */
    const onHiddenRef = (runId: string, commit: string) => ({
      commitSha: commit,
      hiddenRef: { ref: ralphHiddenRef(runId), sha: commit },
    });

    it("ticks the stories in the lane's open pull request all at once, after the push", async () => {
      storyTaskWith({ pushTiming: "end" });
      const epic = linear.add({
        identifier: "ENG-175",
        title: "Sprockets",
        description: `${EPIC_DESCRIPTION}\n> Branch: feat/sprockets`,
      });
      linear.add({ identifier: "ENG-176", title: "First", parentId: epic.id, priority: 1 });
      linear.add({ identifier: "ENG-177", title: "Second", parentId: epic.id, priority: 2 });
      const run = await delegate(epic.id);
      // A pull request a previous run opened for the branch, still on the lane.
      const body = "Sprockets.\n\n- [ ] ENG-176: First\n- [ ] ENG-177: Second";
      scm.changeRequests.push({
        number: 9,
        url: "https://github.com/acme/api/pull/9",
        fullPath: "acme/api",
        sourceBranch: "feat/sprockets",
        targetBranch: "develop",
        title: "Sprockets",
        body,
        draft: true,
        state: "open",
      });
      const lane = (await getMainLane(db, (await getRun(db, run.id))!))!;
      await updateLane(db, lane.id, { prNumber: 9, prUrl: "https://github.com/acme/api/pull/9" });

      // The first story's commit is only on the hidden ref: nothing is ticked.
      await work(run.id, onHiddenRef(run.id, sha(176)));
      expect(scm.changeRequests[0]!.body).toBe(body);
      expect(scm.calls).not.toContain("getChangeRequest");
      await work(run.id, onHiddenRef(run.id, sha(177)));
      expect(scm.changeRequests[0]!.body).toBe(body);

      await push(run.id, { sha: sha(177) });
      expect(scm.changeRequests[0]!.body).toBe(
        "Sprockets.\n\n- [x] ENG-176: First\n- [x] ENG-177: Second",
      );
      expect((await activeJob(run.id)).type).toBe("ralph.describe-pr");
    });

    it("pushes the branch once, after the last story and before describing, and opens no early draft", async () => {
      storyTaskWith({ pushTiming: "end" });
      // The repository asks for early drafts, but there is no branch until the end.
      await setEarly(true);
      const epic = linear.add({
        identifier: "ENG-170",
        title: "Widgets",
        description: `${EPIC_DESCRIPTION}\n> Branch: feat/widgets`,
      });
      linear.add({ identifier: "ENG-171", title: "First", parentId: epic.id, priority: 1 });
      linear.add({ identifier: "ENG-172", title: "Second", parentId: epic.id, priority: 2 });
      const run = await delegate(epic.id);

      await work(run.id, onHiddenRef(run.id, sha(171)));
      expect((await activeJob(run.id)).type).toBe("ralph.story");
      expect(scm.changeRequests).toEqual([]);
      await work(run.id, onHiddenRef(run.id, sha(172)));

      // Every story is done: a push run with no session, on the sticky agent, before the describe job.
      const pushJob = await activeJob(run.id);
      expect(pushJob).toMatchObject({
        targetHarnessId: agentA,
        ralphRunId: run.id,
        repositoryId: repoId,
        dedupeKey: runDedupeKey(run.id),
      });
      expect(pushJob.payload).toMatchObject({
        trigger: { kind: "linear.delegated", context: { hiddenRef: ralphHiddenRef(run.id) } },
      });
      expect((await getRun(db, run.id))?.prJobId).toBe(pushJob.id);
      expect((await getMainLane(db, (await getRun(db, run.id))!))?.publish).toEqual({
        status: "pushing",
        jobId: pushJob.id,
      });
      expect(linear.bodies(run.linearAgentSessionId, "thought")).toContain(
        "All 2 stories are done. Pushing `feat/widgets`.",
      );
      const pushed = await push(run.id, { sha: sha(172) });
      expect(pushed).toMatchObject({
        runId: run.id,
        repositoryId: repoId,
        repository: { fullPath: "acme/api" },
        branch: "feat/widgets",
        baseBranch: "develop",
        settings: { setupCommand: "pnpm install" },
        hiddenRef: ralphHiddenRef(run.id),
      });

      const describeJob = await activeJob(run.id);
      expect(describeJob).toMatchObject({
        type: "ralph.describe-pr",
        taskId: "builtin:describe-pr",
        targetHarnessId: agentA,
      });
      expect((await getMainLane(db, (await getRun(db, run.id))!))?.publish).toEqual({
        status: "describing",
        jobId: describeJob.id,
      });
      expect(scm.calls).not.toContain("createChangeRequest");
      await describePr(run.id, { title: "Add widgets", body: "Adds widgets." });
      expect(scm.changeRequests).toEqual([
        expect.objectContaining({
          sourceBranch: "feat/widgets",
          title: "Add widgets",
          draft: false,
        }),
      ]);
      expect(await withPullRequest(run.id)).toMatchObject({
        status: "completed",
        prNumber: 1,
        prJobId: null,
      });

      // The stories' hidden ref was recorded (at the last story's commit) and, the run being
      // over, is deleted on origin by any harness.
      const ref = ralphHiddenRef(run.id);
      expect(await recordedHiddenRefs(run.id)).toEqual([
        { repositoryId: repoId, ref, sha: sha(172), deleted: false },
      ]);
      const deletion = await deleteHiddenRefs(run.id, [ref]);
      expect(WorktreeCleanupPayload.parse(deletion.payload)).toMatchObject({
        runId: run.id,
        repositoryId: repoId,
        branch: "feat/widgets",
        hiddenRefs: [ref],
      });
      expect(await recordedHiddenRefs(run.id)).toEqual([
        { repositoryId: repoId, ref, sha: sha(172), deleted: true },
      ]);
      expect(await db.select().from(jobs).where(eq(jobs.ralphRunId, run.id))).toHaveLength(5);
      expect(await activeJobs(run.id)).toEqual([]);
      expect(await getRun(db, run.id)).toMatchObject({ status: "completed" });
    });

    it("deletes the hidden ref of a run that failed, and keeps one the result doesn't report", async () => {
      storyTaskWith({ pushTiming: "end" });
      const epic = linear.add({
        identifier: "ENG-180",
        title: "Gears",
        description: `${EPIC_DESCRIPTION}\n> Branch: feat/gears`,
      });
      linear.add({ identifier: "ENG-181", title: "First", parentId: epic.id, priority: 1 });
      linear.add({ identifier: "ENG-182", title: "Second", parentId: epic.id, priority: 2 });
      const run = await delegate(epic.id);
      // The next story can't be enqueued: the repository's story task isn't a coding task.
      await db.update(repositories).set({ storyTaskId: "builtin:describe-pr" });
      await work(run.id, onHiddenRef(run.id, sha(181)));
      expect(await getRun(db, run.id)).toMatchObject({ status: "failed" });

      const ref = ralphHiddenRef(run.id);
      expect(await recordedHiddenRefs(run.id)).toEqual([
        { repositoryId: repoId, ref, sha: sha(181), deleted: false },
      ]);
      await deleteHiddenRefs(run.id, []);
      expect(await recordedHiddenRefs(run.id)).toEqual([
        { repositoryId: repoId, ref, sha: sha(181), deleted: false },
      ]);
    });

    it("keeps the hidden ref of a waiting or stopped run", async () => {
      storyTaskWith({ pushTiming: "end" });
      const epic = linear.add({
        identifier: "ENG-185",
        title: "Cogs",
        description: `${EPIC_DESCRIPTION}\n> Branch: feat/cogs`,
      });
      linear.add({ identifier: "ENG-186", title: "Only", parentId: epic.id });
      const run = await delegate(epic.id);
      await work(run.id, onHiddenRef(run.id, sha(186)));
      await push(run.id, { jobError: "the remote rejected the push" });
      expect(await getRun(db, run.id)).toMatchObject({ status: "waiting" });
      expect(await activeJobs(run.id)).toEqual([]);
      expect(await recordedHiddenRefs(run.id)).toEqual([
        { repositoryId: repoId, ref: ralphHiddenRef(run.id), sha: sha(186), deleted: false },
      ]);
    });

    it("waits when the push fails, and a reply retries it", async () => {
      storyTaskWith({ pushTiming: "end" });
      const epic = linear.add({
        identifier: "ENG-175",
        title: "Sprockets",
        description: `${EPIC_DESCRIPTION}\n> Branch: feat/sprockets`,
      });
      linear.add({ identifier: "ENG-176", title: "Only", parentId: epic.id });
      const run = await delegate(epic.id);
      await work(run.id, onHiddenRef(run.id, sha(176)));
      await push(run.id, { jobError: "the remote rejected the push: protected branch" });

      expect(await withPullRequest(run.id)).toMatchObject({
        status: "waiting",
        prJobId: null,
        prNumber: null,
      });
      expect(linear.bodies(run.linearAgentSessionId, "elicitation").at(-1)).toContain(
        "Every story is done, but I couldn't push `feat/sprockets`: the remote rejected the push: protected branch.",
      );
      expect(await activeJobs(run.id)).toEqual([]);

      await handleLinearEvent(
        { kind: "session_prompted", sessionId: run.linearAgentSessionId, body: "retry" },
        { db, organizationId: orgId, workspaceId: "org-1" },
        { linear, dispatcher, adapterFor: () => scm.asAdapter() },
      );
      await push(run.id, { sha: sha(176) });
      await describePr(run.id);
      expect(await withPullRequest(run.id)).toMatchObject({ status: "completed", prNumber: 1 });
    });

    it("starts request runs from the run's hidden ref when pushing only at the end", async () => {
      const mention = async (identifier: string) => {
        const epic = linear.add({ identifier, title: "Epic" });
        sessionSeq += 1;
        const sessionId = `session-${sessionSeq}`;
        await startRun(
          {
            kind: "session_created",
            sessionId,
            issueId: epic.id,
            commentBody: "@omniralph rename the badge",
            creatorName: "Steve",
          },
          deps(),
        );
        const run = (await getRunBySession(db, sessionId))!;
        const job = await activeJob(run.id);
        expect(job.type).toBe("ralph.request");
        return { run, payload: RalphRequestPayload.parse(ralphJobPayload(job)) };
      };
      const perStory = await mention("ENG-180");
      expect(perStory.payload.hiddenRef).toBeUndefined();
      storyTaskWith({ pushTiming: "end" });
      const atTheEnd = await mention("ENG-181");
      expect(atTheEnd.payload.hiddenRef).toBe(ralphHiddenRef(atTheEnd.run.id));
    });

    it.each([
      { draftPullRequest: "early", openPullRequestEarly: false, draft: true },
      { draftPullRequest: "end", openPullRequestEarly: true, draft: false },
      { draftPullRequest: undefined, openPullRequestEarly: true, draft: true },
    ] as const)(
      "with draftPullRequest $draftPullRequest and openPullRequestEarly $openPullRequestEarly, opens an early draft: $draft",
      async ({ draftPullRequest, openPullRequestEarly, draft }) => {
        if (draftPullRequest) storyTaskWith({ draftPullRequest });
        await setEarly(openPullRequestEarly);
        const n = 190 + (draftPullRequest === "early" ? 0 : draftPullRequest === "end" ? 3 : 6);
        const epic = linear.add({ identifier: `ENG-${n}`, title: "Gizmos" });
        linear.add({ identifier: `ENG-${n + 1}`, title: "First", parentId: epic.id, priority: 1 });
        linear.add({ identifier: `ENG-${n + 2}`, title: "Second", parentId: epic.id, priority: 2 });
        const run = await delegate(epic.id);

        await work(run.id, { commitSha: sha(n) });
        expect((await activeJob(run.id)).type).toBe("ralph.story");
        expect(scm.changeRequests).toEqual(
          draft ? [expect.objectContaining({ number: 1, draft: true })] : [],
        );
        await work(run.id, { commitSha: sha(n + 1) });
        // Pushed after each story: no push run, the describe job comes next.
        await describePr(run.id);
        expect(scm.changeRequests).toEqual([expect.objectContaining({ number: 1, draft: false })]);
        expect(await withPullRequest(run.id)).toMatchObject({ status: "completed" });
      },
    );

    it("takes the round cap from the story task: a story without a metric runs until it", async () => {
      storyTaskWith({ maxRoundsPerStory: 2 });
      const epic = linear.add({ identifier: "ENG-310", title: "Epic" });
      linear.add({ identifier: "ENG-311", title: "Validate", parentId: epic.id });
      const run = await delegate(epic.id);

      expect((await work(run.id, reviewRound(1))).story.identifier).toBe("ENG-311");
      expect(await storyRounds(run.id, "ENG-311")).toEqual({
        status: "pending",
        attempts: 0,
        rounds: 1,
      });
      expect((await work(run.id)).story.title).toBe("Fix round 1");
      expect((await work(run.id, reviewRound(2))).story).toMatchObject({ identifier: "ENG-311" });
      expect(await storyRounds(run.id, "ENG-311")).toEqual({
        status: "exhausted",
        attempts: 0,
        rounds: 2,
      });
      const [error] = linear.bodies(run.linearAgentSessionId, "error");
      expect(error).toContain("**ENG-311** reached its round cap (2 rounds) without completing");
      expect(error).not.toContain("Trend:");
      // Its follow-up still gets done.
      expect((await work(run.id)).story.title).toBe("Fix round 2");
    });

    it("takes the attempt and iteration limits from the story task", async () => {
      storyTaskWith({ maxAttemptsPerStory: 2, maxIterationsPerRun: 3 });
      const epic = linear.add({ identifier: "ENG-80", title: "Epic" });
      linear.add({ identifier: "ENG-81", title: "X", parentId: epic.id, priority: 1 });
      linear.add({ identifier: "ENG-82", title: "Y", parentId: epic.id, priority: 2 });
      const run = await delegate(epic.id);

      expect((await work(run.id, { jobError: "Agent crashed" })).story.identifier).toBe("ENG-81");
      const second = await work(run.id, { status: "failed", summary: "Nope" });
      expect(second).toMatchObject({ attempt: 2, story: { identifier: "ENG-81" } });
      expect(linear.bodies(run.linearAgentSessionId, "error")[0]).toContain(
        "**ENG-81** did not complete after 2 attempts",
      );
      expect(await storyStates(run.id)).toEqual([
        ["ENG-81", "exhausted", 2],
        ["ENG-82", "running", 0],
      ]);

      // One more story attempt reaches the task's iteration cap of 3.
      expect((await work(run.id, { jobError: "Agent crashed" })).story.identifier).toBe("ENG-82");
      expect(await activeJobs(run.id)).toEqual([]);
      expect((await getRun(db, run.id))?.status).toBe("waiting");
      expect(linear.bodies(run.linearAgentSessionId, "elicitation").at(-1)).toContain(
        "I reached the per-run iteration cap (3 story attempts).",
      );
    });
  });

  it("goes back to the organization's ralph agents when the sticky agent was revoked before the next job", async () => {
    const epic = linear.add({ identifier: "ENG-15", title: "Epic" });
    linear.add({ identifier: "ENG-16", title: "One", parentId: epic.id, subIssueSortOrder: 0 });
    linear.add({ identifier: "ENG-17", title: "Two", parentId: epic.id, subIssueSortOrder: 1 });
    const run = await delegate(epic.id);
    const job = await activeJob(run.id);
    const { claim } = await claimJob(db, {
      organizationId: orgId,
      harnessId: agentA,
      acceptedTaskTypes: ["query", "coding"],
      pools: ["short", "long"],
      harnessVersion: CODING_TASKS_MIN_HARNESS_VERSION,
      maxDeliveries: MAX_JOB_DELIVERIES,
    });
    expect(claim?.job.id).toBe(job.id);
    await onRalphJobStarted(db, job, agentA);
    await completeJob(db, { jobId: job.id, harnessId: agentA, result: result() });
    await db.update(harnesses).set({ revokedAt: new Date() }).where(eq(harnesses.id, agentA));
    await onRalphJobFinished(db, (await getJob(db, job.id))!, deps());
    expect((await activeJob(run.id)).targetHarnessId).toBeNull();
  });

  it("sticks to an agent inheriting coding tasks until the organization's default turns them off", async () => {
    await db.update(harnesses).set({ acceptedTaskTypes: null }).where(eq(harnesses.id, agentA));
    const epic = linear.add({ identifier: "ENG-38", title: "Epic" });
    linear.add({ identifier: "ENG-39", title: "One", parentId: epic.id, subIssueSortOrder: 0 });
    linear.add({ identifier: "ENG-40", title: "Two", parentId: epic.id, subIssueSortOrder: 1 });
    linear.add({ identifier: "ENG-41", title: "Three", parentId: epic.id, subIssueSortOrder: 2 });
    const run = await delegate(epic.id);
    const finishOnA = async () => {
      const job = await activeJob(run.id);
      await db.update(jobs).set({ targetHarnessId: agentA }).where(eq(jobs.id, job.id));
      const { claim } = await claimJob(db, {
        organizationId: orgId,
        harnessId: agentA,
        acceptedTaskTypes: ["query", "coding"],
        pools: ["short", "long"],
        harnessVersion: CODING_TASKS_MIN_HARNESS_VERSION,
        maxDeliveries: MAX_JOB_DELIVERIES,
      });
      expect(claim?.job.id).toBe(job.id);
      await onRalphJobStarted(db, job, agentA);
      await completeJob(db, { jobId: job.id, harnessId: agentA, result: result() });
      await onRalphJobFinished(db, (await getJob(db, job.id))!, deps());
    };
    try {
      await finishOnA();
      expect((await activeJob(run.id)).targetHarnessId).toBe(agentA);
      await setAllowedTaskTypeDefaults(db, orgId, ["query", "review"], null);
      await finishOnA();
      expect((await activeJob(run.id)).targetHarnessId).toBeNull();
    } finally {
      await setAllowedTaskTypeDefaults(db, orgId, null, null);
    }
  });

  it("never sticks to an agent of another organization", async () => {
    const [other] = await db.insert(organizations).values({ name: "Globex" }).returning();
    const [foreign] = await db
      .insert(harnesses)
      .values({ organizationId: other!.id, name: "globex-1", acceptedTaskTypes: ["coding"] })
      .returning();
    const epic = linear.add({ identifier: "ENG-18", title: "Epic" });
    linear.add({ identifier: "ENG-19", title: "One", parentId: epic.id, subIssueSortOrder: 0 });
    linear.add({ identifier: "ENG-29", title: "Two", parentId: epic.id, subIssueSortOrder: 1 });
    const run = await delegate(epic.id);
    const job = await activeJob(run.id);
    const { claim } = await claimJob(db, {
      organizationId: orgId,
      harnessId: agentA,
      acceptedTaskTypes: ["query", "coding"],
      pools: ["short", "long"],
      harnessVersion: CODING_TASKS_MIN_HARNESS_VERSION,
      maxDeliveries: MAX_JOB_DELIVERIES,
    });
    expect(claim?.job.id).toBe(job.id);
    await onRalphJobStarted(db, job, agentA);
    await completeJob(db, { jobId: job.id, harnessId: agentA, result: result() });
    await db.update(ralphLanes).set({ harnessId: foreign!.id }).where(eq(ralphLanes.runId, run.id));
    await onRalphJobFinished(db, (await getJob(db, job.id))!, deps());
    expect((await activeJob(run.id)).targetHarnessId).toBeNull();
  });

  it("runs a delegated sub-issue's story first, then the rest of the epic", async () => {
    const epic = linear.add({ identifier: "ENG-27", title: "Epic" });
    linear.add({ identifier: "ENG-28", title: "Urgent", parentId: epic.id, priority: 1 });
    const focus = linear.add({ identifier: "ENG-29", title: "Asked for", parentId: epic.id });
    const run = await delegate(focus.id);
    expect(run).toMatchObject({ linearIdentifier: "ENG-27", focusStoryId: focus.id });
    expect((await work(run.id)).story.identifier).toBe("ENG-29");
    expect((await work(run.id)).story.identifier).toBe("ENG-28");
    expect((await getRun(db, run.id))?.status).toBe("completed");
  });

  it("waits while the epic itself is blocked and resumes from the Issue webhook", async () => {
    const outside = linear.add({
      identifier: "OPS-2",
      title: "Approve the budget",
      teamKey: "OPS",
    });
    const epic = linear.add({ identifier: "ENG-36", title: "Epic" });
    linear.add({ identifier: "ENG-37", title: "Only", parentId: epic.id });
    await linear.createBlocksRelation(outside.id, epic.id);
    const run = await delegate(epic.id);
    expect(await activeJobs(run.id)).toEqual([]);
    expect(await getRun(db, run.id)).toMatchObject({
      status: "waiting",
      waitingOn: { blockers: [expect.objectContaining({ identifier: "OPS-2" })], manual: [] },
    });

    await linear.setIssueState(outside.id, { type: "completed" });
    await handleLinearEvent(
      { kind: "issue_state", issueId: outside.id, removed: false },
      { db, organizationId: orgId, workspaceId: "org-1" },
      { linear, dispatcher },
    );
    expect((await work(run.id)).story.identifier).toBe("ENG-37");
    expect((await getRun(db, run.id))?.status).toBe("completed");
  });

  it("sets a blocked story aside without retrying and carries on with the others", async () => {
    const epic = linear.add({ identifier: "ENG-40", title: "Epic" });
    linear.add({ identifier: "ENG-41", title: "Needs a key", parentId: epic.id, priority: 1 });
    linear.add({ identifier: "ENG-42", title: "Other", parentId: epic.id, priority: 2 });
    const run = await delegate(epic.id);
    await work(run.id, {
      status: "blocked",
      summary: "I need an API key for the payment sandbox.",
    });
    expect(await storyStates(run.id)).toEqual([
      ["ENG-41", "exhausted", 3],
      ["ENG-42", "running", 0],
    ]);
    const [thought] = linear
      .bodies(run.linearAgentSessionId, "thought")
      .filter((b) => b.includes("is blocked"));
    expect(thought).toContain("**ENG-41** is blocked, so I'm setting it aside without retrying.");
    expect(thought).toContain("I need an API key for the payment sandbox.");
    expect(thought).not.toContain("committed as");
    const stories = await listStories(db, run.id);
    expect(stories.find((s) => s.identifier === "ENG-41")?.commitSha).toBeNull();

    await work(run.id, { commitSha: sha(5) });
    expect((await getRun(db, run.id))?.status).toBe("waiting");
    const [elicitation] = linear.bodies(run.linearAgentSessionId, "elicitation");
    expect(elicitation).toContain("**ENG-41: Needs a key** is blocked:");
    expect(elicitation).toContain("I need an API key for the payment sandbox.");
  });

  it("records a blocked story's wip commit and logs it, still setting the story aside", async () => {
    const epic = linear.add({ identifier: "ENG-45", title: "Epic" });
    linear.add({ identifier: "ENG-46", title: "Needs a key", parentId: epic.id, priority: 1 });
    linear.add({ identifier: "ENG-47", title: "Other", parentId: epic.id, priority: 2 });
    const run = await delegate(epic.id);
    await work(run.id, {
      status: "blocked",
      summary: "I need an API key.",
      commitSha: sha(9),
      feedback:
        "The previous session reported it was blocked. Its summary was:\n\n> I need an API key.",
    });
    expect(await storyStates(run.id)).toEqual([
      ["ENG-46", "exhausted", 3],
      ["ENG-47", "running", 0],
    ]);
    const blocked = (await listStories(db, run.id)).find((s) => s.identifier === "ENG-46")!;
    expect(blocked.commitSha).toBe(sha(9));
    const progress = (await getRun(db, run.id))!.progress;
    expect(progress).toContain("ENG-46: Needs a key (blocked)");
    expect(progress).toContain(`committed as \`wip(ENG-46)\` in \`${sha(9).slice(0, 10)}\``);
    expect(progress).toContain("I need an API key.");
    const [thought] = linear
      .bodies(run.linearAgentSessionId, "thought")
      .filter((b) => b.includes("is blocked"));
    expect(thought).toContain(`Its work so far is committed as \`${sha(9).slice(0, 10)}\`.`);
    // The other story's payload carries the log with the wip entry.
    const other = RalphStoryPayload.parse((await activeJob(run.id)).payload);
    expect(other.progress).toContain("ENG-46: Needs a key (blocked)");
    // Not a Linear completion: the story stays open.
    const comments = linear.comments.filter((c) => c.issueId === blocked.linearIssueId);
    expect(comments.map((c) => c.body).join("\n")).not.toContain("Completed by");
  });

  it("files follow-ups as sub-issues; an unfinished story's follow-ups block it", async () => {
    const epic = linear.add({ identifier: "ENG-50", title: "Epic", projectName: "Platform" });
    const first = linear.add({
      identifier: "ENG-51",
      title: "First",
      parentId: epic.id,
      priority: 1,
    });
    const second = linear.add({
      identifier: "ENG-52",
      title: "Second",
      parentId: epic.id,
      priority: 2,
    });
    const run = await delegate(epic.id);

    await work(run.id, {
      followUps: [{ title: "Add an index", description: "Queries are slow.", manual: false }],
    });
    const index = [...linear.issues.values()].find((i) => i.title === "Add an index")!;
    expect(index).toMatchObject({
      parentId: epic.id,
      priority: 1,
      projectName: "Platform",
      labels: [],
    });
    expect(index.description).toContain(`${FOLLOW_UP_MARK} ENG-51.`);
    expect(linear.blocks.get(first.id)).toBeUndefined();
    expect(linear.bodies(run.linearAgentSessionId, "thought").join("\n")).toContain(
      `Filed **${index.identifier}** as a new story of **ENG-50**.`,
    );

    // The follow-up (priority 1) joins the run and goes before Second.
    expect((await work(run.id)).story.identifier).toBe(index.identifier);
    const unfinished = await work(run.id, {
      status: "incomplete",
      summary: "Needs database access first.",
      followUps: [{ title: "Grant database access", description: "Grant the role.", manual: true }],
    });
    expect(unfinished.story.identifier).toBe("ENG-52");
    const grant = [...linear.issues.values()].find((i) => i.title === "Grant database access")!;
    expect(grant.labels).toEqual(["manual"]);
    expect(linear.blocks.get(second.id)).toEqual([grant.id]);
    expect(linear.bodies(run.linearAgentSessionId, "thought").join("\n")).toContain(
      `blocking **ENG-52**`,
    );

    // Second now waits for the manual follow-up.
    expect(await activeJobs(run.id)).toEqual([]);
    const waiting = (await getRun(db, run.id))!;
    expect(waiting).toMatchObject({
      status: "waiting",
      waitingOn: {
        blockers: [],
        manual: [{ id: grant.id, identifier: grant.identifier, title: "Grant database access" }],
      },
    });
    expect(await storyStates(run.id)).toContainEqual([grant.identifier, "manual", 0]);
  });

  it("keeps recommendations on the story without filing them or holding it up", async () => {
    const epic = linear.add({ identifier: "ENG-55", title: "Epic" });
    linear.add({ identifier: "ENG-56", title: "First", parentId: epic.id, priority: 1 });
    linear.add({ identifier: "ENG-57", title: "Second", parentId: epic.id, priority: 2 });
    const run = await delegate(epic.id);
    const issues = linear.issues.size;

    await work(run.id, {
      recommendations: [
        { title: "Fix the parser upstream", description: "In acme/lib: drop our shim." },
      ],
    });
    expect(linear.issues.size).toBe(issues);
    const first = (await listStories(db, run.id)).find((s) => s.identifier === "ENG-56")!;
    expect(first.status).toBe("completed");
    expect(first.recommendations).toEqual([
      {
        title: "Fix the parser upstream",
        description: "In acme/lib: drop our shim.",
        at: expect.any(String),
      },
    ]);
  });

  it("makes a completed story's follow-ups block the stories it blocks", async () => {
    const epic = linear.add({ identifier: "ENG-55", title: "Epic" });
    const first = linear.add({ identifier: "ENG-56", title: "First", parentId: epic.id });
    const validate = linear.add({
      identifier: "ENG-57",
      title: "Validate the epic",
      parentId: epic.id,
      priority: 1,
    });
    await linear.createBlocksRelation(first.id, validate.id);
    const run = await delegate(epic.id);

    await work(run.id, {
      followUps: [{ title: "Add an index", description: "Queries are slow.", manual: false }],
    });
    const index = [...linear.issues.values()].find((i) => i.title === "Add an index")!;
    expect(linear.blocks.get(first.id)).toBeUndefined();
    expect(linear.blocks.get(validate.id)).toEqual([first.id, index.id]);
    expect(linear.bodies(run.linearAgentSessionId, "thought").join("\n")).toContain(
      `Filed **${index.identifier}** as a new story of **ENG-55**, blocking **ENG-57**.`,
    );

    // Validation (priority 1) waits for the follow-up.
    expect((await work(run.id)).story.identifier).toBe(index.identifier);
    expect((await work(run.id)).story.identifier).toBe("ENG-57");
    expect(await getRun(db, run.id)).toMatchObject({ status: "completed" });
  });

  it("counts a blocked result with follow-ups as a round, not an attempt, until its metric stalls", async () => {
    const epic = linear.add({ identifier: "ENG-300", title: "Epic" });
    linear.add({ identifier: "ENG-301", title: "Validate", parentId: epic.id });
    const run = await delegate(epic.id);

    for (const n of [1, 2]) {
      const payload = await work(run.id, reviewRound(n, 20));
      expect(payload).toMatchObject({ attempt: 1, story: { identifier: "ENG-301" } });
      expect(await storyRounds(run.id, "ENG-301")).toEqual({
        status: "pending",
        attempts: 0,
        rounds: n,
      });
      expect(linear.bodies(run.linearAgentSessionId, "thought").join("\n")).toContain(
        `**ENG-301** round ${n}/8 filed follow-ups; it runs again once they're done.`,
      );
      // The follow-up blocks the story: it runs first.
      expect((await work(run.id)).story.title).toBe(`Fix round ${n}`);
    }
    // The third round without a better score sets it aside.
    expect((await work(run.id, reviewRound(3, 20))).attempt).toBe(1);
    expect(await storyRounds(run.id, "ENG-301")).toEqual({
      status: "exhausted",
      attempts: 0,
      rounds: 3,
    });
    const [error] = linear.bodies(run.linearAgentSessionId, "error");
    expect(error).toContain(
      "**ENG-301**'s critique score hasn't beaten its best (20) in 3 rounds, so I'm setting it aside after round 3.",
    );
    expect(error).toContain("Trend: critique score (higher is better): 20 → 20 → 20");
    const story = (await listStories(db, run.id)).find((s) => s.identifier === "ENG-301")!;
    expect(story.roundMetrics).toMatchObject({
      name: "critique score",
      direction: "higher",
      values: [
        { round: 1, value: 20 },
        { round: 2, value: 20 },
        { round: 3, value: 20 },
      ],
    });
    expect((await work(run.id)).story.title).toBe("Fix round 3");
    expect(await getRun(db, run.id)).toMatchObject({ status: "waiting" });

    // `/continue` gives it fresh rounds and clears its metric history.
    await handleLinearEvent(
      { kind: "session_prompted", sessionId: run.linearAgentSessionId, body: "/continue" },
      { db, organizationId: orgId, workspaceId: "org-1" },
      { linear, dispatcher, adapterFor: () => scm.asAdapter() },
    );
    const resumed = (await listStories(db, run.id)).find((s) => s.identifier === "ENG-301")!;
    expect(resumed).toMatchObject({
      status: "running",
      attempts: 0,
      rounds: 0,
      roundMetrics: null,
    });
    expect((await work(run.id, reviewRound(4, 25))).story.identifier).toBe("ENG-301");
    expect(await storyRounds(run.id, "ENG-301")).toEqual({
      status: "pending",
      attempts: 0,
      rounds: 1,
    });
  });

  it("waits on an outside blocker and resumes when an Issue webhook says it's done", async () => {
    const outside = linear.add({
      identifier: "OPS-1",
      title: "Provision the queue",
      teamKey: "OPS",
    });
    const epic = linear.add({ identifier: "ENG-60", title: "Epic" });
    const story = linear.add({ identifier: "ENG-61", title: "Use the queue", parentId: epic.id });
    await linear.createBlocksRelation(outside.id, story.id);

    const run = await delegate(epic.id);
    expect(await activeJobs(run.id)).toEqual([]);
    expect(await getRun(db, run.id)).toMatchObject({
      status: "waiting",
      waitingOn: {
        blockers: [{ id: outside.id, identifier: "OPS-1", title: "Provision the queue" }],
        manual: [],
      },
    });
    const [elicitation] = linear.bodies(run.linearAgentSessionId, "elicitation");
    expect(elicitation).toContain("0/1 stories are done; the rest are waiting on **OPS-1**");
    expect(elicitation).toContain("start anyway");

    // Unrelated events and a repeat change nothing.
    const event = (issueId: string) =>
      handleLinearEvent(
        { kind: "issue_state", issueId, removed: false },
        { db, organizationId: orgId, workspaceId: "org-1" },
        { linear, dispatcher },
      );
    await event("unrelated");
    await advanceRun(run.id, deps());
    expect(linear.bodies(run.linearAgentSessionId, "elicitation")).toHaveLength(1);
    expect(await activeJobs(run.id)).toEqual([]);

    await linear.setIssueState(outside.id, { type: "completed" });
    await event(outside.id);
    expect((await activeJob(run.id)).payload).toMatchObject({ story: { identifier: "ENG-61" } });
    expect(await getRun(db, run.id)).toMatchObject({ status: "running", waitingOn: null });
  });

  it("waits on a manual story and resumes when it's done", async () => {
    const epic = linear.add({ identifier: "ENG-70", title: "Epic" });
    linear.add({ identifier: "ENG-71", title: "Code", parentId: epic.id, subIssueSortOrder: 0 });
    const manual = linear.add({
      identifier: "ENG-72",
      title: "Configure DNS",
      parentId: epic.id,
      labels: ["manual"],
      subIssueSortOrder: 1,
    });
    const after = linear.add({
      identifier: "ENG-73",
      title: "Use DNS",
      parentId: epic.id,
      subIssueSortOrder: 2,
    });
    await linear.createBlocksRelation(manual.id, after.id);
    const run = await delegate(epic.id);

    expect((await work(run.id)).story.identifier).toBe("ENG-71");
    expect(await getRun(db, run.id)).toMatchObject({
      status: "waiting",
      waitingOn: {
        blockers: [],
        manual: [{ id: manual.id, identifier: "ENG-72", title: "Configure DNS" }],
      },
    });
    expect(linear.bodies(run.linearAgentSessionId, "elicitation")[0]).toContain(
      "1/3 stories are done; the rest are waiting on **ENG-72**",
    );

    await linear.setIssueState(manual.id, { type: "completed" });
    await handleLinearEvent(
      { kind: "issue_state", issueId: manual.id, removed: false },
      { db, organizationId: orgId, workspaceId: "org-1" },
      { linear, dispatcher },
    );
    expect((await work(run.id)).story.identifier).toBe("ENG-73");
    expect(await getRun(db, run.id)).toMatchObject({ status: "completed" });
  });

  it("uses the repository's manual labels for selection, waiting and follow-ups", async () => {
    const settings = { ...DEFAULT_RALPH_SETTINGS, setupCommand: "pnpm install" };
    const withLabels = (manualLabels: string[]) =>
      updateRepositoryRalphSettings(db, repoId, {
        ralphEnabled: true,
        linearTeamKeys: ["ENG"],
        linearProjectNames: [],
        linearLabels: [],
        ralphSettings: { ...settings, manualLabels },
      });
    await withLabels(["by hand"]);
    try {
      const epic = linear.add({ identifier: "ENG-150", title: "Epic" });
      const dns = linear.add({
        identifier: "ENG-151",
        title: "Configure DNS",
        parentId: epic.id,
        labels: ["By Hand"],
        subIssueSortOrder: 0,
      });
      linear.add({
        identifier: "ENG-152",
        title: "Code",
        parentId: epic.id,
        labels: ["manual"],
        subIssueSortOrder: 1,
      });
      const after = linear.add({
        identifier: "ENG-153",
        title: "Use DNS",
        parentId: epic.id,
        subIssueSortOrder: 2,
      });
      await linear.createBlocksRelation(dns.id, after.id);
      const run = await delegate(epic.id);

      // `manual` isn't a manual label here; `by hand` is (ignoring case).
      const unfinished = await work(run.id, {
        status: "incomplete",
        summary: "Needs a key.",
        followUps: [{ title: "Create the API key", description: "In the console.", manual: true }],
      });
      expect(unfinished.story.identifier).toBe("ENG-152");
      const key = [...linear.issues.values()].find((i) => i.title === "Create the API key")!;
      expect(key.labels).toEqual(["by hand"]);

      // The labels are read again on every advance: a label added in Linear counts.
      await withLabels(["by hand", "ops"]);
      linear.issues.set(after.id, { ...after, labels: ["Ops"] });
      await advanceRun(run.id, deps());
      expect(await activeJobs(run.id)).toEqual([]);
      const waiting = (await withPullRequest(run.id))!;
      expect(waiting.status).toBe("waiting");
      expect(waiting.waitingOn?.blockers).toEqual([]);
      expect(waiting.waitingOn?.manual.map((m) => m.identifier).sort()).toEqual(
        ["ENG-151", "ENG-153", key.identifier].sort(),
      );
      expect(await storyStates(run.id)).toEqual(
        expect.arrayContaining([
          ["ENG-151", "manual", 0],
          ["ENG-152", "pending", 1],
          ["ENG-153", "manual", 0],
          [key.identifier, "manual", 0],
        ]),
      );
    } finally {
      await updateRepositoryRalphSettings(db, repoId, {
        ralphEnabled: true,
        linearTeamKeys: ["ENG"],
        linearProjectNames: [],
        linearLabels: [],
        ralphSettings: settings,
      });
    }
  });

  /** A run waiting on an outside blocker that was just completed (without a webhook). */
  async function unblockedWaitingRun(): Promise<LinearRun> {
    const outside = linear.add({ identifier: "OPS-9", title: "Outside", teamKey: "OPS" });
    const epic = linear.add({ identifier: "ENG-90", title: "Epic" });
    const story = linear.add({ identifier: "ENG-91", title: "Story", parentId: epic.id });
    await linear.createBlocksRelation(outside.id, story.id);
    const run = await delegate(epic.id);
    expect((await getRun(db, run.id))?.status).toBe("waiting");
    await linear.setIssueState(outside.id, { type: "completed" });
    return run;
  }

  it("enqueues exactly one job when advanceRun races with itself", async () => {
    const run = await unblockedWaitingRun();
    const results = await Promise.all(Array.from({ length: 5 }, () => advanceRun(run.id, deps())));
    expect(results.filter((r) => r.action === "enqueued")).toHaveLength(1);
    expect(results.filter((r) => r.action === "busy")).toHaveLength(4);
    expect(await db.select().from(jobs).where(eq(jobs.ralphRunId, run.id))).toHaveLength(1);
    expect(
      linear.bodies(run.linearAgentSessionId, "thought").filter((t) => t.startsWith("▶️")),
    ).toHaveLength(1);
  });

  it("reconciles waiting runs and outcomes that were never applied", async () => {
    const waiting = await unblockedWaitingRun();
    expect(await reconcileRuns(deps())).toEqual({ reconciled: 1, failed: 0 });
    const job = await activeJob(waiting.id);

    // The job completes, but its outcome hook never ran (e.g. the control panel crashed).
    const { claim } = await claimJob(db, {
      organizationId: orgId,
      harnessId: agentA,
      acceptedTaskTypes: ["query", "coding"],
      pools: ["short", "long"],
      harnessVersion: CODING_TASKS_MIN_HARNESS_VERSION,
      maxDeliveries: MAX_JOB_DELIVERIES,
    });
    expect(claim?.job.id).toBe(job.id);
    await completeJob(db, {
      jobId: job.id,
      harnessId: agentA,
      result: result({ commitSha: sha(7) }),
    });
    expect(await reconcileRuns(deps())).toEqual({ reconciled: 0, failed: 0 });
    const later = new Date(Date.now() + RECONCILE_STALE_MS + 60_000);
    expect(await reconcileRuns(deps(), later)).toEqual({ reconciled: 1, failed: 0 });
    expect(await getRun(db, waiting.id)).toMatchObject({ status: "running" });
    await describePr(waiting.id);
    expect(await getRun(db, waiting.id)).toMatchObject({ status: "completed" });
    expect((await listStories(db, waiting.id))[0]).toMatchObject({ commitSha: sha(7) });
  });

  it("skips a job whose run is over, and ignores outcomes of finished runs", async () => {
    const issue = linear.add({ identifier: "ENG-95", title: "Solo" });
    const run = await delegate(issue.id);
    const job = await activeJob(run.id);
    await updateRun(db, run.id, { status: "stopped" });
    expect(await onRalphJobStarted(db, job, agentA)).toEqual({ skip: true, reason: "skipped" });
    expect((await getJob(db, job.id))?.status).toBe("skipped");
    await onRalphJobFinished(db, (await getJob(db, job.id))!, deps());
    expect(await storyStates(run.id)).toEqual([["ENG-95", "running", 0]]);
  });

  describe("lanes", () => {
    /** An epic in project API (team ENG): ENG-2, then ENG-3 in `project`, then ENG-4 (needs ENG-3). */
    function crossRepo(project: string) {
      const epic = linear.add({ identifier: "ENG-1", title: "Task priority", projectName: "API" });
      const s1 = linear.add({
        identifier: "ENG-2",
        title: "Add priority field",
        parentId: epic.id,
        projectName: "API",
        priority: 1,
      });
      const s2 = linear.add({
        identifier: "ENG-3",
        title: "Show badge",
        parentId: epic.id,
        projectName: project,
        priority: 2,
      });
      const s3 = linear.add({
        identifier: "ENG-4",
        title: "Sort by priority",
        parentId: epic.id,
        projectName: "API",
        priority: 3,
      });
      return { epic, s1, s2, s3 };
    }

    it("treats a story whose project no repository here covers like a manual step", async () => {
      const t = crossRepo("Docs");
      await linear.createBlocksRelation(t.s2.id, t.s3.id); // ENG-4 needs ENG-3
      const run = await delegate(t.epic.id);

      expect((await work(run.id)).story.identifier).toBe("ENG-2");
      expect(await activeJobs(run.id)).toEqual([]);
      expect(await getRun(db, run.id)).toMatchObject({
        status: "waiting",
        waitingOn: { blockers: [], manual: [expect.objectContaining({ identifier: "ENG-3" })] },
      });
      // Only the main lane: nothing is built for the story that belongs elsewhere.
      const lanes = await listLanes(db, run.id);
      expect(lanes.map((l) => l.repositoryId)).toEqual([repoId]);
      expect(
        (await listStories(db, run.id)).map((s) => [s.identifier, s.status, s.laneId, s.elsewhere]),
      ).toEqual([
        ["ENG-2", "completed", lanes[0]!.id, null],
        ["ENG-3", "manual", null, "it's in project Docs, which no repository here is set up for"],
        ["ENG-4", "pending", lanes[0]!.id, null],
      ]);
      expect(linear.issues.get(t.s2.id)?.stateType).toBe("unstarted");
      expect(
        linear
          .bodies(run.linearAgentSessionId, "thought")
          .some((b) =>
            b.includes(
              "**ENG-3** isn't in a repository I have (it's in project Docs, which no repository here is set up for), so I'll treat it like a manual step: I won't work it, and stories that depend on it wait until it's done.",
            ),
          ),
      ).toBe(true);
      expect(linear.plan(run.linearAgentSessionId)?.map((p) => p.content)).toContain(
        "ENG-3: Show badge (manual: no repository here)",
      );
      expect(scm.changeRequests).toEqual([]);

      // Someone does ENG-3 elsewhere: its dependent runs and the epic finishes.
      await linear.setIssueState(t.s2.id, { type: "completed" });
      await handleLinearEvent(
        { kind: "issue_state", issueId: t.s2.id, removed: false },
        { db, organizationId: orgId, workspaceId: "org-1" },
        { linear, dispatcher },
      );
      expect((await work(run.id, { commitSha: sha(4) })).story.identifier).toBe("ENG-4");
      await describePr(run.id);
      expect((await getRun(db, run.id))?.status).toBe("completed");
      expect(scm.changeRequests).toHaveLength(1);
    });

    it("records the harness that starts a job on the job's lane, and on the run for the main lane", async () => {
      const t = crossRepo("Web");
      const run = await delegate(t.epic.id);
      const harnessesOf = async () => {
        const lanes = await listLanes(db, run.id);
        return {
          run: (await getRun(db, run.id))?.harnessId,
          main: lanes.find((l) => l.repositoryId === repoId)?.harnessId,
          web: lanes.find((l) => l.repositoryId === gitlabRepoId)?.harnessId,
        };
      };
      expect(await harnessesOf()).toEqual({ run: null, main: null, web: null });

      const job = await activeJob(run.id);
      expect(job.repositoryId).toBe(repoId);
      expect(await onRalphJobStarted(db, job, agentA)).toEqual({ skip: false });
      expect(await harnessesOf()).toEqual({ run: agentA, main: agentA, web: null });

      // A job in the secondary lane changes only that lane's harness.
      const webJob: Job = { ...job, repositoryId: gitlabRepoId };
      expect(await onRalphJobStarted(db, webJob, agentB)).toEqual({ skip: false });
      expect(await harnessesOf()).toEqual({ run: agentA, main: agentA, web: agentB });
    });

    describe("laneHarnessId", () => {
      const lane = (harnessId: string | null, repositoryId = gitlabRepoId) => ({
        harnessId,
        repositoryId,
      });
      const run = () => ({ organizationId: orgId });

      it("is the lane's sticky harness while it is usable", async () => {
        await pinRepositoryToHarness(db, { harnessId: agentA, repositoryId: gitlabRepoId });
        expect(await laneHarnessId(db, run(), lane(agentB))).toBe(agentB);
      });

      it("falls back to the repository's pinned harness when the sticky one is revoked", async () => {
        await pinRepositoryToHarness(db, { harnessId: agentA, repositoryId: gitlabRepoId });
        await db.update(harnesses).set({ revokedAt: new Date() }).where(eq(harnesses.id, agentB));
        expect(await laneHarnessId(db, run(), lane(agentB))).toBe(agentA);
      });

      it("falls back to the pinned harness when the sticky one doesn't take coding tasks", async () => {
        await pinRepositoryToHarness(db, { harnessId: agentA, repositoryId: gitlabRepoId });
        await db
          .update(harnesses)
          .set({ acceptedTaskTypes: ["review"] })
          .where(eq(harnesses.id, agentB));
        expect(await laneHarnessId(db, run(), lane(agentB))).toBe(agentA);
      });

      it("falls back to the pinned harness when the sticky one is in another organization", async () => {
        const [other] = await db.insert(organizations).values({ name: "Initech" }).returning();
        const [foreign] = await db
          .insert(harnesses)
          .values({ organizationId: other!.id, name: "initech-1", acceptedTaskTypes: ["coding"] })
          .returning();
        await pinRepositoryToHarness(db, { harnessId: agentA, repositoryId: gitlabRepoId });
        expect(await laneHarnessId(db, run(), lane(foreign!.id))).toBe(agentA);
      });

      it("falls back to the pinned harness without a sticky one", async () => {
        await pinRepositoryToHarness(db, { harnessId: agentA, repositoryId: gitlabRepoId });
        expect(await laneHarnessId(db, run(), lane(null))).toBe(agentA);
        // Another repository's pin doesn't count.
        expect(await laneHarnessId(db, run(), lane(null, repoId))).toBeUndefined();
      });

      it("is undefined without a usable sticky harness or a pin", async () => {
        expect(await laneHarnessId(db, run(), lane(null))).toBeUndefined();
        await db.update(harnesses).set({ revokedAt: new Date() }).where(eq(harnesses.id, agentB));
        expect(await laneHarnessId(db, run(), lane(agentB))).toBeUndefined();
      });
    });

    it("gives a story whose project routes to another repository a lane there", async () => {
      const t = crossRepo("Web");
      const run = await delegate(t.epic.id);

      const lanes = await listLanes(db, run.id);
      const main = lanes.find((l) => l.repositoryId === repoId)!;
      const web = lanes.find((l) => l.repositoryId === gitlabRepoId)!;
      expect(lanes).toHaveLength(2);
      // The same branch, based on that repository's default branch.
      expect(web).toMatchObject({ branch: main.branch, baseBranch: "develop", prNumber: null });
      expect((await listStories(db, run.id)).map((s) => [s.identifier, s.laneId])).toEqual([
        ["ENG-2", main.id],
        ["ENG-3", web.id],
        ["ENG-4", main.id],
      ]);
      expect(
        linear
          .bodies(run.linearAgentSessionId, "thought")
          .some((b) =>
            b.includes(
              "**ENG-3** belongs in `group/app` (routed by project `Web`), so I'll work it there, on its own branch",
            ),
          ),
      ).toBe(true);

      // Advancing again keeps the lanes (no second default-branch lookup).
      const lookups = scm.calls.filter((c) => c === "getDefaultBranch").length;
      await advanceRun(run.id, deps());
      expect((await listLanes(db, run.id)).map((l) => l.id).sort()).toEqual(
        [main.id, web.id].sort(),
      );
      expect(scm.calls.filter((c) => c === "getDefaultBranch")).toHaveLength(lookups);

      // The run detail has one section per lane.
      const detail = await getRunDetail(db, orgId, run.id);
      expect(detail!.lanes.map((l) => [l.repository.fullPath, l.main])).toEqual([
        ["acme/api", true],
        ["group/app", false],
      ]);
    });

    it("sends each lane's jobs to its own harness when its repository is pinned to another", async () => {
      await pinRepositoryToHarness(db, { harnessId: agentA, repositoryId: repoId });
      await pinRepositoryToHarness(db, { harnessId: agentB, repositoryId: gitlabRepoId });
      const t = crossRepo("Web");
      const run = await delegate(t.epic.id);
      const laneHarnesses = async () =>
        Object.fromEntries((await listLanes(db, run.id)).map((l) => [l.repositoryId, l.harnessId]));

      expect(await activeJob(run.id)).toMatchObject({
        repositoryId: repoId,
        targetHarnessId: agentA,
      });
      expect((await work(run.id, { commitSha: sha(51) }, agentA)).story.identifier).toBe("ENG-2");
      expect(await activeJob(run.id)).toMatchObject({
        repositoryId: gitlabRepoId,
        targetHarnessId: agentB,
      });
      expect((await work(run.id, { commitSha: sha(52) }, agentB)).story.identifier).toBe("ENG-3");
      // Starting the app lane's job left the main lane (and the run) on A.
      expect(await laneHarnesses()).toEqual({ [repoId]: agentA, [gitlabRepoId]: agentB });
      expect((await getRun(db, run.id))?.harnessId).toBe(agentA);
      expect(await activeJob(run.id)).toMatchObject({
        repositoryId: repoId,
        targetHarnessId: agentA,
      });
      expect((await work(run.id, { commitSha: sha(53) }, agentA)).story.identifier).toBe("ENG-4");

      // Each lane's describe job goes to its harness too.
      expect(await activeJob(run.id)).toMatchObject({
        type: "ralph.describe-pr",
        repositoryId: repoId,
        targetHarnessId: agentA,
      });
      await describePr(run.id, { title: "API: priority" }, agentA);
      expect(await activeJob(run.id)).toMatchObject({
        type: "ralph.describe-pr",
        repositoryId: gitlabRepoId,
        targetHarnessId: agentB,
      });
      await describePr(run.id, { title: "Web: badge" }, agentB);
      expect(await laneHarnesses()).toEqual({ [repoId]: agentA, [gitlabRepoId]: agentB });
      expect((await getRun(db, run.id))?.status).toBe("completed");
      expect(scm.changeRequests.map((c) => c.fullPath)).toEqual(["acme/api", "group/app"]);
    });

    /** Runs `body` with the GitLab repository's ralph settings changed. */
    async function withAppSettings(
      settings: Partial<typeof DEFAULT_RALPH_SETTINGS>,
      body: () => Promise<void>,
    ) {
      const update = (ralphSettings: typeof DEFAULT_RALPH_SETTINGS) =>
        updateRepositoryRalphSettings(db, gitlabRepoId, {
          ralphEnabled: true,
          linearTeamKeys: ["GL"],
          linearProjectNames: ["Web"],
          linearLabels: [],
          ralphSettings,
        });
      await update({ ...DEFAULT_RALPH_SETTINGS, ...settings });
      try {
        await body();
      } finally {
        await update(DEFAULT_RALPH_SETTINGS);
      }
    }

    const reply = (run: LinearRun, body: string) =>
      handleLinearEvent(
        { kind: "session_prompted", sessionId: run.linearAgentSessionId, body },
        { db, organizationId: orgId, workspaceId: "org-1" },
        { linear, dispatcher, adapterFor: () => scm.asAdapter() },
      );

    it("files a secondary lane's follow-ups so they're worked in that lane", async () => {
      await withAppSettings({ manualLabels: ["ops"] }, async () => {
        const t = crossRepo("Web");
        const run = await delegate(t.epic.id);
        const web = (await listLanes(db, run.id)).find((l) => l.repositoryId === gitlabRepoId)!;

        expect((await work(run.id, { commitSha: sha(61) })).story.identifier).toBe("ENG-2");
        expect(
          (
            await work(run.id, {
              commitSha: sha(62),
              followUps: [
                { title: "Style the badge", description: "Use the theme.", manual: false },
                { title: "Upload the icon", description: "To the CDN.", manual: true },
              ],
            })
          ).story.identifier,
        ).toBe("ENG-3");
        const style = [...linear.issues.values()].find((i) => i.title === "Style the badge")!;
        const icon = [...linear.issues.values()].find((i) => i.title === "Upload the icon")!;
        // The story's project (not the epic's), and the app repository's manual label.
        expect(style).toMatchObject({ parentId: t.epic.id, projectName: "Web", labels: [] });
        expect(icon).toMatchObject({ projectName: "Web", labels: ["ops"] });
        expect(linear.bodies(run.linearAgentSessionId, "thought").join("\n")).toContain(
          `Filed **${style.identifier}**, **${icon.identifier}** as new stories of **ENG-1** in \`group/app\`.`,
        );

        // The follow-up (priority 2) runs next, in the app lane.
        expect(await activeJob(run.id)).toMatchObject({ repositoryId: gitlabRepoId });
        expect((await work(run.id, { commitSha: sha(63) })).story.identifier).toBe(
          style.identifier,
        );
        const stories = await listStories(db, run.id);
        expect(
          stories
            .filter((s) => s.identifier === style.identifier || s.identifier === icon.identifier)
            .map((s) => [s.identifier, s.status, s.laneId]),
        ).toEqual([
          [style.identifier, "completed", web.id],
          [icon.identifier, "manual", web.id],
        ]);
      });
    });

    it("files the follow-ups of a story routed by team or label with its team and routing label", async () => {
      const update = (linearLabels: string[]) =>
        updateRepositoryRalphSettings(db, gitlabRepoId, {
          ralphEnabled: true,
          linearTeamKeys: ["GL"],
          linearProjectNames: ["Web"],
          linearLabels,
          ralphSettings: DEFAULT_RALPH_SETTINGS,
        });
      await update(["frontend"]);
      try {
        const epic = linear.add({ identifier: "ENG-1", title: "Epic", projectName: "API" });
        linear.add({
          identifier: "GL-2",
          title: "By team",
          parentId: epic.id,
          teamId: "team-gl",
          teamKey: "GL",
          priority: 1,
        });
        linear.add({
          identifier: "ENG-3",
          title: "By label",
          parentId: epic.id,
          projectName: "API",
          labels: ["Frontend", "bug"],
          priority: 2,
        });
        const run = await delegate(epic.id);
        const web = (await listLanes(db, run.id)).find((l) => l.repositoryId === gitlabRepoId)!;

        const laneOf = async (identifier: string) =>
          (await listStories(db, run.id)).find((s) => s.identifier === identifier)?.laneId;

        expect(
          (
            await work(run.id, {
              followUps: [{ title: "Team follow-up", description: "More.", manual: false }],
            })
          ).story.identifier,
        ).toBe("GL-2");
        const byTeam = [...linear.issues.values()].find((i) => i.title === "Team follow-up")!;
        // The story's team (not the epic's) and no project.
        expect(byTeam).toMatchObject({ teamId: "team-gl", teamKey: "GL", labels: [] });
        expect(byTeam.projectName).toBeUndefined();
        expect((await work(run.id)).story.identifier).toBe(byTeam.identifier);
        expect(await laneOf(byTeam.identifier)).toBe(web.id);

        expect(
          (
            await work(run.id, {
              followUps: [{ title: "Label follow-up", description: "More.", manual: false }],
            })
          ).story.identifier,
        ).toBe("ENG-3");
        const byLabel = [...linear.issues.values()].find((i) => i.title === "Label follow-up")!;
        // Only the label that routes it, as on the story.
        expect(byLabel).toMatchObject({
          teamId: "team-1",
          projectName: "API",
          labels: ["Frontend"],
        });
        expect((await work(run.id)).story.identifier).toBe(byLabel.identifier);
        expect(await laneOf(byLabel.identifier)).toBe(web.id);
      } finally {
        await update([]);
      }
    });

    it("works a story whose project routes to another repository there, on its own branch and PR", async () => {
      await withAppSettings({ verifyCommands: ["npm run check"], model: "sonnet" }, async () => {
        const t = crossRepo("Web");
        const run = await delegate(t.epic.id);
        const lanes = await listLanes(db, run.id);
        const main = lanes.find((l) => l.repositoryId === repoId)!;
        const web = lanes.find((l) => l.repositoryId === gitlabRepoId)!;

        const first = await work(run.id, { commitSha: sha(41) }, agentA);
        expect(first).toMatchObject({
          repositoryId: repoId,
          repository: { fullPath: "acme/api" },
          branch: main.branch,
          baseBranch: "develop",
          settings: { setupCommand: "pnpm install" },
          qualityGates: [],
        });
        expect(first.stories.map((s) => [s.identifier, s.repository])).toEqual([
          ["ENG-2", null],
          ["ENG-3", "group/app"],
          ["ENG-4", null],
        ]);

        // ENG-3 runs in its lane: that repository, the same branch on its base, its settings and gates.
        // That lane has no harness of its own yet: any harness may take its job.
        const job = await activeJob(run.id);
        expect(job).toMatchObject({
          repositoryId: gitlabRepoId,
          targetHarnessId: null,
        });
        const second = await work(run.id, { commitSha: sha(42) }, agentA);
        expect(second).toMatchObject({
          repositoryId: gitlabRepoId,
          repository: { provider: "gitlab", fullPath: "group/app" },
          branch: web.branch,
          baseBranch: web.baseBranch,
          settings: { model: "sonnet", setupCommand: null },
          qualityGates: ["npm run check"],
          story: { identifier: "ENG-3" },
        });
        expect(linear.comments.find((c) => c.issueId === t.s2.id)?.body).toContain(
          `on \`${web.branch}\` in \`group/app\``,
        );

        // The main lane's jobs stick to its harness.
        expect((await activeJob(run.id)).targetHarnessId).toBe(agentA);
        expect((await work(run.id, { commitSha: sha(43) }, agentA)).repositoryId).toBe(repoId);

        // Each lane is published with its own describe job and its own PR/MR, the main one first.
        const api = await describePr(run.id, { title: "API: priority" });
        expect(api).toMatchObject({ repositoryId: repoId, branch: main.branch });
        expect(api.stories.map((s) => s.identifier)).toEqual(["ENG-2", "ENG-4"]);
        expect(linear.bodies(run.linearAgentSessionId, "thought").at(-1)).toBe(
          "All 3 stories are done. Writing the merge request description of `group/app`.",
        );
        const app = await describePr(run.id, { title: "Web: badge" });
        expect(app).toMatchObject({ repositoryId: gitlabRepoId, branch: web.branch });
        expect(app.stories.map((s) => s.identifier)).toEqual(["ENG-3"]);

        expect(
          scm.changeRequests.map((c) => [c.fullPath, c.title, c.sourceBranch, c.targetBranch]),
        ).toEqual([
          ["acme/api", "API: priority", main.branch, "develop"],
          ["group/app", "Web: badge", web.branch, web.baseBranch],
        ]);
        const [apiPr, appPr] = scm.changeRequests;
        const updated = await listLanes(db, run.id);
        expect(updated.find((l) => l.id === main.id)).toMatchObject({
          prNumber: apiPr!.number,
          prUrl: apiPr!.url,
        });
        expect(updated.find((l) => l.id === web.id)).toMatchObject({
          prNumber: appPr!.number,
          prUrl: appPr!.url,
        });
        expect(linear.urls).toEqual([
          {
            sessionId: run.linearAgentSessionId,
            label: `Pull request #${apiPr!.number} (acme/api)`,
            url: apiPr!.url,
          },
          {
            sessionId: run.linearAgentSessionId,
            label: `Merge request !${appPr!.number} (group/app)`,
            url: appPr!.url,
          },
        ]);
        expect((await getRun(db, run.id))?.status).toBe("completed");
        const response = linear.bodies(run.linearAgentSessionId, "response").at(-1) ?? "";
        expect(response).toContain(
          `- \`acme/api\`: Opened [Pull request #${apiPr!.number}](${apiPr!.url})`,
        );
        expect(response).toContain(
          `- \`group/app\`: Opened [Merge request !${appPr!.number}](${appPr!.url})`,
        );
        expect(response).toContain("**ENG-3**: Show badge (in `group/app`)");
      });
    });

    it("opens no PR in the epic's repository when every story went to another one", async () => {
      const t = crossRepo("Web");
      for (const s of [t.s1, t.s3]) await linear.setIssueState(s.id, { type: "completed" });
      const run = await delegate(t.epic.id);
      expect((await work(run.id, { commitSha: sha(44) })).story.identifier).toBe("ENG-3");
      const payload = await describePr(run.id);
      expect(payload.repositoryId).toBe(gitlabRepoId);
      expect(await activeJobs(run.id)).toEqual([]);
      expect((await getRun(db, run.id))?.status).toBe("completed");
      expect(scm.changeRequests.map((c) => c.fullPath)).toEqual(["group/app"]);
      const lanes = await listLanes(db, run.id);
      expect(lanes.find((l) => l.repositoryId === repoId)?.prNumber).toBeNull();
      // One PR/MR: no repository label in the response.
      expect(linear.bodies(run.linearAgentSessionId, "response").at(-1)).toContain(
        `Opened [Merge request !${scm.changeRequests[0]!.number}](${scm.changeRequests[0]!.url}), ready for review.`,
      );
    });

    it("collects a lane's publish problem while another lane's PR opens, and a reply retries only it", async () => {
      const t = crossRepo("Web");
      const run = await delegate(t.epic.id);
      await work(run.id, { commitSha: sha(45) });
      await work(run.id, { commitSha: sha(46) });
      await work(run.id, { commitSha: sha(47) });
      await describePr(run.id);
      await describePr(run.id, { jobError: "the session ran out of turns" });

      expect(await activeJobs(run.id)).toEqual([]);
      const waiting = (await getRun(db, run.id))!;
      expect(waiting).toMatchObject({ status: "waiting", prJobId: null });
      const [apiPr] = scm.changeRequests;
      expect(scm.changeRequests.map((c) => c.fullPath)).toEqual(["acme/api"]);
      const elicitation = linear.bodies(run.linearAgentSessionId, "elicitation").at(-1) ?? "";
      expect(elicitation).toContain(
        "Every story is done, but the last step didn't happen everywhere.",
      );
      expect(elicitation).toContain(
        "In `group/app`: I couldn't open the merge request: writing its description failed: the session ran out of turns.",
      );
      expect(elicitation).toContain(
        `Ready for review: [Pull request #${apiPr!.number}](${apiPr!.url}) in \`acme/api\`.`,
      );
      expect(elicitation).toContain("Reply with guidance (for example `retry`)");
      expect(waiting.error).toContain("In `group/app`:");
      expect(linear.bodies(run.linearAgentSessionId, "response")).toEqual([]);

      // Nothing happens until someone replies.
      expect(await advanceRun(run.id, deps())).toMatchObject({ action: "waiting" });
      expect(await activeJobs(run.id)).toEqual([]);

      await reply(run, "retry");
      expect((await describePr(run.id)).repositoryId).toBe(gitlabRepoId);
      expect(await activeJobs(run.id)).toEqual([]);
      expect(await getRun(db, run.id)).toMatchObject({ status: "completed", error: null });
      expect(scm.changeRequests.map((c) => c.fullPath)).toEqual(["acme/api", "group/app"]);
      const response = linear.bodies(run.linearAgentSessionId, "response").at(-1) ?? "";
      expect(response).toContain(`\`acme/api\`: Opened [Pull request #${apiPr!.number}]`);
      expect(response).toContain("`group/app`: Opened [Merge request !");
      expect(linear.urls.map((u) => u.url)).toEqual(scm.changeRequests.map((c) => c.url));
    });

    it("applies openPullRequestEarly per lane", async () => {
      await withAppSettings({ openPullRequestEarly: true }, async () => {
        const t = crossRepo("Web");
        const run = await delegate(t.epic.id);
        await work(run.id, { commitSha: sha(48) });
        expect(scm.changeRequests).toEqual([]);
        await work(run.id, { commitSha: sha(49) });
        expect(scm.changeRequests).toEqual([
          expect.objectContaining({ fullPath: "group/app", draft: true }),
        ]);
        expect(linear.bodies(run.linearAgentSessionId, "thought").join("\n")).toContain(
          "Opened a draft merge request for `eng-1-branch` in `group/app`:",
        );
        const draft = scm.changeRequests[0]!.body;
        expect(draft).toContain("- [x] ENG-3: Show badge");
        expect(draft).not.toContain("ENG-2");
        await work(run.id, { commitSha: sha(50) });
        expect(scm.changeRequests).toHaveLength(1);
      });
    });

    it("ticks pushed stories in each lane's own draft", async () => {
      await updateRepositoryRalphSettings(db, repoId, {
        ralphEnabled: true,
        linearTeamKeys: ["ENG"],
        linearProjectNames: [],
        linearLabels: [],
        ralphSettings: { ...DEFAULT_RALPH_SETTINGS, openPullRequestEarly: true },
      });
      try {
        await withAppSettings({ openPullRequestEarly: true }, async () => {
          const t = crossRepo("Web");
          const run = await delegate(t.epic.id);
          await work(run.id, { commitSha: sha(51) });
          await work(run.id, { commitSha: sha(52) });
          const [api, app] = scm.changeRequests;
          expect(api).toMatchObject({ fullPath: "acme/api", draft: true });
          expect(api!.body).toContain(
            "- [x] ENG-2: Add priority field\n- [ ] ENG-4: Sort by priority",
          );
          expect(app).toMatchObject({ fullPath: "group/app", draft: true });
          // Each lane's body names the other lane's stories too: only its own are ticked.
          api!.body += "\n- [ ] ENG-3 lands in group/app";
          app!.body += "\n- [ ] ENG-4 lands in acme/api";
          const appBody = app!.body;

          await work(run.id, { commitSha: sha(53) });
          expect(api!.body).toContain(
            "- [x] ENG-2: Add priority field\n- [x] ENG-4: Sort by priority",
          );
          expect(api!.body).toContain("- [ ] ENG-3 lands in group/app");
          expect(app!.body).toBe(appBody);
        });
      } finally {
        await updateRepositoryRalphSettings(db, repoId, {
          ralphEnabled: true,
          linearTeamKeys: ["ENG"],
          linearProjectNames: [],
          linearLabels: [],
          ralphSettings: { ...DEFAULT_RALPH_SETTINGS, setupCommand: "pnpm install" },
        });
      }
    });
  });

  describe("the pull/merge request", () => {
    /** A one-story epic whose story is done: the run is describing its PR/MR. */
    async function finishedRun(teamKey = "ENG"): Promise<LinearRun> {
      const epic = linear.add({
        identifier: `${teamKey}-100`,
        title: "Widgets",
        teamKey,
        description: `${EPIC_DESCRIPTION}\n> Branch: feat/widgets`,
      });
      linear.add({
        identifier: `${teamKey}-101`,
        title: "Add widgets",
        teamKey,
        parentId: epic.id,
      });
      const run = await delegate(epic.id);
      await work(run.id, { commitSha: sha(11) });
      expect((await getRun(db, run.id))?.status).toBe("running");
      expect(linear.bodies(run.linearAgentSessionId, "thought").at(-1)).toMatch(
        /^All 1 story is done\. Writing the (pull|merge) request description\.$/,
      );
      return linearRun((await getRun(db, run.id))!);
    }

    const reply = (run: LinearRun, body: string) =>
      handleLinearEvent(
        { kind: "session_prompted", sessionId: run.linearAgentSessionId, body },
        { db, organizationId: orgId, workspaceId: "org-1" },
        { linear, dispatcher, adapterFor: () => scm.asAdapter() },
      );

    it("opens a merge request on GitLab", async () => {
      scm = new FakeScmAdapter("gitlab");
      const run = await finishedRun("GL");
      expect(run.repositoryId).toBe(gitlabRepoId);
      const payload = await describePr(run.id, {
        title: "Add widgets",
        body: "Adds widgets. See [docs](https://gitlab.example.com/group/app/-/wikis/x) and [spam](https://evil.example.com).",
      });
      expect(payload.repository.provider).toBe("gitlab");
      const url = "https://gitlab.example.com/group/app/-/merge_requests/1";
      expect(await withPullRequest(run.id)).toMatchObject({
        status: "completed",
        prNumber: 1,
        prUrl: url,
      });
      const [mr] = scm.changeRequests;
      expect(mr).toMatchObject({
        title: "Add widgets",
        sourceBranch: "feat/widgets",
        targetBranch: "develop",
        draft: false,
      });
      // Sanitized: links to the code host stay, others don't; the Linear footer is added after.
      expect(mr!.body).toContain("(<https://gitlab.example.com/group/app/-/wikis/x>)");
      expect(mr!.body).toContain("spam (`https://evil.example.com`)");
      expect(mr!.body).toMatch(
        /\n\n---\nLinear: \[GL-100\]\(https:\/\/linear\.app\/acme\/issue\/GL-100\) · _Opened by Omniralph\._$/,
      );
      expect(linear.urls).toEqual([
        { sessionId: run.linearAgentSessionId, label: "Merge request !1", url },
      ]);
      expect(linear.bodies(run.linearAgentSessionId, "response")).toEqual([
        [
          `Finished all 1 story of **GL-100** on \`feat/widgets\`. Opened [Merge request !1](${url}), ready for review.`,
          "",
          `- ✅ **GL-101**: Add widgets (\`${sha(11).slice(0, 10)}\`)`,
        ].join("\n"),
      ]);
    });

    it("updates the open pull request for the branch instead of opening another", async () => {
      scm.changeRequests.push({
        number: 7,
        url: "https://github.com/acme/api/pull/7",
        fullPath: "acme/api",
        sourceBranch: "feat/widgets",
        targetBranch: "develop",
        title: "WIP",
        body: "old",
        draft: true,
        state: "open",
      });
      const run = await finishedRun();
      await describePr(run.id);
      expect(scm.changeRequests).toHaveLength(1);
      expect(scm.changeRequests[0]).toMatchObject({
        number: 7,
        title: "Build the epic",
        body: expect.stringContaining("Builds it.") as string,
        draft: false,
      });
      expect(scm.calls).not.toContain("createChangeRequest");
      expect(await withPullRequest(run.id)).toMatchObject({
        status: "completed",
        prNumber: 7,
        prUrl: "https://github.com/acme/api/pull/7",
      });
      expect(linear.bodies(run.linearAgentSessionId, "response")[0]).toContain(
        "Updated [Pull request #7](https://github.com/acme/api/pull/7), ready for review.",
      );
    });

    it("opens a draft with a templated body after the first story with openPullRequestEarly", async () => {
      await updateRepositoryRalphSettings(db, repoId, {
        ralphEnabled: true,
        linearTeamKeys: ["ENG"],
        linearProjectNames: [],
        linearLabels: [],
        ralphSettings: { ...DEFAULT_RALPH_SETTINGS, openPullRequestEarly: true },
      });
      try {
        const epic = linear.add({
          identifier: "ENG-110",
          title: "Gadgets",
          description: `${EPIC_DESCRIPTION}\n> Branch: feat/gadgets`,
        });
        linear.add({ identifier: "ENG-111", title: "First", parentId: epic.id, priority: 1 });
        linear.add({ identifier: "ENG-112", title: "Second", parentId: epic.id, priority: 2 });
        const run = await delegate(epic.id);
        expect(scm.changeRequests).toEqual([]);

        await work(run.id, { commitSha: sha(21) });
        expect(scm.changeRequests).toEqual([
          expect.objectContaining({
            number: 1,
            sourceBranch: "feat/gadgets",
            targetBranch: "develop",
            title: "Gadgets",
            draft: true,
          }),
        ]);
        const draft = scm.changeRequests[0]!.body;
        expect(draft).toContain("Implements **Gadgets**, story by story.");
        expect(draft).toContain("- [x] ENG-111: First\n- [ ] ENG-112: Second");
        expect(draft).toContain("Linear: [ENG-110](https://linear.app/acme/issue/ENG-110)");
        expect(await withPullRequest(run.id)).toMatchObject({
          status: "running",
          prNumber: 1,
          prUrl: "https://github.com/acme/api/pull/1",
        });
        expect(linear.urls).toEqual([
          {
            sessionId: run.linearAgentSessionId,
            label: "Pull request #1",
            url: "https://github.com/acme/api/pull/1",
          },
        ]);
        expect((await activeJob(run.id)).type).toBe("ralph.story");

        await work(run.id, { commitSha: sha(22) });
        expect(scm.changeRequests).toHaveLength(1);
        expect(scm.changeRequests[0]!.draft).toBe(true);
        await describePr(run.id, { title: "Add gadgets", body: "Adds gadgets." });
        expect(scm.changeRequests).toEqual([
          expect.objectContaining({ number: 1, title: "Add gadgets", draft: false }),
        ]);
        expect(scm.changeRequests[0]!.body).toMatch(/^Adds gadgets\.\n\n---\nLinear: /);
        expect(await withPullRequest(run.id)).toMatchObject({ status: "completed", prNumber: 1 });
        expect(linear.bodies(run.linearAgentSessionId, "response")[0]).toContain(
          "Updated [Pull request #1]",
        );
      } finally {
        await updateRepositoryRalphSettings(db, repoId, {
          ralphEnabled: true,
          linearTeamKeys: ["ENG"],
          linearProjectNames: [],
          linearLabels: [],
          ralphSettings: { ...DEFAULT_RALPH_SETTINGS, setupCommand: "pnpm install" },
        });
      }
    });

    it("retries an early draft that failed to open after the next story", async () => {
      await updateRepositoryRalphSettings(db, repoId, {
        ralphEnabled: true,
        linearTeamKeys: ["ENG"],
        linearProjectNames: [],
        linearLabels: [],
        ralphSettings: { ...DEFAULT_RALPH_SETTINGS, openPullRequestEarly: true },
      });
      try {
        const epic = linear.add({ identifier: "ENG-115", title: "Doohickeys" });
        linear.add({ identifier: "ENG-116", title: "First", parentId: epic.id, priority: 1 });
        linear.add({ identifier: "ENG-117", title: "Second", parentId: epic.id, priority: 2 });
        linear.add({ identifier: "ENG-118", title: "Third", parentId: epic.id, priority: 3 });
        const run = await delegate(epic.id);
        scm.failures.set("createChangeRequest", "Validation failed");

        await work(run.id, { commitSha: sha(23) });
        expect(scm.changeRequests).toEqual([]);
        expect(linear.bodies(run.linearAgentSessionId, "thought").join("\n")).toContain(
          "I couldn't open a draft pull request yet (I'll try again after the next story): Validation failed",
        );
        expect(await withPullRequest(run.id)).toMatchObject({ status: "running", prNumber: null });
        expect((await activeJob(run.id)).type).toBe("ralph.story");

        scm.failures.delete("createChangeRequest");
        await work(run.id, { commitSha: sha(24) });
        expect(scm.changeRequests).toEqual([expect.objectContaining({ number: 1, draft: true })]);
        expect((await withPullRequest(run.id))?.prNumber).toBe(1);
        await work(run.id, { commitSha: sha(25) });
        await describePr(run.id);
        expect(scm.changeRequests).toEqual([expect.objectContaining({ number: 1, draft: false })]);
      } finally {
        await updateRepositoryRalphSettings(db, repoId, {
          ralphEnabled: true,
          linearTeamKeys: ["ENG"],
          linearProjectNames: [],
          linearLabels: [],
          ralphSettings: { ...DEFAULT_RALPH_SETTINGS, setupCommand: "pnpm install" },
        });
      }
    });

    /** Runs `body` with early drafts on the GitHub repository. */
    async function withEarlyDrafts(body: () => Promise<void>) {
      const settings = (ralphSettings: typeof DEFAULT_RALPH_SETTINGS) =>
        updateRepositoryRalphSettings(db, repoId, {
          ralphEnabled: true,
          linearTeamKeys: ["ENG"],
          linearProjectNames: [],
          linearLabels: [],
          ralphSettings,
        });
      await settings({ ...DEFAULT_RALPH_SETTINGS, openPullRequestEarly: true });
      try {
        await body();
      } finally {
        await settings({ ...DEFAULT_RALPH_SETTINGS, setupCommand: "pnpm install" });
      }
    }

    it("ticks each pushed (or canceled) story in the draft's task list, leaving the rest of an edited body alone", async () => {
      await withEarlyDrafts(async () => {
        const epic = linear.add({ identifier: "ENG-120", title: "Thingamajigs" });
        linear.add({ identifier: "ENG-121", title: "First", parentId: epic.id, priority: 1 });
        linear.add({ identifier: "ENG-12", title: "Second", parentId: epic.id, priority: 2 });
        const third = linear.add({
          identifier: "ENG-1",
          title: "Third",
          parentId: epic.id,
          priority: 3,
        });
        linear.add({ identifier: "ENG-122", title: "Fourth", parentId: epic.id, priority: 4 });
        const run = await delegate(epic.id);

        await work(run.id, { commitSha: sha(31) });
        const [draft] = scm.changeRequests;
        expect(draft!.body).toContain(
          "- [x] ENG-121: First\n- [ ] ENG-12: Second\n- [ ] ENG-1: Third\n- [ ] ENG-122: Fourth",
        );
        // A person edits the description.
        draft!.body = `Notes about ENG-12.\r\n\r\n${draft!.body}\n- [ ] Docs for ENG-12 too\n- [ ] ENG-1 follow-up`;
        const edited = draft!.body;
        // Nothing new is pushed until the next story: the body isn't written again.
        const updates = () => scm.calls.filter((c) => c === "updateChangeRequest").length;
        expect(updates()).toBe(0);

        third.stateType = "canceled";
        await work(run.id, { commitSha: sha(32) });
        expect(draft!.body).toBe(
          edited
            .replace("- [ ] ENG-12: Second", "- [x] ENG-12: Second")
            .replace("- [ ] Docs for ENG-12 too", "- [x] Docs for ENG-12 too")
            .replace("- [ ] ENG-1: Third", "- [x] ENG-1: Third")
            .replace("- [ ] ENG-1 follow-up", "- [x] ENG-1 follow-up"),
        );
        expect(draft!.body).toContain("- [ ] ENG-122: Fourth");
        expect(updates()).toBe(1);
        expect((await activeJob(run.id)).type).toBe("ralph.story");

        await work(run.id, { commitSha: sha(33) });
        expect(draft!.body).toContain("- [x] ENG-122: Fourth");
        expect(updates()).toBe(2);
        await describePr(run.id, { title: "Add thingamajigs", body: "Adds them." });
        expect(draft!.body).toMatch(/^Adds them\.\n\n---\nLinear: /);
      });
    });

    it("retries ticking pushed stories that failed after the next story", async () => {
      await withEarlyDrafts(async () => {
        const epic = linear.add({ identifier: "ENG-125", title: "Whatsits" });
        linear.add({ identifier: "ENG-126", title: "First", parentId: epic.id, priority: 1 });
        linear.add({ identifier: "ENG-127", title: "Second", parentId: epic.id, priority: 2 });
        linear.add({ identifier: "ENG-128", title: "Third", parentId: epic.id, priority: 3 });
        const run = await delegate(epic.id);
        await work(run.id, { commitSha: sha(34) });
        const [draft] = scm.changeRequests;

        scm.failures.set("updateChangeRequest", "Bad gateway");
        await work(run.id, { commitSha: sha(35) });
        expect(draft!.body).toContain("- [ ] ENG-127: Second");
        expect(linear.bodies(run.linearAgentSessionId, "thought").join("\n")).toContain(
          "I couldn't tick the pushed stories in the pull request yet (I'll try again after the next story): Bad gateway",
        );
        expect((await activeJob(run.id)).type).toBe("ralph.story");

        scm.failures.delete("updateChangeRequest");
        await work(run.id, { commitSha: sha(36) });
        expect(draft!.body).toContain(
          "- [x] ENG-126: First\n- [x] ENG-127: Second\n- [x] ENG-128: Third",
        );
      });
    });

    describe("epicCompletedState", () => {
      /** Runs `body` with the GitHub repository's `epicCompletedState` set. */
      async function withEpicCompletedState(state: string | null, body: () => Promise<void>) {
        const settings = (ralphSettings: typeof DEFAULT_RALPH_SETTINGS) =>
          updateRepositoryRalphSettings(db, repoId, {
            ralphEnabled: true,
            linearTeamKeys: ["ENG"],
            linearProjectNames: [],
            linearLabels: [],
            ralphSettings,
          });
        await settings({
          ...DEFAULT_RALPH_SETTINGS,
          setupCommand: "pnpm install",
          epicCompletedState: state,
        });
        linear.workflowStates = [
          { id: "s-todo", name: "Todo", type: "unstarted", position: 0 },
          { id: "s-progress", name: "In Progress", type: "started", position: 1 },
          { id: "s-review", name: "In Review", type: "started", position: 2 },
          { id: "s-done", name: "Done", type: "completed", position: 3 },
          { id: "s-shipped", name: "Shipped", type: "completed", position: 4 },
        ];
        try {
          await body();
        } finally {
          await settings({ ...DEFAULT_RALPH_SETTINGS, setupCommand: "pnpm install" });
        }
      }

      const epicOf = (run: LinearRun) => linear.issues.get(run.linearIssueId)!;

      it("moves the epic to the named state once the pull request is opened", async () => {
        await withEpicCompletedState("in review", async () => {
          const run = await finishedRun();
          expect(epicOf(run).stateName).not.toBe("In Review");
          await describePr(run.id);
          expect(await withPullRequest(run.id)).toMatchObject({ status: "completed", prNumber: 1 });
          expect(epicOf(run)).toMatchObject({ stateName: "In Review", stateType: "started" });
        });
      });

      it("moves it to the first state of a type, even when the PR step failed", async () => {
        await withEpicCompletedState("completed", async () => {
          const run = await finishedRun();
          await describePr(run.id, { jobError: "no title" });
          expect((await getRun(db, run.id))?.status).toBe("waiting");
          expect(epicOf(run)).toMatchObject({ stateName: "Done", stateType: "completed" });
        });
      });

      it("moves it when nothing was committed and there is no pull request", async () => {
        await withEpicCompletedState("Shipped", async () => {
          const epic = linear.add({ identifier: "ENG-130", title: "Nothing to do" });
          linear.add({ identifier: "ENG-131", title: "Already done", parentId: epic.id });
          const run = await delegate(epic.id);
          await work(run.id, {});
          expect((await getRun(db, run.id))?.status).toBe("completed");
          expect(epicOf(run)).toMatchObject({ stateName: "Shipped", stateType: "completed" });
        });
      });

      it("logs a Linear failure without failing the run", async () => {
        await withEpicCompletedState("In Review", async () => {
          const run = await finishedRun();
          linear.failures.set("setIssueState", new Error("Linear is down"));
          const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
          try {
            await describePr(run.id);
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("Linear is down"));
          } finally {
            linear.failures.delete("setIssueState");
            warn.mockRestore();
          }
          expect(await withPullRequest(run.id)).toMatchObject({ status: "completed", prNumber: 1 });
          expect(epicOf(run).stateName).not.toBe("In Review");
        });
      });

      it("leaves a single issue and an unset state alone", async () => {
        await withEpicCompletedState("In Review", async () => {
          const issue = linear.add({ identifier: "ENG-132", title: "One fix" });
          const run = await delegate(issue.id);
          await work(run.id, { commitSha: sha(30) });
          await describePr(run.id);
          expect((await getRun(db, run.id))?.status).toBe("completed");
          expect(linear.stateChanges.filter((c) => c.target.name === "In Review")).toEqual([]);
        });
        await withEpicCompletedState(null, async () => {
          const run = await finishedRun();
          linear.stateChanges = [];
          await describePr(run.id);
          expect(linear.stateChanges).toEqual([]);
        });
      });
    });

    it("waits with an error when the describe job fails, and a reply retries the PR step", async () => {
      const run = await finishedRun();
      await describePr(run.id, { jobError: "the session ended without a valid title and body" });
      const waiting = (await withPullRequest(run.id))!;
      expect(waiting).toMatchObject({
        status: "waiting",
        prJobId: null,
        prNumber: null,
        waitingOn: { blockers: [], manual: [] },
      });
      expect(waiting.error).toContain("the session ended without a valid title and body");
      const [error] = linear.bodies(run.linearAgentSessionId, "elicitation");
      expect(error).toContain(
        "Every story is done, but I couldn't open the pull request: writing its description failed: the session ended without a valid title and body.",
      );
      expect(error).toContain("Reply with guidance");
      expect(scm.changeRequests).toEqual([]);
      expect(linear.bodies(run.linearAgentSessionId, "response")).toEqual([]);

      // Nothing happens until someone replies.
      expect(await advanceRun(run.id, deps())).toMatchObject({ action: "waiting" });
      expect(await reconcileRuns(deps())).toEqual({ reconciled: 1, failed: 0 });
      expect(await activeJobs(run.id)).toEqual([]);

      await reply(run, "retry please");
      expect((await getRun(db, run.id))?.guidance.map((g) => g.text)).toEqual(["retry please"]);
      await describePr(run.id);
      expect(await withPullRequest(run.id)).toMatchObject({
        status: "completed",
        prNumber: 1,
        error: null,
      });
    });

    it("waits with an error when opening the pull request fails", async () => {
      scm.failures.set("createChangeRequest", "Resource not accessible by integration");
      const run = await finishedRun();
      await describePr(run.id);
      expect(await withPullRequest(run.id)).toMatchObject({ status: "waiting", prNumber: null });
      expect(linear.bodies(run.linearAgentSessionId, "elicitation")[0]).toContain(
        "Every story is done, but I couldn't open the pull request: Resource not accessible by integration.",
      );

      scm.failures.clear();
      await reply(run, "I fixed the app permissions");
      await describePr(run.id);
      expect(await withPullRequest(run.id)).toMatchObject({ status: "completed", prNumber: 1 });
      expect(scm.changeRequests).toHaveLength(1);
    });

    it("completes without a pull request when no story committed anything", async () => {
      const issue = linear.add({ identifier: "ENG-120", title: "Nothing to change" });
      const run = await delegate(issue.id);
      await work(run.id, {});
      expect(await withPullRequest(run.id)).toMatchObject({ status: "completed", prNumber: null });
      expect(await activeJobs(run.id)).toEqual([]);
      expect(linear.bodies(run.linearAgentSessionId, "response")[0]).toContain(
        "Nothing was committed",
      );
    });
  });

  describe("a run delegated from a chat thread", () => {
    const DISCORD_THREAD = "discord:G1:CH1:TH1";
    let adapter: Adapter;
    let threadId: string;

    beforeEach(async () => {
      await db.delete(chatLinearDelegations);
      await db.delete(chatMessages);
      const connection = await saveChatConnection(db, {
        organizationId: orgId,
        platform: "discord",
        externalId: "G1",
        name: "Acme",
        credentials: null,
        installedByUserId: null,
      });
      if (connection === "other_organization") throw new Error("connected elsewhere");
      threadId = (await ensureChatThread(db, {
        connectionId: connection.id,
        externalThreadId: DISCORD_THREAD,
        channelId: "discord:G1:CH1",
        startedByExternalUserId: "D-ADA",
      }))!.id;
      let n = 0;
      adapter = createMockAdapter("discord", {
        postMessage: vi.fn(async (thread: string) => {
          n += 1;
          return { id: `m-${n}`, threadId: thread, raw: {} };
        }),
      });
      chat = {
        db,
        adapters: { discord: adapter },
        state: createMockState(),
        appUrl: "https://omniralph.example.com",
      };
    });

    /** The messages posted to the thread. */
    const posted = () =>
      vi.mocked(adapter.postMessage).mock.calls.map(([thread, message]) => {
        expect(thread).toBe(DISCORD_THREAD);
        return (message as { markdown: string }).markdown;
      });

    async function delegateFromChat(issueId: string): Promise<LinearRun> {
      await createChatLinearDelegation(db, {
        organizationId: orgId,
        threadId,
        linearIssueId: issueId,
      });
      return delegate(issueId);
    }

    it("posts the start, the pull request and the completion to the thread, and nothing else", async () => {
      const issue = linear.add({ identifier: "ENG-140", title: "Fix the login bug" });
      const run = await delegateFromChat(issue.id);

      expect(run).toMatchObject({ origin: "linear", chatThreadId: threadId });
      expect(await db.select().from(chatLinearDelegations)).toEqual([]);
      expect(posted()).toEqual([
        `🚀 Omniralph started building [ENG-140 Fix the login bug](<${issue.url}>). Its progress is in the Linear issue; I'll post here when it opens a pull/merge request and when it finishes.`,
      ]);

      await work(run.id, { commitSha: sha(60) });
      // Story progress stays in Linear.
      expect(posted()).toHaveLength(1);
      await describePr(run.id);

      const pr = (await withPullRequest(run.id))!;
      expect(pr).toMatchObject({ status: "completed", prNumber: 1 });
      const [, opened, finished, ...more] = posted();
      expect(more).toEqual([]);
      expect(opened).toBe(
        `🔗 Pull request #1 for [ENG-140 Fix the login bug](<${issue.url}>) is open: ${pr.prUrl}`,
      );
      expect(finished).toContain("✅ Omniralph finished [ENG-140 Fix the login bug]");
      expect(finished).toContain(`Pull request #1: ${pr.prUrl}`);
      // Recorded in the thread's history as the run's.
      const recorded = await db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.ralphRunId, run.id));
      expect(recorded).toHaveLength(3);
      expect(recorded.every((m) => m.threadId === threadId && m.role === "assistant")).toBe(true);
      // Its notices are posted, not recorded as run events for the responder.
      expect(await db.select().from(chatRunEvents)).toEqual([]);
      // The Linear session still has everything.
      expect(linear.bodies(run.linearAgentSessionId, "response")[0]).toContain(
        "Finished **ENG-140**",
      );
    });

    it("posts the failure to the thread", async () => {
      const issue = linear.add({ identifier: "ENG-141", title: "Doomed" });
      const run = await delegateFromChat(issue.id);
      await updateRepositoryRalphSettings(db, repoId, {
        ralphEnabled: false,
        linearTeamKeys: ["ENG"],
        linearProjectNames: [],
        linearLabels: [],
        ralphSettings: { ...DEFAULT_RALPH_SETTINGS, setupCommand: "pnpm install" },
      });
      try {
        await work(run.id, { jobError: "the agent crashed" });
      } finally {
        await updateRepositoryRalphSettings(db, repoId, {
          ralphEnabled: true,
          linearTeamKeys: ["ENG"],
          linearProjectNames: [],
          linearLabels: [],
          ralphSettings: { ...DEFAULT_RALPH_SETTINGS, setupCommand: "pnpm install" },
        });
      }

      expect((await getRun(db, run.id))?.status).toBe("failed");
      const [started, failed, ...more] = posted();
      expect(started).toContain("🚀 Omniralph started building");
      expect(failed).toContain("⚠️ Omniralph stopped working on [ENG-141 Doomed]");
      expect(failed).toContain("Coding was turned off for `acme/api`");
      expect(more).toEqual([]);
    });

    it("doesn't tie a run delegated in Linear, or a mention, to a thread", async () => {
      const issue = linear.add({ identifier: "ENG-142", title: "Plain" });
      const run = await delegate(issue.id);
      expect(run.chatThreadId).toBeNull();
      expect(posted()).toEqual([]);
    });

    it("ignores a delegation older than an hour, and prunes it", async () => {
      const issue = linear.add({ identifier: "ENG-143", title: "Late" });
      await createChatLinearDelegation(db, {
        organizationId: orgId,
        threadId,
        linearIssueId: issue.id,
      });
      await db
        .update(chatLinearDelegations)
        .set({ createdAt: new Date(Date.now() - 61 * 60 * 1000) });

      const run = await delegate(issue.id);

      expect(run).toMatchObject({ status: "running", chatThreadId: null });
      expect(posted()).toEqual([]);
      expect(await db.select().from(chatLinearDelegations)).toEqual([]);
    });

    it("skips the notifications when the thread is gone, without failing the run", async () => {
      const issue = linear.add({ identifier: "ENG-144", title: "Orphan" });
      const run = await delegateFromChat(issue.id);
      chat = { ...chat!, adapters: {} };
      await work(run.id, { commitSha: sha(61) });
      await describePr(run.id);
      expect((await getRun(db, run.id))?.status).toBe("completed");
      expect(posted()).toHaveLength(1);
    });
  });

  it("the reconcile cron requires the cron secret", async () => {
    const { GET } = await import("@/app/api/cron/ralph-reconcile/route");
    const res = await GET(new Request("http://localhost/api/cron/ralph-reconcile"));
    expect(res.status).toBe(401);
  });
});
