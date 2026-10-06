import { randomBytes } from "node:crypto";
import {
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
  ralphRuns,
  runMigrations,
  startJob,
  updateRepositoryRalphSettings,
  upsertScmConnection,
  DEFAULT_RALPH_SETTINGS,
  type Database,
  type Job,
  type RalphRun,
} from "@omniralph/db";
import { preparationHash } from "@omniralph/ralph";
import {
  MAX_JOB_DELIVERIES,
  RalphPreparePayload,
  RalphStoryPayload,
  type RalphPrepareResult,
  type RalphStoryResult,
} from "@omniralph/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq, inArray } from "drizzle-orm";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VercelQueuesDispatcher } from "@/lib/dispatch/dispatcher";
import { RecordingPublisher } from "@/lib/dispatch/recording-publisher";
import { handleLinearEvent } from "@/lib/linear/events";
import { FakeLinearGateway } from "@/lib/linear/fake-gateway";
import type { IssueSummary } from "@/lib/linear/gateway";
import { FakeScmAdapter } from "@/lib/scm/fake-adapter";
import { onRalphJobFinished, onRalphJobStarted } from "./jobs";
import { handleReply, type ReplyResult } from "./reply";
import { AGENT_SESSION_MARKER, startRun, type StartRunDeps } from "./start";

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

const PREPARE_COMMANDS = ["terraform init", "terraform apply -auto-approve"];
const MANUAL_DESCRIPTION = `Create the bucket in the console.

\`\`\`cyralph-prepare
${PREPARE_COMMANDS.join("\n")}
\`\`\`
`;

describe.skipIf(!dockerAvailable)("replies in a run's agent session", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let agentA: string;
  let linear: FakeLinearGateway;
  let publisher: RecordingPublisher;
  let dispatcher: VercelQueuesDispatcher;
  let scm: FakeScmAdapter;
  let sessionSeq = 0;
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
    const repoId = (
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
  }, 180_000);

  afterAll(async () => {
    await db?.$client.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await db.delete(jobs);
    await db.delete(ralphRuns);
    await db.delete(agents);
    [{ id: agentA }] = (await db
      .insert(agents)
      .values([{ name: "agent-a", enabledCapabilities: ["ralph"] }])
      .returning({ id: agents.id })) as [{ id: string }];
    linear = new FakeLinearGateway();
    scm = new FakeScmAdapter();
    publisher = new RecordingPublisher();
    dispatcher = new VercelQueuesDispatcher({ db, publisher });
  });

  async function delegate(issueId: string): Promise<RalphRun> {
    sessionSeq += 1;
    const sessionId = `reply-session-${sessionSeq}`;
    await startRun(
      { kind: "session_created", sessionId, issueId, commentBody: `${AGENT_SESSION_MARKER}.` },
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

  async function start(runId: string): Promise<Job> {
    const job = await activeJob(runId);
    const started = await startJob(db, {
      jobId: job.id,
      agentId: agentA,
      enabledCapabilities: ["ralph"],
      maxDeliveries: MAX_JOB_DELIVERIES,
    });
    expect(started.action).toBe("run");
    expect(await onRalphJobStarted(db, job, agentA)).toEqual({ skip: false });
    return job;
  }

  /** Ends a started job with a result or a failure, then runs its outcome hook. */
  async function finish(
    job: Job,
    outcome: Record<string, unknown> | { jobError: string },
  ): Promise<void> {
    if ("jobError" in outcome) {
      await failJob(db, {
        jobId: job.id,
        agentId: agentA,
        retryable: false,
        error: String(outcome.jobError),
        maxDeliveries: MAX_JOB_DELIVERIES,
      });
    } else {
      await completeJob(db, { jobId: job.id, agentId: agentA, result: outcome });
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
    outcome: Partial<RalphStoryResult> | { jobError: string } = {},
  ): Promise<RalphStoryPayload> {
    const job = await start(runId);
    expect(job.type).toBe("ralph.story");
    await finish(job, "jobError" in outcome ? outcome : { ...storyResult(outcome) });
    return RalphStoryPayload.parse(job.payload);
  }

  /** Plays the run's queued `ralph.prepare` job. Returns its payload. */
  async function prepare(
    runId: string,
    outcome: Partial<RalphPrepareResult> | { jobError: string },
  ): Promise<RalphPreparePayload> {
    const job = await start(runId);
    expect(job.type).toBe("ralph.prepare");
    const payload = RalphPreparePayload.parse(job.payload);
    await finish(
      job,
      "jobError" in outcome
        ? outcome
        : {
            status: "completed",
            commands: payload.commands.map((command) => ({ command, exitCode: 0, output: "ok" })),
            headSha: payload.approvedHeadSha ?? sha(99),
            durationMs: 5,
            ...outcome,
          },
    );
    return payload;
  }

  const reply = (run: RalphRun, body: string, signal?: string): Promise<ReplyResult | null> =>
    handleReply(
      {
        kind: "session_prompted",
        sessionId: run.linearAgentSessionId,
        body,
        ...(signal && { signal }),
      },
      deps(),
    );

  const last = (run: RalphRun, type: "thought" | "response" | "elicitation" | "error") =>
    linear.bodies(run.linearAgentSessionId, type).at(-1) ?? "";

  const storyStates = async (runId: string) =>
    (await listStories(db, runId)).map((s) => [s.identifier, s.status, s.attempts]);

  function twoStoryEpic(): { epic: IssueSummary; alpha: IssueSummary; beta: IssueSummary } {
    const epic = linear.add({ identifier: "ENG-1", title: "Epic", description: EPIC_DESCRIPTION });
    const alpha = linear.add({
      identifier: "ENG-2",
      title: "Alpha",
      parentId: epic.id,
      priority: 1,
    });
    const beta = linear.add({ identifier: "ENG-3", title: "Beta", parentId: epic.id, priority: 2 });
    return { epic, alpha, beta };
  }

  /** An epic with a story, then a manual story with preparation commands blocked by it. */
  async function manualEpic() {
    const epic = linear.add({ identifier: "ENG-1", title: "Epic", description: EPIC_DESCRIPTION });
    const alpha = linear.add({
      identifier: "ENG-2",
      title: "Alpha",
      parentId: epic.id,
      priority: 1,
    });
    const bucket = linear.add({
      identifier: "ENG-3",
      title: "Create the bucket",
      parentId: epic.id,
      priority: 2,
      labels: ["manual"],
      description: MANUAL_DESCRIPTION,
    });
    await linear.createBlocksRelation(alpha.id, bucket.id);
    const run = await delegate(epic.id);
    return { epic, alpha, bucket, run };
  }

  const selects = (run: RalphRun) =>
    linear.activities.filter(
      (a) => a.sessionId === run.linearAgentSessionId && a.options?.signal === "select",
    );

  describe("stop", () => {
    it("stops the run and cancels its running job; guidance resumes it", async () => {
      const { alpha } = twoStoryEpic();
      const run = await delegate("issue-1");
      const job = await start(run.id);

      expect(await reply(run, "", "stop")).toEqual({ kind: "stop" });
      expect(await getRun(db, run.id)).toMatchObject({ status: "stopped", waitingOn: null });
      expect((await getJob(db, job.id))?.cancelRequested).toBe(true);
      expect(await storyStates(run.id)).toEqual([
        ["ENG-2", "pending", 0],
        ["ENG-3", "pending", 0],
      ]);
      expect(last(run, "response")).toMatch(/^Stopped\. I canceled the job that was running\./);
      expect(linear.plan(run.linearAgentSessionId)?.[0]).toMatchObject({ status: "pending" });

      // The agent notices the cancel: the stopped run isn't advanced.
      await finish(job, { jobError: "canceled" });
      expect((await getJob(db, job.id))?.status).toBe("canceled");
      expect(await activeJobs(run.id)).toEqual([]);
      expect((await getRun(db, run.id))?.status).toBe("stopped");

      // Guidance resumes it with a fresh attempt.
      const resumed = await reply(run, "Use the v2 API.");
      expect(resumed?.kind).toBe("guidance");
      expect(resumed?.advanced?.action).toBe("enqueued");
      const payload = await work(run.id);
      expect(payload).toMatchObject({ attempt: 1, guidance: ["Use the v2 API."] });
      expect(payload.story.linearIssueId).toBe(alpha.id);
      expect((await getRun(db, run.id))?.status).toBe("running");
    });

    it("stops on the stop text, canceling a queued job at once", async () => {
      twoStoryEpic();
      const run = await delegate("issue-1");
      const job = await activeJob(run.id);
      await reply(run, "Stop.");
      expect((await getJob(db, job.id))?.status).toBe("canceled");
      expect((await getRun(db, run.id))?.status).toBe("stopped");
      expect(last(run, "response")).toContain("I canceled the job that was running");

      // A stop for a stopped run just says so.
      await reply(run, "stop");
      expect(last(run, "response")).toBe(
        "This run is already stopped. Reply with guidance to resume it.",
      );
    });

    it("a guidance reply while a job runs is applied from the next attempt", async () => {
      twoStoryEpic();
      const run = await delegate("issue-1");
      await start(run.id);
      const result = await reply(run, "Prefer small commits.");
      expect(result).toMatchObject({ kind: "guidance", advanced: { action: "busy" } });
      expect(last(run, "thought")).toBe(
        "Got it. I'll apply this from the next story attempt once the current job finishes.",
      );
    });
  });

  describe("guidance", () => {
    it("keeps the latest ten replies and gives exhausted stories a fresh set of attempts", async () => {
      twoStoryEpic();
      const run = await delegate("issue-1");
      // Alpha fails 3 times and is exhausted; Beta completes.
      for (let i = 0; i < 3; i++) await work(run.id, { status: "incomplete", summary: "No." });
      await work(run.id, { commitSha: sha(2) });
      expect(await storyStates(run.id)).toEqual([
        ["ENG-2", "exhausted", 3],
        ["ENG-3", "completed", 1],
      ]);
      expect((await getRun(db, run.id))?.status).toBe("waiting");

      // The first reply enqueues Alpha again; later ones find its job queued.
      for (let i = 0; i < 11; i++) await reply(run, `hint ${i}`);
      const stored = (await getRun(db, run.id))!;
      expect(stored.guidance.map((g) => g.text)).toEqual(
        Array.from({ length: 10 }, (_, i) => `hint ${i + 1}`),
      );
      expect(await storyStates(run.id)).toEqual([
        ["ENG-2", "running", 0],
        ["ENG-3", "completed", 1],
      ]);
      const payload = await work(run.id);
      // Its payload was built by the first reply.
      expect(payload).toMatchObject({
        attempt: 1,
        guidance: ["hint 0"],
        lastFeedback: expect.stringContaining("No."),
      });
    });
  });

  describe("start anyway", () => {
    it("ignores the open blockers and advances", async () => {
      const outside = linear.add({ identifier: "OPS-1", title: "Provision" });
      const { alpha, beta } = twoStoryEpic();
      await linear.createBlocksRelation(outside.id, alpha.id);
      await linear.createBlocksRelation(outside.id, beta.id);
      const run = await delegate("issue-2");
      expect(await getRun(db, run.id)).toMatchObject({ status: "waiting" });
      expect(await activeJobs(run.id)).toEqual([]);

      const result = await reply(run, "Please start anyway");
      expect(result).toMatchObject({ kind: "start_anyway", advanced: { action: "enqueued" } });
      expect(await getRun(db, run.id)).toMatchObject({ ignoreBlockers: true, status: "running" });
      expect(linear.bodies(run.linearAgentSessionId, "thought")).toContain(
        "OK, I'll ignore the open blockers and start anyway.",
      );
      expect((await getRun(db, run.id))?.guidance).toEqual([]);
    });
  });

  describe("preparation", () => {
    it("asks once the manual story is unblocked, runs it on approval and doesn't ask again", async () => {
      const { alpha, bucket, run } = await manualEpic();
      await work(run.id, { commitSha: sha(7) });
      expect(linear.issues.get(alpha.id)?.stateType).toBe("completed");

      const [question, ...more] = selects(run);
      expect(more).toEqual([]);
      expect(question!.options?.signalMetadata).toEqual({
        options: [{ value: "Run it" }, { value: "I'll do it myself" }, { value: "Not yet" }],
      });
      const body = (question!.content as { body: string }).body;
      expect(body).toContain("1/2 stories are done; the rest are waiting on **ENG-3**.");
      expect(body).toContain("**ENG-3: Create the bucket** is a manual step");
      expect(body).toContain(`\`${run.branch}\` at \`${sha(7).slice(0, 10)}\``);
      expect(body).toContain("```sh\nterraform init\nterraform apply -auto-approve\n```");
      expect((await getRun(db, run.id))?.preparation?.request).toMatchObject({
        storyIssueId: bucket.id,
        headSha: sha(7),
        commandsHash: preparationHash(PREPARE_COMMANDS),
      });
      expect(await activeJobs(run.id)).toEqual([]);

      // "Run it" (by number) enqueues the job on the run's agent.
      const approved = await reply(run, "1");
      expect(approved).toMatchObject({
        kind: "preparation_answer",
        advanced: { action: "preparing" },
      });
      const job = await activeJob(run.id);
      expect(job).toMatchObject({ type: "ralph.prepare", topic: `ralph-jobs-agent-${agentA}` });
      const payload = await prepare(run.id, {});
      expect(payload).toMatchObject({
        commands: PREPARE_COMMANDS,
        commandsHash: preparationHash(PREPARE_COMMANDS),
        approvedHeadSha: sha(7),
        story: { identifier: "ENG-3", title: "Create the bucket" },
      });
      const posted = linear.bodies(run.linearAgentSessionId, "thought");
      const outcome = posted.find((b) => b.startsWith("Ran the preparation of **ENG-3**"))!;
      expect(outcome).toContain("`terraform init` (exit 0)");
      expect(outcome).toContain("The rest of ENG-3 is up to a person, who marks it done.");

      // The story stays manual and the run waits on it; nothing is asked again.
      expect(linear.issues.get(bucket.id)?.stateType).toBe("unstarted");
      expect(await getRun(db, run.id)).toMatchObject({
        status: "waiting",
        waitingOn: { manual: [{ id: bucket.id }] },
        preparation: { request: null, handled: { [bucket.id]: { how: "prepared" } } },
      });
      expect(selects(run)).toHaveLength(1);
      expect(last(run, "elicitation")).toContain("Reply `rerun preparation`");

      // A new story moving the branch doesn't bring the question back.
      const gamma = linear.add({ identifier: "ENG-4", title: "Gamma", parentId: alpha.parentId });
      await reply(run, "Also do Gamma.");
      await work(run.id, { commitSha: sha(8) });
      expect(linear.issues.get(gamma.id)?.stateType).toBe("completed");
      expect(selects(run)).toHaveLength(1);

      // `rerun preparation` asks again, bound to the newest commit.
      expect((await reply(run, "rerun preparation"))?.kind).toBe("rerun_preparation");
      expect(selects(run)).toHaveLength(2);
      expect((await getRun(db, run.id))?.preparation?.request?.headSha).toBe(sha(8));
    });

    it("asks again after a stale approval, bound to the HEAD the job found", async () => {
      const { run } = await manualEpic();
      await work(run.id, { commitSha: sha(7) });
      await reply(run, "Run it");
      await prepare(run.id, { status: "stale", commands: [], headSha: sha(9) });

      expect(linear.bodies(run.linearAgentSessionId, "thought")).toContain(
        `\`${run.branch}\` (now at \`${sha(9).slice(0, 10)}\`) changed since I asked about the preparation of **ENG-3**, so I ran nothing. Here it is again as it is now.`,
      );
      const asks = selects(run);
      expect(asks).toHaveLength(2);
      expect((asks[1]!.content as { body: string }).body).toContain("so I ran nothing");
      expect((await getRun(db, run.id))?.preparation?.request).toMatchObject({ headSha: sha(9) });
      expect(await activeJobs(run.id)).toEqual([]);
    });

    it("reports a failed command and asks again; a failed job too", async () => {
      const { run } = await manualEpic();
      await work(run.id, { commitSha: sha(7) });
      await reply(run, "Run it");
      await prepare(run.id, {
        status: "failed",
        commands: [{ command: "terraform init", exitCode: 1, output: "no credentials" }],
      });
      const failure = linear
        .bodies(run.linearAgentSessionId, "thought")
        .find((b) => b.startsWith("The preparation of **ENG-3** failed"))!;
      expect(failure).toContain("`terraform init` (exit 1)");
      expect(failure).toContain("no credentials");
      const asks = selects(run);
      expect(asks).toHaveLength(2);
      expect((asks[1]!.content as { body: string }).body).toContain(
        "`terraform init` failed with exit 1, so I stopped there and didn't run the 1 command after it.",
      );
      expect((await getRun(db, run.id))?.preparation?.handled).toEqual({});

      await reply(run, "Run it");
      await prepare(run.id, { jobError: "the worktree is broken" });
      expect(selects(run)).toHaveLength(3);
      expect(last(run, "elicitation")).toContain(
        "The preparation of **ENG-3** didn't run: the worktree is broken.",
      );
    });

    it('records "Not yet" and "I\'ll do it myself"', async () => {
      const { bucket, run } = await manualEpic();
      await work(run.id, { commitSha: sha(7) });

      expect((await reply(run, "Not yet"))?.kind).toBe("preparation_answer");
      expect((await getRun(db, run.id))?.preparation?.request).toMatchObject({ answer: "later" });
      expect(last(run, "thought")).toContain("I won't run anything for **ENG-3** yet");
      expect(await activeJobs(run.id)).toEqual([]);
      expect(selects(run)).toHaveLength(1);

      expect((await reply(run, "I'll do it myself"))?.kind).toBe("preparation_answer");
      expect((await getRun(db, run.id))?.preparation).toMatchObject({
        request: null,
        handled: { [bucket.id]: { how: "myself" } },
      });
      expect(selects(run)).toHaveLength(1);
      expect(await activeJobs(run.id)).toEqual([]);
    });

    it("handles replies in order: stop, then answers, then rerun, then start anyway", async () => {
      const { run } = await manualEpic();
      // No question is open: "Run it" is just guidance.
      expect((await reply(run, "Run it"))?.kind).toBe("guidance");
      await work(run.id, { commitSha: sha(7) });
      expect(selects(run)).toHaveLength(1);

      // An answer wins over start anyway's words only when it is an option…
      expect((await reply(run, "start anyway"))?.kind).toBe("start_anyway");
      expect((await getRun(db, run.id))?.preparation?.request).not.toBeNull();
      // …and rerun preparation isn't an answer.
      expect((await reply(run, "rerun preparation"))?.kind).toBe("rerun_preparation");
      expect(selects(run)).toHaveLength(2);

      // Stop beats an open question, and drops it.
      expect((await reply(run, "stop"))?.kind).toBe("stop");
      expect((await getRun(db, run.id))?.preparation?.request).toBeNull();
      // On a stopped run, an option is guidance (which resumes it and asks again).
      expect((await reply(run, "Not yet"))?.kind).toBe("guidance");
      expect((await getRun(db, run.id))?.status).toBe("waiting");
      expect(selects(run)).toHaveLength(3);
    });
  });

  it("is wired to session_prompted webhooks", async () => {
    twoStoryEpic();
    const run = await delegate("issue-1");
    await handleLinearEvent(
      { kind: "session_prompted", sessionId: run.linearAgentSessionId, body: "", signal: "stop" },
      { db, organizationId: "org-1" },
      { linear, dispatcher, adapterFor: () => scm.asAdapter() },
    );
    expect((await getRun(db, run.id))?.status).toBe("stopped");
  });
});
