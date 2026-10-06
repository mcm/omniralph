import { randomBytes } from "node:crypto";
import {
  agentRepoPins,
  agents,
  completeJob,
  connectRepository,
  createDb,
  failJob,
  getJob,
  getRun,
  getRunBySession,
  jobs,
  listStories,
  pinRepositoryToAgent,
  ralphRuns,
  runMigrations,
  startJob,
  updateRepositoryRalphSettings,
  updateRun,
  upsertScmConnection,
  DEFAULT_RALPH_SETTINGS,
  type Database,
  type Job,
  type RalphRun,
} from "@omniralph/db";
import {
  MAX_JOB_DELIVERIES,
  RalphDescribePrPayload,
  RalphStoryPayload,
  type RalphDescribePrResult,
  type RalphStoryResult,
} from "@omniralph/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq, inArray } from "drizzle-orm";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { revokeAgent } from "@/lib/agent-auth/revoke";
import { VercelQueuesDispatcher } from "@/lib/dispatch/dispatcher";
import { RecordingPublisher } from "@/lib/dispatch/recording-publisher";
import { handleLinearEvent } from "@/lib/linear/events";
import { FakeLinearGateway } from "@/lib/linear/fake-gateway";
import { FakeScmAdapter } from "@/lib/scm/fake-adapter";
import { onRalphJobFinished, onRalphJobStarted } from "./jobs";
import { FOLLOW_UP_MARK } from "./outcome";
import { reconcileRuns, RECONCILE_STALE_MS } from "./reconcile";
import { advanceRun, MAX_ITERATIONS_PER_RUN } from "./run";
import { AGENT_SESSION_MARKER, startRun, type StartRunDeps } from "./start";

vi.mock("server-only", () => ({}));
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
process.env.CRON_SECRET = "cron-secret";

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

const sha = (n: number) => n.toString(16).padStart(40, "0");

const EPIC_DESCRIPTION = `Build the thing.

## Quality Gates
- \`pnpm test\`
- \`pnpm lint\`
`;

describe.skipIf(!dockerAvailable)("driving the ralph loop from story results", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let repoId: string;
  let gitlabRepoId: string;
  let agentA: string;
  let agentB: string;
  let linear: FakeLinearGateway;
  let publisher: RecordingPublisher;
  let dispatcher: VercelQueuesDispatcher;
  let sessionSeq = 0;

  let scm: FakeScmAdapter;
  const deps = (): StartRunDeps => ({ db, linear, dispatcher, adapterFor: () => scm.asAdapter() });

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
    await updateRepositoryRalphSettings(db, repoId, {
      ralphEnabled: true,
      linearTeamKeys: ["ENG"],
      linearProjectNames: [],
      linearLabels: [],
      ralphSettings: { ...DEFAULT_RALPH_SETTINGS, setupCommand: "pnpm install" },
    });
    const gitlab = await upsertScmConnection(
      db,
      {
        provider: "gitlab",
        name: "gitlab",
        baseUrl: "https://gitlab.example.com",
        externalId: "gitlab.example.com",
        credentials: { token: "t", webhookSecret: "s" },
      },
      randomBytes(32),
    );
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
      linearProjectNames: [],
      linearLabels: [],
      ralphSettings: DEFAULT_RALPH_SETTINGS,
    });
  }, 180_000);

  afterAll(async () => {
    await db?.$client.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await db.delete(jobs);
    await db.delete(ralphRuns);
    await db.delete(agentRepoPins);
    await db.delete(agents);
    [{ id: agentA }, { id: agentB }] = (await db
      .insert(agents)
      .values([
        { name: "agent-a", enabledCapabilities: ["review", "ralph"] },
        { name: "agent-b", enabledCapabilities: ["review", "ralph"] },
      ])
      .returning({ id: agents.id })) as [{ id: string }, { id: string }];
    linear = new FakeLinearGateway();
    scm = new FakeScmAdapter();
    publisher = new RecordingPublisher();
    dispatcher = new VercelQueuesDispatcher({ db, publisher });
  });

  /** Delegates `issueId` and returns its run. */
  async function delegate(issueId: string): Promise<RalphRun> {
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
    return (await getRunBySession(db, sessionId))!;
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

  /**
   * Plays the agent's part for the run's queued job (start, then a result or a
   * failure) through the job lifecycle and its outcome hooks. Returns the payload.
   */
  async function work(
    runId: string,
    outcome: Outcome = {},
    agentId = agentA,
  ): Promise<RalphStoryPayload> {
    const job = await activeJob(runId);
    const started = await startJob(db, {
      jobId: job.id,
      agentId,
      enabledCapabilities: ["ralph"],
      maxDeliveries: MAX_JOB_DELIVERIES,
    });
    expect(started.action).toBe("run");
    expect(await onRalphJobStarted(db, job, agentId)).toEqual({ skip: false });
    if ("jobError" in outcome) {
      await failJob(db, {
        jobId: job.id,
        agentId,
        retryable: false,
        error: outcome.jobError,
        maxDeliveries: MAX_JOB_DELIVERIES,
      });
    } else {
      const status = await completeJob(db, {
        jobId: job.id,
        agentId,
        result: result(outcome),
      });
      expect(status).toEqual({ status: "completed" });
    }
    await onRalphJobFinished(db, (await getJob(db, job.id))!, deps());
    return RalphStoryPayload.parse(job.payload);
  }

  const description = (overrides: Partial<RalphDescribePrResult> = {}): RalphDescribePrResult => ({
    title: "Build the epic",
    body: "Builds it.\n\n**Stories**\n- ENG-2: Alpha\n\n**Verification**\n- `pnpm test`",
    usage: { inputTokens: 5, outputTokens: 5 },
    ...overrides,
  });

  /**
   * Plays the agent's part for the run's queued `ralph.describe-pr` job (a
   * description, or a failure). Returns the payload.
   */
  async function describePr(
    runId: string,
    outcome: Partial<RalphDescribePrResult> | { jobError: string } = {},
    agentId = agentA,
  ): Promise<RalphDescribePrPayload> {
    const job = await activeJob(runId);
    expect(job.type).toBe("ralph.describe-pr");
    await startJob(db, {
      jobId: job.id,
      agentId,
      enabledCapabilities: ["ralph"],
      maxDeliveries: MAX_JOB_DELIVERIES,
    });
    expect(await onRalphJobStarted(db, job, agentId)).toEqual({ skip: false });
    if ("jobError" in outcome) {
      await failJob(db, {
        jobId: job.id,
        agentId,
        retryable: false,
        error: outcome.jobError,
        maxDeliveries: MAX_JOB_DELIVERIES,
      });
    } else {
      await completeJob(db, { jobId: job.id, agentId, result: description(outcome) });
    }
    await onRalphJobFinished(db, (await getJob(db, job.id))!, deps());
    return RalphDescribePrPayload.parse(job.payload);
  }

  const storyStates = async (runId: string) =>
    (await listStories(db, runId)).map((s) => [s.identifier, s.status, s.attempts]);

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
    const beta = linear.add({ identifier: "ENG-3", title: "Beta", parentId: epic.id, priority: 1 });
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
      capability: "ralph",
      type: "ralph.story",
      repositoryId: repoId,
      ralphRunId: run.id,
      topic: "ralph-jobs",
    });
    const payload = RalphStoryPayload.parse(first.payload);
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
    expect(payload.progress).toContain("# Ralph Progress Log");
    expect(payload.stories).toEqual([
      { identifier: "ENG-2", title: "Alpha", status: "open", manual: false, dependsOn: [] },
      { identifier: "ENG-3", title: "Beta", status: "open", manual: false, dependsOn: ["ENG-4"] },
      { identifier: "ENG-4", title: "Gamma", status: "open", manual: false, dependsOn: [] },
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
    expect((await getRun(db, run.id))?.agentId).toBe(agentA);
    const second = await activeJob(run.id);
    expect(second.topic).toBe(`ralph-jobs-agent-${agentA}`);
    const betaPayload = RalphStoryPayload.parse(second.payload);
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
      capability: "ralph",
      type: "ralph.describe-pr",
      topic: `ralph-jobs-agent-${agentA}`,
      ralphRunId: run.id,
    });
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

    const done = (await getRun(db, run.id))!;
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
    expect(publisher.sent).toHaveLength(4);
    expect(linear.bodies(run.linearAgentSessionId, "error")).toEqual([]);
  });

  it("sends the first job to the pinned agent, then sticks to the agent that ran it until it's revoked", async () => {
    await pinRepositoryToAgent(db, { agentId: agentB, repositoryId: repoId });
    const epic = linear.add({ identifier: "ENG-10", title: "Epic" });
    for (const [i, title] of ["One", "Two", "Three"].entries()) {
      linear.add({ identifier: `ENG-1${i + 1}`, title, parentId: epic.id, subIssueSortOrder: i });
    }
    const run = await delegate(epic.id);
    expect((await activeJob(run.id)).topic).toBe(`ralph-jobs-agent-${agentB}`);

    // Agent A happened to take it: the run sticks to A from now on.
    await db.delete(agentRepoPins);
    await work(run.id, {}, agentA);
    const second = await activeJob(run.id);
    expect(second.topic).toBe(`ralph-jobs-agent-${agentA}`);

    // A is revoked while the job waits on its topic: it's published again to `ralph-jobs`.
    await revokeAgent(agentA, { db, dispatcher });
    expect(publisher.sent.at(-1)).toEqual({ topic: "ralph-jobs", jobId: second.id });
    await work(run.id, {}, agentB);
    expect((await getRun(db, run.id))?.agentId).toBe(agentB);
    expect((await activeJob(run.id)).topic).toBe(`ralph-jobs-agent-${agentB}`);
  });

  it("goes back to ralph-jobs when the sticky agent was revoked before the next job", async () => {
    const epic = linear.add({ identifier: "ENG-15", title: "Epic" });
    linear.add({ identifier: "ENG-16", title: "One", parentId: epic.id, subIssueSortOrder: 0 });
    linear.add({ identifier: "ENG-17", title: "Two", parentId: epic.id, subIssueSortOrder: 1 });
    const run = await delegate(epic.id);
    const job = await activeJob(run.id);
    await startJob(db, {
      jobId: job.id,
      agentId: agentA,
      enabledCapabilities: ["ralph"],
      maxDeliveries: MAX_JOB_DELIVERIES,
    });
    await onRalphJobStarted(db, job, agentA);
    await completeJob(db, { jobId: job.id, agentId: agentA, result: result() });
    await db.update(agents).set({ revokedAt: new Date() }).where(eq(agents.id, agentA));
    await onRalphJobFinished(db, (await getJob(db, job.id))!, deps());
    expect((await activeJob(run.id)).topic).toBe("ralph-jobs");
  });

  it("retries a failed attempt with its feedback and completes", async () => {
    const epic = linear.add({ identifier: "ENG-20", title: "Epic", description: EPIC_DESCRIPTION });
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

  it("sets a blocked story aside at once, without retrying", async () => {
    const epic = linear.add({ identifier: "ENG-40", title: "Epic" });
    linear.add({ identifier: "ENG-41", title: "Needs a key", parentId: epic.id });
    const run = await delegate(epic.id);
    await work(run.id, {
      status: "blocked",
      summary: "I need an API key for the payment sandbox.",
    });
    expect(await storyStates(run.id)).toEqual([["ENG-41", "exhausted", 3]]);
    expect(await activeJobs(run.id)).toEqual([]);
    const [error] = linear.bodies(run.linearAgentSessionId, "error");
    expect(error).toContain("**ENG-41** is blocked, so I'm setting it aside without retrying.");
    expect(error).toContain("I need an API key for the payment sandbox.");
    expect((await getRun(db, run.id))?.status).toBe("waiting");
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
        { db, organizationId: "org-1" },
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
      { db, organizationId: "org-1" },
      { linear, dispatcher },
    );
    expect((await work(run.id)).story.identifier).toBe("ENG-73");
    expect(await getRun(db, run.id)).toMatchObject({ status: "completed" });
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
    expect(await getRun(db, run.id)).toMatchObject({ status: "completed", prNumber: 1 });
    expect(await storyStates(run.id)).toEqual([["ENG-80", "completed", 1]]);
    expect(linear.bodies(run.linearAgentSessionId, "response")[0]).toContain(
      `Finished **ENG-80** on \`${issue.branchName}\`. Opened [Pull request #1]`,
    );
  });

  /** A run waiting on an outside blocker that was just completed (without a webhook). */
  async function unblockedWaitingRun(): Promise<RalphRun> {
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
    expect(publisher.sent).toHaveLength(1);
    expect(
      linear.bodies(run.linearAgentSessionId, "thought").filter((t) => t.startsWith("▶️")),
    ).toHaveLength(1);
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

  it("reconciles waiting runs and outcomes that were never applied", async () => {
    const waiting = await unblockedWaitingRun();
    expect(await reconcileRuns(deps())).toEqual({ reconciled: 1, failed: 0 });
    const job = await activeJob(waiting.id);

    // The job completes, but its outcome hook never ran (e.g. the control panel crashed).
    await startJob(db, {
      jobId: job.id,
      agentId: agentA,
      enabledCapabilities: ["ralph"],
      maxDeliveries: MAX_JOB_DELIVERIES,
    });
    await completeJob(db, {
      jobId: job.id,
      agentId: agentA,
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

  describe("the pull/merge request", () => {
    /** A one-story epic whose story is done: the run is describing its PR/MR. */
    async function finishedRun(teamKey = "ENG"): Promise<RalphRun> {
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
      return (await getRun(db, run.id))!;
    }

    const reply = (run: RalphRun, body: string) =>
      handleLinearEvent(
        { kind: "session_prompted", sessionId: run.linearAgentSessionId, body },
        { db, organizationId: "org-1" },
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
      expect(await getRun(db, run.id)).toMatchObject({
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
      expect(await getRun(db, run.id)).toMatchObject({
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
        expect(await getRun(db, run.id)).toMatchObject({
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
        expect(await getRun(db, run.id)).toMatchObject({ status: "completed", prNumber: 1 });
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

    it("waits with an error when the describe job fails, and a reply retries the PR step", async () => {
      const run = await finishedRun();
      await describePr(run.id, { jobError: "the session ended without a valid title and body" });
      const waiting = (await getRun(db, run.id))!;
      expect(waiting).toMatchObject({
        status: "waiting",
        prJobId: null,
        prNumber: null,
        waitingOn: { blockers: [], manual: [] },
      });
      expect(waiting.error).toContain("the session ended without a valid title and body");
      const [error] = linear.bodies(run.linearAgentSessionId, "error");
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
      expect(await getRun(db, run.id)).toMatchObject({
        status: "completed",
        prNumber: 1,
        error: null,
      });
    });

    it("waits with an error when opening the pull request fails", async () => {
      scm.failures.set("createChangeRequest", "Resource not accessible by integration");
      const run = await finishedRun();
      await describePr(run.id);
      expect(await getRun(db, run.id)).toMatchObject({ status: "waiting", prNumber: null });
      expect(linear.bodies(run.linearAgentSessionId, "error")[0]).toContain(
        "couldn't open the pull request: Resource not accessible by integration.",
      );

      scm.failures.clear();
      await reply(run, "I fixed the app permissions");
      await describePr(run.id);
      expect(await getRun(db, run.id)).toMatchObject({ status: "completed", prNumber: 1 });
      expect(scm.changeRequests).toHaveLength(1);
    });

    it("completes without a pull request when no story committed anything", async () => {
      const issue = linear.add({ identifier: "ENG-120", title: "Nothing to change" });
      const run = await delegate(issue.id);
      await work(run.id, {});
      expect(await getRun(db, run.id)).toMatchObject({ status: "completed", prNumber: null });
      expect(await activeJobs(run.id)).toEqual([]);
      expect(linear.bodies(run.linearAgentSessionId, "response")[0]).toContain(
        "Nothing was committed",
      );
    });
  });

  it("the reconcile cron requires the cron secret", async () => {
    const { GET } = await import("@/app/api/cron/ralph-reconcile/route");
    const res = await GET(new Request("http://localhost/api/cron/ralph-reconcile"));
    expect(res.status).toBe(401);
  });
});
