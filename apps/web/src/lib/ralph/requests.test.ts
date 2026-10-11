import { randomBytes } from "node:crypto";
import {
  harnesses,
  completeJob,
  connectRepository,
  closeDb,
  createDb,
  ensureLane,
  failJob,
  getJob,
  getMainLane,
  getRun,
  getRunBySession,
  insertMessage,
  jobs,
  listLanes,
  listMessages,
  listPendingRequests,
  ralphRuns,
  runMigrations,
  claimJob,
  updateRepositoryRalphSettings,
  upsertScmConnection,
  DEFAULT_RALPH_SETTINGS,
  type Database,
  type Job,
  organizations,
  seedReviewProfiles,
  type LinearRun,
} from "@omniralph/db";
import {
  MAX_JOB_DELIVERIES,
  RalphRequestPayload,
  RalphStoryPayload,
  type RalphRequestResult,
  type RalphStoryResult,
} from "@omniralph/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq, inArray } from "drizzle-orm";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { revokeHarness } from "@/lib/harness-auth/revoke";
import { PostgresDispatcher } from "@/lib/dispatch/dispatcher";
import { FakeLinearGateway, linearRun } from "@/lib/linear/fake-gateway";
import { FakeScmAdapter } from "@/lib/scm/fake-adapter";
import { onRalphJobFinished, onRalphJobStarted } from "./jobs";
import {
  DELIVERED_NOTE,
  exchangeJobMessages,
  undeliveredNote,
  type JobMessageAcks,
} from "./messages";
import { handleReply } from "./reply";
import { NOTHING_TO_DO, PASSED_TO_RUNNING_JOB } from "./requests";
import { AGENT_SESSION_MARKER, startRun, type StartRunDeps, type StartOutcome } from "./start";

vi.mock("server-only", () => ({}));
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

const sha = (n: number) => n.toString(16).padStart(40, "0");

const EPIC_DESCRIPTION = `Build the thing.

## Quality Gates
- \`pnpm test\`
`;

describe.skipIf(!dockerAvailable)("request mode (mentions and requests)", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let orgId: string;
  let repoId: string;
  let gitlabRepoId: string;
  let agentA: string;
  let agentB: string;
  let linear: FakeLinearGateway;
  let dispatcher: PostgresDispatcher;
  let scm: FakeScmAdapter;
  let sessionSeq = 0;

  const deps = (): StartRunDeps => ({
    db,
    organizationId: orgId,
    linear,
    dispatcher,
    adapterFor: () => scm.asAdapter(),
  });

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
    await updateRepositoryRalphSettings(db, repoId, {
      ralphEnabled: true,
      linearTeamKeys: ["ENG"],
      linearProjectNames: [],
      linearLabels: [],
      ralphSettings: DEFAULT_RALPH_SETTINGS,
    });
    gitlabRepoId = (
      await connectRepository(db, {
        connectionId: connection.id,
        provider: "github",
        externalId: "2",
        fullPath: "acme/web",
      })
    ).id;
    await updateRepositoryRalphSettings(db, gitlabRepoId, {
      ralphEnabled: true,
      linearTeamKeys: [],
      linearProjectNames: ["Web"],
      linearLabels: [],
      ralphSettings: DEFAULT_RALPH_SETTINGS,
    });
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await container?.stop();
  });

  beforeEach(async () => {
    await db.delete(jobs);
    await db.delete(ralphRuns);
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
    await updateRepositoryRalphSettings(db, repoId, {
      ralphEnabled: true,
      linearTeamKeys: ["ENG"],
      linearProjectNames: [],
      linearLabels: [],
      ralphSettings: DEFAULT_RALPH_SETTINGS,
    });
    linear = new FakeLinearGateway();
    scm = new FakeScmAdapter();
    dispatcher = new PostgresDispatcher({ db });
  });

  /** A new agent session on `issueId`: a delegation, or a mention with `body`. */
  async function session(
    issueId: string,
    body?: string,
  ): Promise<{ outcome: StartOutcome; sessionId: string; run: LinearRun | null }> {
    sessionSeq += 1;
    const sessionId = `session-${sessionSeq}`;
    const outcome = await startRun(
      {
        kind: "session_created",
        sessionId,
        issueId,
        commentBody: body ?? `${AGENT_SESSION_MARKER}.`,
        creatorName: "Steve",
      },
      deps(),
    );
    const run = await getRunBySession(db, sessionId);
    return { outcome, sessionId, run: run && linearRun(run) };
  }

  const reply = (run: LinearRun, body: string) =>
    handleReply(
      { kind: "session_prompted", sessionId: run.linearAgentSessionId, body, authorName: "Steve" },
      deps(),
    );

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

  async function start(runId: string, harnessId = agentA): Promise<Job> {
    const job = await activeJob(runId);
    const started = await claimJob(db, {
      organizationId: orgId,
      harnessId,
      acceptedTaskTypes: ["query", "coding"],
      pools: ["short", "long"],
      harnessVersion: null,
      maxDeliveries: MAX_JOB_DELIVERIES,
    });
    expect(started.claim?.job.id).toBe(job.id);
    expect(await onRalphJobStarted(db, job, harnessId)).toEqual({ skip: false });
    return job;
  }

  async function finish(
    job: Job,
    outcome: Record<string, unknown> | { jobError: string },
    harnessId = agentA,
  ): Promise<void> {
    if ("jobError" in outcome) {
      await failJob(db, {
        jobId: job.id,
        harnessId,
        retryable: false,
        error: String(outcome.jobError),
        maxDeliveries: MAX_JOB_DELIVERIES,
      });
    } else {
      expect(await completeJob(db, { jobId: job.id, harnessId, result: outcome })).toEqual({
        status: "completed",
      });
    }
    await onRalphJobFinished(db, (await getJob(db, job.id))!, deps());
  }

  const storyResult = (overrides: Partial<RalphStoryResult> = {}): RalphStoryResult => ({
    status: "complete",
    summary: "Did the work.",
    followUps: [],
    feedback: null,
    usage: { inputTokens: 1, outputTokens: 1 },
    durationMs: 10,
    ...overrides,
  });

  /** Plays the run's queued story job. Returns its payload. */
  async function work(
    runId: string,
    outcome: Partial<RalphStoryResult> = {},
  ): Promise<RalphStoryPayload> {
    const job = await start(runId);
    expect(job.type).toBe("ralph.story");
    await finish(job, storyResult(outcome));
    return RalphStoryPayload.parse(job.payload);
  }

  /** Plays the run's queued describe job. */
  async function describePr(runId: string): Promise<void> {
    const job = await start(runId);
    expect(job.type).toBe("ralph.describe-pr");
    await finish(job, {
      title: "Build the epic",
      body: "Builds it.",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  }

  const requestResult = (overrides: Partial<RalphRequestResult> = {}): RalphRequestResult => ({
    summary: "Done as asked.",
    error: null,
    sessionId: "claude-req-1",
    usage: { inputTokens: 1, outputTokens: 1 },
    durationMs: 10,
    ...overrides,
  });

  /** Plays the run's queued `ralph.request` job. Returns its payload. */
  async function request(
    runId: string,
    outcome: Partial<RalphRequestResult> | { jobError: string } = {},
    harnessId = agentA,
  ): Promise<RalphRequestPayload> {
    const job = await start(runId, harnessId);
    expect(job.type).toBe("ralph.request");
    await finish(job, "jobError" in outcome ? outcome : requestResult(outcome), harnessId);
    return RalphRequestPayload.parse(job.payload);
  }

  const last = (sessionId: string, type: "thought" | "response" | "elicitation" | "error") =>
    linear.bodies(sessionId, type).at(-1) ?? "";

  function threeStoryEpic() {
    const epic = linear.add({ identifier: "ENG-1", title: "Epic", description: EPIC_DESCRIPTION });
    const s1 = linear.add({ identifier: "ENG-2", title: "Alpha", parentId: epic.id, priority: 1 });
    const s2 = linear.add({ identifier: "ENG-3", title: "Beta", parentId: epic.id, priority: 2 });
    const s3 = linear.add({ identifier: "ENG-4", title: "Gamma", parentId: epic.id, priority: 3 });
    return { epic, s1, s2, s3 };
  }

  describe("/ship", () => {
    it("ships a mention's work with a request job that commits, pushes and opens the PR/MR", async () => {
      const { epic } = threeStoryEpic();
      const { sessionId, run } = await session(epic.id, "@omniralph fix the typo in the README");
      await request(run!.id, {
        summary: "Fixed it, but the repository's settings stopped my commit.",
      });

      expect(await reply(run!, "/ship")).toMatchObject({ kind: "ship" });
      const payload = await request(run!.id, {
        summary: "Committing the README fix.",
        commitSha: "7".repeat(40),
        pushed: true,
        pullRequest: { action: "open", title: "Fix the README typo" },
      });
      expect(payload.ship).toBe(true);
      expect(payload.requests.map((r) => r.text)).toEqual([
        "Commit the work on the branch, push it, and open the pull/merge request if there isn't one.",
      ]);
      expect(scm.changeRequests).toHaveLength(1);
      const said = last(sessionId, "response");
      expect(said).toContain("Committing the README fix.");
      expect(said).toContain(`Committed \`7777777777\` and pushed \`${payload.branch}\`.`);
    });

    it("a `/ship` mention starts a ship job straight away", async () => {
      const { epic } = threeStoryEpic();
      const { run } = await session(epic.id, "@omniralph /ship with a changelog entry");
      const payload = await request(run!.id);
      expect(payload.ship).toBe(true);
      expect(payload.requests.map((r) => r.text)).toEqual(["with a changelog entry"]);
    });

    it("an ordinary request isn't a ship job", async () => {
      const { epic } = threeStoryEpic();
      const { run } = await session(epic.id, "@omniralph what's left?");
      expect((await request(run!.id)).ship).toBe(false);
    });
  });

  describe("mentions (Cyrus semantics)", () => {
    it("a mention only does what it asks, even with stories left (no story loop, no Linear changes)", async () => {
      const { epic } = threeStoryEpic();
      const { outcome, sessionId, run } = await session(
        epic.id,
        "@omniralph what's left on this epic?",
      );
      expect(outcome).toMatchObject({ status: "started", created: true });
      expect(run).toMatchObject({ mode: "request", status: "running" });

      const payload = await request(run!.id, {
        summary: "The epic has 3 open stories; ENG-2 is next.",
      });
      expect(payload.requests.map((r) => r.text)).toEqual(["what's left on this epic?"]);
      expect(payload.stories.map((s) => [s.identifier, s.status])).toEqual([
        ["ENG-2", "open"],
        ["ENG-3", "open"],
        ["ENG-4", "open"],
      ]);
      expect(payload).toMatchObject({
        branch: expect.any(String),
        baseBranch: "develop",
        prUrl: null,
        qualityGates: ["pnpm test"],
        historyRewrite: "when-asked",
        resumeSessionId: null,
      });
      expect(last(sessionId, "thought")).toBe("Working on your request.");

      expect(await getRun(db, run!.id)).toMatchObject({ status: "completed", requestOutput: null });
      expect(last(sessionId, "response")).toBe("The epic has 3 open stories; ENG-2 is next.");
      // No story loop, no Linear changes, no PR.
      expect(
        (await db.select().from(jobs).where(eq(jobs.ralphRunId, run!.id))).map((j) => j.type),
      ).toEqual(["ralph.request"]);
      expect(linear.stateChanges).toEqual([]);
      expect(scm.changeRequests).toEqual([]);
      expect(await listPendingRequests(db, run!.id)).toEqual([]);
    });

    it("`/ralph` in a mention opts into the story loop, with the rest of the comment as guidance", async () => {
      const { epic } = threeStoryEpic();
      const { run } = await session(epic.id, "@omniralph /ralph use the existing Priority enum");
      expect(run?.mode).toBe("epic");
      const first = await work(run!.id, { commitSha: sha(1) });
      expect(first.story.identifier).toBe("ENG-2");
      expect(first.guidance).toEqual(["use the existing Priority enum"]);
      // The first story took it, so no request session runs for it.
      expect(await listPendingRequests(db, run!.id)).toEqual([]);
      expect((await work(run!.id, { commitSha: sha(2) })).story.identifier).toBe("ENG-3");
      expect((await work(run!.id, { commitSha: sha(3) })).story.identifier).toBe("ENG-4");
      await describePr(run!.id);
      expect((await getRun(db, run!.id))?.status).toBe("completed");
      expect(linear.stateChanges.some((c) => c.issueId === epic.id)).toBe(true);
    });

    it("push + PR on a finished epic (the MOD-50 case): the control panel opens the draft the agent asks for", async () => {
      const { epic } = threeStoryEpic();
      const delegated = (await session(epic.id)).run!;
      for (let i = 0; i < 3; i++) await work(delegated.id);
      expect((await getRun(db, delegated.id))?.status).toBe("completed");
      expect(scm.changeRequests).toEqual([]);

      const { sessionId, run } = await session(
        epic.id,
        "@omniralph there is now a git remote, can you push and create a PR?",
      );
      const mainBranch = (await getMainLane(db, delegated))!.branch;
      // The new run carries the earlier one's branch over.
      expect((await getMainLane(db, run!))?.branch).toBe(mainBranch);
      const payload = await request(run!.id, {
        summary: "Pushed the branch and opened the pull request.",
        pullRequest: {
          action: "open",
          title: "Add task priorities",
          body: "Adds priorities. <img src=x onerror=alert(1)>",
        },
      });
      expect(payload.requests.map((r) => r.text)).toEqual([
        "there is now a git remote, can you push and create a PR?",
      ]);
      expect(payload.stories.every((s) => s.status === "completed")).toBe(true);

      expect(scm.changeRequests).toHaveLength(1);
      const [pr] = scm.changeRequests;
      expect(pr).toMatchObject({
        sourceBranch: mainBranch,
        targetBranch: "develop",
        title: "Add task priorities",
        draft: true,
      });
      expect(pr!.body).not.toContain("<img");
      expect(pr!.body).toContain("Linear: [ENG-1]");
      expect(await getMainLane(db, run!)).toMatchObject({ prNumber: 1, prUrl: pr!.url });
      expect(linear.urls.at(-1)).toMatchObject({ sessionId, url: pr!.url });
      expect(last(sessionId, "response")).toBe(
        `Pushed the branch and opened the pull request.\n\nPull request #1: ${pr!.url}`,
      );
    });

    it("updates the lane's PR and marks it ready, adopting the one open for the branch", async () => {
      const { epic } = threeStoryEpic();
      const { run } = await session(epic.id, "@omniralph tidy the PR and mark it ready");
      const lane = (await getMainLane(db, run!))!;
      await scm.createChangeRequest(
        { fullPath: "acme/api", externalId: "1" },
        {
          sourceBranch: lane.branch,
          targetBranch: "develop",
          title: "Old",
          body: "Old",
          draft: true,
        },
      );
      await request(run!.id, {
        summary: "Tidied it.",
        pullRequest: { action: "update", title: "New title" },
      });
      expect(scm.changeRequests[0]).toMatchObject({ title: "New title", body: "Old", draft: true });
      expect(await getMainLane(db, run!)).toMatchObject({ prNumber: 1 });

      await reply(run!, "mark it ready");
      await request(run!.id, { summary: "Marked it ready.", pullRequest: { action: "ready" } });
      expect(scm.changeRequests[0]?.draft).toBe(false);
    });

    it("says what went wrong when a PR/MR change fails, and adopts a PR someone opened", async () => {
      const { epic } = threeStoryEpic();
      const { sessionId, run } = await session(epic.id, "@omniralph mark the PR ready");
      await request(run!.id, { summary: "Asked.", pullRequest: { action: "ready" } });
      const branch = (await getMainLane(db, run!))!.branch;
      expect(last(sessionId, "response")).toBe(
        `Asked.\n\nThere's no open pull request for \`${branch}\` to mark ready.`,
      );

      await scm.createChangeRequest(
        { fullPath: "acme/api", externalId: "1" },
        { sourceBranch: branch, targetBranch: "develop", title: "T", body: "B", draft: true },
      );
      scm.failures.set("markChangeRequestReady", "forbidden");
      await reply(run!, "try again");
      await request(run!.id, { summary: "Asked again.", pullRequest: { action: "ready" } });
      expect(last(sessionId, "response")).toContain(
        "I couldn't mark ready the pull request: forbidden",
      );
      expect(await getMainLane(db, run!)).toMatchObject({ prNumber: 1 });
    });

    it("follow-up replies to a mention resume the same Claude conversation (on the same agent)", async () => {
      const { epic } = threeStoryEpic();
      const { run } = await session(epic.id, "@omniralph summarise the PRD");
      expect((await request(run!.id)).resumeSessionId).toBeNull();
      expect(await getMainLane(db, run!)).toMatchObject({
        requestClaudeSessionId: "claude-req-1",
        requestHarnessId: agentA,
      });

      expect((await reply(run!, "Shorter please"))?.kind).toBe("request");
      const second = await request(run!.id, { sessionId: "claude-req-2" });
      expect(second.resumeSessionId).toBe("claude-req-1");
      expect(second.requests.map((r) => r.text)).toEqual(["Shorter please"]);
      expect(await getMainLane(db, run!)).toMatchObject({ requestClaudeSessionId: "claude-req-2" });

      // Another agent doesn't have the session's files: it starts fresh.
      await revokeHarness(agentA, { db, dispatcher });
      await reply(run!, "And in French");
      expect((await request(run!.id, {}, agentB)).resumeSessionId).toBeNull();
      expect(await getMainLane(db, run!)).toMatchObject({ requestHarnessId: agentB });
      expect(
        (await db.select().from(jobs).where(eq(jobs.ralphRunId, run!.id))).every(
          (j) => j.type === "ralph.request",
        ),
      ).toBe(true);
    });

    it("mentions ignore blockers (they aren't story work)", async () => {
      const outside = linear.add({ identifier: "OPS-2", title: "Design review", teamKey: "OPS" });
      const { epic } = threeStoryEpic();
      await linear.createBlocksRelation(outside.id, epic.id);
      const { run } = await session(epic.id, "@omniralph what does ENG-3 need?");
      await request(run!.id);
      expect((await getRun(db, run!.id))?.status).toBe("completed");
    });

    it("a bare mention with no instruction does nothing", async () => {
      const { epic } = threeStoryEpic();
      const { outcome, sessionId, run } = await session(epic.id, "@omniralph");
      expect(outcome).toEqual({ status: "nothing" });
      expect(run).toBeNull();
      expect(last(sessionId, "response")).toBe(NOTHING_TO_DO);
    });

    it("hands a mention to the job that is running on the issue right now", async () => {
      const { epic } = threeStoryEpic();
      const delegated = (await session(epic.id)).run!;
      const job = await start(delegated.id);

      const { outcome, sessionId, run } = await session(epic.id, "@omniralph how is it going?");
      expect(outcome).toMatchObject({ status: "delivered", live: true });
      expect(run).toBeNull();
      expect(linear.bodies(sessionId, "response")).toEqual([PASSED_TO_RUNNING_JOB]);
      expect(
        await exchangeJobMessages({ db, linear: async () => linear }, agentA, [job.id], {
          deliveredMessageIds: [],
          rejectedMessageIds: [],
        }),
      ).toEqual([{ jobId: job.id, messageId: expect.any(String), text: "how is it going?" }]);
    });

    it("passes replies to a running request's live session; one it rejects or never takes runs as the next request", async () => {
      const { epic } = threeStoryEpic();
      const { sessionId, run } = await session(epic.id, "@omniralph summarise the PRD");
      const job = await start(run!.id);
      const exchange = (acks: JobMessageAcks) =>
        exchangeJobMessages({ db, linear: async () => linear }, agentA, [job.id], acks);

      expect(await reply(run!, "in French")).toEqual({ kind: "live" });
      const [french] = await exchange({ deliveredMessageIds: [], rejectedMessageIds: [] });
      expect(french).toMatchObject({ jobId: job.id, text: "in French" });

      await reply(run!, "and in German");
      const sent = await exchange({
        deliveredMessageIds: [french!.messageId],
        rejectedMessageIds: [],
      });
      expect(last(sessionId, "thought")).toBe(DELIVERED_NOTE);
      expect(sent.map((m) => m.text)).toEqual(["and in German"]);
      // The agent couldn't inject it (e.g. the session had ended): a pending request.
      expect(
        await exchange({ deliveredMessageIds: [], rejectedMessageIds: [sent[0]!.messageId] }),
      ).toEqual([]);
      expect(last(sessionId, "thought")).toBe(undeliveredNote("request"));
      expect((await listPendingRequests(db, run!.id)).map((m) => m.text)).toContain(
        "and in German",
      );
      // Still undelivered when the job ends: settled as a request when the run moves on.
      await reply(run!, "and in Spanish");
      await finish(job, requestResult({ summary: "Résumé en français." }));
      const next = await request(run!.id, { summary: "Also in German and Spanish." });
      expect(next.requests.map((r) => r.text)).toEqual(["and in German", "and in Spanish"]);
      expect(next.resumeSessionId).toBe("claude-req-1");
      expect(await listPendingRequests(db, run!.id)).toEqual([]);
      expect((await getRun(db, run!.id))?.status).toBe("completed");
    });

    it("asks which repository when a mention matches none, then answers in the picked one (by URL)", async () => {
      linear.add({ identifier: "OPS-1", title: "Infra", teamKey: "OPS" });
      const issue = [...linear.issues.values()].find((i) => i.identifier === "OPS-1")!;
      const { outcome, sessionId, run } = await session(issue.id, "@omniralph what's this about?");
      expect(outcome).toMatchObject({ status: "selecting" });
      expect(run).toMatchObject({ mode: "request", status: "waiting", repositoryId: null });
      expect(last(sessionId, "elicitation")).toContain(
        "Which repository should I work in for this issue?",
      );
      expect(await db.select().from(jobs).where(eq(jobs.ralphRunId, run!.id))).toEqual([]);

      expect(await reply(run!, "https://github.com/acme/web")).toMatchObject({
        kind: "repository_selection",
        advanced: { action: "requesting" },
      });
      const payload = await request(run!.id, { summary: "It's about infra." });
      expect(payload.repository.fullPath).toBe("acme/web");
      expect(payload.requests.map((r) => r.text)).toEqual(["what's this about?"]);
      expect(last(sessionId, "response")).toBe("It's about infra.");
      // Request mode: no Linear state changes.
      expect(linear.stateChanges).toEqual([]);
    });

    it("adds a mention to the issue's run when it is waiting, and that session answers", async () => {
      const outside = linear.add({ identifier: "OPS-2", title: "Design review", teamKey: "OPS" });
      const { epic } = threeStoryEpic();
      await linear.createBlocksRelation(outside.id, epic.id);
      const delegated = (await session(epic.id)).run!;
      expect((await getRun(db, delegated.id))?.status).toBe("waiting");

      const { outcome, sessionId } = await session(epic.id, "@omniralph summarise the plan");
      expect(outcome).toMatchObject({ status: "delivered", live: false });
      expect(last(sessionId, "response")).toContain(
        "Added this to the run that's already working on **ENG-1**",
      );
      await request(delegated.id, { summary: "Here's the plan." });
      expect(last(delegated.linearAgentSessionId, "thought")).toBe("Here's the plan.");
      expect((await getRun(db, delegated.id))?.status).toBe("waiting");
    });

    it("`/ralph` in a reply switches a mention's run to the epic loop, its requests becoming guidance", async () => {
      const { epic } = threeStoryEpic();
      const { run } = await session(epic.id, "@omniralph use smallint everywhere");
      await request(run!.id);
      expect((await getRun(db, run!.id))?.status).toBe("completed");

      await reply(run!, "/ralph");
      expect(await getRun(db, run!.id)).toMatchObject({ mode: "epic", status: "running" });
      const first = await work(run!.id);
      expect(first.story.identifier).toBe("ENG-2");
    });

    it("`/ralph` doesn't switch a mention's run to the epic loop while the PRD has open questions", async () => {
      const { epic } = threeStoryEpic();
      const root = linear.issues.get(epic.id)!;
      root.description = `${EPIC_DESCRIPTION}\n## Open Questions\n\n1. Which column type?\n`;
      const { run } = await session(epic.id, "@omniralph use smallint everywhere");
      expect(run).toMatchObject({ mode: "request" });

      // A `/ralph` mention handed to the running mention's run.
      const mention = await session(epic.id, "@omniralph /ralph go");
      expect(mention.outcome).toEqual({ status: "open_questions", identifier: "ENG-1" });
      expect(last(mention.sessionId, "response")).toContain("still has open questions");
      expect(await getRun(db, run!.id)).toMatchObject({ mode: "request" });

      await request(run!.id);
      expect(await reply(run!, "/ralph")).toEqual({ kind: "open_questions" });
      expect(await getRun(db, run!.id)).toMatchObject({ mode: "request", status: "completed" });
      expect(last(run!.linearAgentSessionId, "response")).toContain("Then reply `/ralph` again.");
      expect(await activeJobs(run!.id)).toEqual([]);

      // Linear can't be read: refused too.
      linear.failures.set("getIssue", new Error("timed out"));
      expect(await reply(run!, "/ralph")).toEqual({ kind: "open_questions" });
      linear.failures.delete("getIssue");
      expect(last(run!.linearAgentSessionId, "error")).toContain(
        "I couldn't check the issue for open questions in Linear, so I didn't start: timed out.",
      );
      expect(await getRun(db, run!.id)).toMatchObject({ mode: "request", status: "completed" });

      // Answered: `/ralph` starts the loop.
      root.description = EPIC_DESCRIPTION;
      await reply(run!, "/ralph");
      expect(await getRun(db, run!.id)).toMatchObject({ mode: "epic", status: "running" });
    });
  });

  describe("replies as requests", () => {
    it("a reply on a finished delegated session runs as a direct request", async () => {
      const { epic } = threeStoryEpic();
      const run = (await session(epic.id)).run!;
      for (let i = 0; i < 3; i++) await work(run.id, { commitSha: sha(i + 1) });
      await describePr(run.id);
      expect((await getRun(db, run.id))?.status).toBe("completed");

      await reply(run, "Add a CHANGELOG entry for this epic");
      const payload = await request(run.id, { summary: "Added the entry." });
      expect(payload.requests.map((r) => r.text)).toEqual(["Add a CHANGELOG entry for this epic"]);
      expect(payload.prUrl).toBe(scm.changeRequests[0]?.url);
      expect((await getRun(db, run.id))?.status).toBe("completed");
      expect(last(run.linearAgentSessionId, "response")).toBe(
        `Added the entry.\n\nPull request #1: ${scm.changeRequests[0]?.url}`,
      );
    });

    it("a reply on a parked (blocked) epic runs as a request and the run stays parked", async () => {
      const outside = linear.add({ identifier: "OPS-9", title: "Design review", teamKey: "OPS" });
      const { epic } = threeStoryEpic();
      await linear.createBlocksRelation(outside.id, epic.id);
      const run = (await session(epic.id)).run!;
      expect((await getRun(db, run.id))?.status).toBe("waiting");

      await reply(run, "summarise the plan in the PR description");
      await request(run.id, { summary: "Summarised it." });
      expect(
        (await db.select().from(jobs).where(eq(jobs.ralphRunId, run.id))).map((j) => j.type),
      ).toEqual(["ralph.request"]);
      expect((await getRun(db, run.id))?.status).toBe("waiting");
      expect(last(run.linearAgentSessionId, "thought")).toBe("Summarised it.");
      expect(last(run.linearAgentSessionId, "elicitation")).toContain("is blocked on **OPS-9**");
    });

    it("keeps push/MR requests away from the story agents and runs them once the stories are done", async () => {
      const { epic } = threeStoryEpic();
      const run = (await session(epic.id)).run!;
      await start(run.id);
      expect((await reply(run, "Please push and open an MR"))?.kind).toBe("request");
      const job = (await activeJob(run.id))!;
      await finish(job, storyResult({ commitSha: sha(1) }));
      // Not story guidance (story agents may not push), but a direct request once the stories are done.
      expect((await work(run.id, { commitSha: sha(2) })).guidance).toEqual([]);
      await work(run.id, { commitSha: sha(3) });
      const payload = await request(run.id, { summary: "Pushed." });
      expect(payload.requests.map((r) => r.text)).toEqual(["Please push and open an MR"]);
      await describePr(run.id);
      expect((await getRun(db, run.id))?.status).toBe("completed");
      expect(last(run.linearAgentSessionId, "response")).toBe(
        `Pushed.\n\nPull request #1: ${scm.changeRequests[0]?.url}`,
      );
      expect(await listPendingRequests(db, run.id)).toEqual([]);
    });

    it("runs each lane's requests in that lane, main lane first, prefixed by repository", async () => {
      const { epic } = threeStoryEpic();
      const { run } = await session(epic.id, "@omniralph rename the badge");
      const main = (await getMainLane(db, run!))!;
      const web = await ensureLane(db, {
        runId: run!.id,
        repositoryId: gitlabRepoId,
        branch: main.branch,
        baseBranch: "main",
      });
      await insertMessage(db, { runId: run!.id, laneId: web.id, kind: "request", text: "fix CI" });

      const first = await request(run!.id, { summary: "Renamed it." });
      expect([first.repositoryId, first.requests.map((r) => r.text)]).toEqual([
        repoId,
        ["rename the badge"],
      ]);
      const second = await request(run!.id, { summary: "Fixed CI." });
      expect([second.repositoryId, second.baseBranch, second.requests.map((r) => r.text)]).toEqual([
        gitlabRepoId,
        "main",
        ["fix CI"],
      ]);
      expect(last(run!.linearAgentSessionId, "response")).toBe(
        "**acme/api**: Renamed it.\n\n**acme/web**: Fixed CI.",
      );
      expect((await listLanes(db, run!.id)).find((l) => l.id === web.id)).toMatchObject({
        requestClaudeSessionId: "claude-req-1",
      });
    });

    it("records and reports what the session stashed, and an error", async () => {
      const { epic } = threeStoryEpic();
      const { run, sessionId } = await session(epic.id, "@omniralph rename the badge component");
      await request(run!.id, {
        summary: "Got halfway.",
        error: "the session failed: overloaded",
        stashSha: sha(77),
      });
      expect(last(sessionId, "response")).toBe(
        "I ran into an error working on your request: the session failed: overloaded.\n\nGot halfway.\n\n" +
          `The session left uncommitted changes, which I stashed as \`${sha(77).slice(0, 10)}\`.`,
      );
      expect((await getMainLane(db, run!))?.stashes).toEqual([
        { sha: sha(77), reason: "request", at: expect.any(String) },
      ]);
    });

    it("keeps a stopped request pending and runs it again on the next reply", async () => {
      const { epic } = threeStoryEpic();
      const { run } = await session(epic.id, "@omniralph rebase onto main");
      const job = await start(run!.id);
      await reply(run!, "stop");
      await finish(job, { jobError: "canceled" });
      expect((await getRun(db, run!.id))?.status).toBe("stopped");
      expect((await listPendingRequests(db, run!.id)).map((r) => r.text)).toEqual([
        "rebase onto main",
      ]);

      await reply(run!, "go on");
      expect((await listPendingRequests(db, run!.id)).map((r) => r.trigger)).toEqual([
        "linear.mention",
        "linear.mention",
      ]);
      const payload = await request(run!.id);
      expect(payload.requests.map((r) => r.text)).toEqual(["rebase onto main", "go on"]);
      expect((await listMessages(db, run!.id)).every((m) => m.consumedAt !== null)).toBe(true);
    });

    it("follows the repository's historyRewrite setting", async () => {
      await updateRepositoryRalphSettings(db, repoId, {
        ralphEnabled: true,
        linearTeamKeys: ["ENG"],
        linearProjectNames: [],
        linearLabels: [],
        ralphSettings: { ...DEFAULT_RALPH_SETTINGS, historyRewrite: "never" },
      });
      const { epic } = threeStoryEpic();
      const { run } = await session(epic.id, "@omniralph rebase onto main");
      expect((await request(run!.id)).historyRewrite).toBe("never");
    });
  });

  describe("Linear attachments", () => {
    const UP = "https://uploads.linear.app/9aa27def/d172798b";
    const titles = (payload: { attachments: { title: string | null; sources: string[] }[] }) =>
      payload.attachments.map((a) => `${a.title} (from ${a.sources.join(", ")})`);

    it("lists an image-only issue's upload (signature stripped) and remembers it for the download", async () => {
      const issue = linear.add({
        identifier: "ENG-32",
        title: "Static renders from multiple angles",
        description: `\n<linear-image>{"type":"image","attrs":{"src":"${UP}/365d683b?signature=eyJhbGciOi.abc.def","title":"pavilion_contact_sheet.png","width":1440,"height":1894}}</linear-image>`,
      });
      const { run } = await session(issue.id);
      expect(run?.kind).toBe("single");
      const payload = await work(run!.id);
      expect(payload.attachments).toEqual([
        {
          id: expect.stringMatching(/^[0-9a-f]{32}$/),
          title: "pavilion_contact_sheet.png",
          sources: ["ENG-32 description"],
        },
      ]);
      const stored = await getRun(db, run!.id);
      expect(stored?.attachments).toEqual({
        [payload.attachments[0]!.id]: {
          url: `${UP}/365d683b`,
          title: "pavilion_contact_sheet.png",
        },
      });
    });

    it("scopes story images to their story, shares epic/thread images, and reads comments", async () => {
      const { epic, s2, s3 } = threeStoryEpic();
      linear.issues.get(epic.id)!.description += `\n\n![architecture.png](${UP}/arch)`;
      linear.issues.get(s2.id)!.description = `Beta.\n\n![badge mockup](${UP}/badge?signature=x)`;
      linear.commentsByIssue.set(epic.id, [
        { body: `Colour reference: ${UP}/palette`, author: "Ana" },
      ]);
      linear.commentsByIssue.set(s3.id, [{ body: `Like [this](${UP}/gamma)`, author: "Bo" }]);
      const { run } = await session(epic.id);
      await reply(run!, `Also see ![flow.png](${UP}/flow)`);

      const byStory = new Map<string, string[]>();
      for (let i = 0; i < 3; i++) {
        const payload = await work(run!.id, { commitSha: sha(i + 1) });
        byStory.set(payload.story.identifier, titles(payload));
      }
      const epicImages = [
        "architecture.png (from ENG-1 description)",
        "null (from comment on ENG-1 by Ana)",
      ];
      // ENG-2 was enqueued at the delegation, before the reply came in.
      expect(byStory.get("ENG-2")).toEqual(epicImages);
      const thread = "flow.png (from Linear thread)";
      expect(byStory.get("ENG-3")).toEqual([...epicImages, "badge mockup (from ENG-3)", thread]);
      expect(byStory.get("ENG-4")).toEqual([
        ...epicImages,
        "this (from comment on ENG-4 by Bo)",
        thread,
      ]);
    });

    it("includes images from an @mention in the request", async () => {
      const { epic } = threeStoryEpic();
      const { run } = await session(
        epic.id,
        `@omniralph does this screenshot match? ![screenshot.png](${UP}/shot) ![old.png](${UP}/broken)`,
      );
      const payload = await request(run!.id);
      expect(titles(payload)).toEqual([
        "screenshot.png (from Linear thread)",
        "old.png (from Linear thread)",
      ]);
    });

    it("leaves a comment that can't be read out instead of failing the run", async () => {
      const { epic } = threeStoryEpic();
      linear.failures.set("getComments", new Error("Linear is down"));
      const { run } = await session(epic.id);
      expect((await work(run!.id)).attachments).toEqual([]);
    });
  });
});
