import { randomBytes } from "node:crypto";
import {
  claimJob,
  closeDb,
  completeJob,
  connectRepository,
  createDb,
  expireQueuedJobs,
  failJob,
  getJob,
  getMainLane,
  getRun,
  getRunBySession,
  harnesses,
  jobs,
  listStories,
  organizations,
  ralphRuns,
  updateLane,
  updateRepositoryCoding,
  updateRun,
  updateStory,
  upsertScmConnection,
  type Database,
  type Job,
  type LinearRun,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import {
  CODING_TASKS_MIN_HARNESS_VERSION,
  MAX_JOB_DELIVERIES,
  RalphRequestPayload,
  RalphStoryPayload,
  type RalphStoryResult,
} from "@omniralph/shared";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresDispatcher } from "@/lib/dispatch/dispatcher";
import { FakeLinearGateway, linearRun } from "@/lib/linear/fake-gateway";
import type { IssueSummary } from "@/lib/linear/gateway";
import { setRoutingRules, teamIs } from "@/lib/routing/testing";
import { FakeScmAdapter } from "@/lib/scm/fake-adapter";
import { ralphJobPayload } from "./coding";
import { onRalphJobFinished, onRalphJobStarted } from "./jobs";
import { stopRun } from "./reply";
import { retryRalphRun, type RalphRetryTarget } from "./retry";
import { MAX_ITERATIONS_PER_RUN } from "./run";
import { AGENT_SESSION_MARKER, startRun, type StartRunDeps } from "./start";

vi.mock("server-only", () => ({}));
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const databaseAvailable = testDatabaseAvailable();

const sha = (n: number) => n.toString(16).padStart(40, "0");

const EPIC_DESCRIPTION = `Build the thing.

## Quality Gates
- \`pnpm test\`
`;

describe.skipIf(!databaseAvailable)("retrying epic and request runs from Omniralph", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let repoId: string;
  let agentA: string;
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
    await updateRepositoryCoding(db, repoId, {
      ralphEnabled: true,
    });
    await setRoutingRules(db, orgId, [repoId, teamIs("ENG")]);
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    await db.delete(jobs);
    await db.delete(ralphRuns);
    await db.delete(harnesses);
    [{ id: agentA }] = (await db
      .insert(harnesses)
      .values([{ organizationId: orgId, name: "agent-a", acceptedTaskTypes: ["coding"] }])
      .returning({ id: harnesses.id })) as [{ id: string }];
    linear = new FakeLinearGateway();
    scm = new FakeScmAdapter();
    dispatcher = new PostgresDispatcher({ db });
  });

  /** A new agent session on `issueId`: a delegation, or a mention with `body`. */
  async function session(issueId: string, body?: string): Promise<LinearRun> {
    sessionSeq += 1;
    const sessionId = `retry-session-${sessionSeq}`;
    await startRun(
      {
        kind: "session_created",
        sessionId,
        issueId,
        commentBody: body ?? `${AGENT_SESSION_MARKER}.`,
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

  async function start(runId: string): Promise<Job> {
    const job = await activeJob(runId);
    const started = await claimJob(db, {
      organizationId: orgId,
      harnessId: agentA,
      acceptedTaskTypes: ["query", "coding"],
      pools: ["short", "long"],
      harnessVersion: CODING_TASKS_MIN_HARNESS_VERSION,
      maxDeliveries: MAX_JOB_DELIVERIES,
    });
    expect(started.claim?.job.id).toBe(job.id);
    expect(await onRalphJobStarted(db, job, agentA)).toEqual({ skip: false });
    return job;
  }

  async function finish(
    job: Job,
    outcome: Record<string, unknown> | { jobError: string },
  ): Promise<void> {
    if ("jobError" in outcome) {
      await failJob(db, {
        jobId: job.id,
        harnessId: agentA,
        retryable: false,
        error: String(outcome.jobError),
        maxDeliveries: MAX_JOB_DELIVERIES,
      });
    } else {
      await completeJob(db, { jobId: job.id, harnessId: agentA, result: outcome });
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
    return RalphStoryPayload.parse(ralphJobPayload(job));
  }

  /** Plays the run's queued describe job. */
  async function describePr(runId: string): Promise<void> {
    const job = await start(runId);
    expect(job.type).toBe("ralph.describe-pr");
    // A query run: its `run-result` sink hands the description to the ralph run.
    await finish(job, {
      outcome: "answered",
      answer: null,
      structured: { title: "Build the epic", body: "Builds it." },
      references: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      durationMs: 10,
    });
  }

  const retry = (run: LinearRun, target: RalphRetryTarget = { kind: "run" }) =>
    retryRalphRun(deps(), run.id, target, "Ada Admin");

  const thoughts = (run: LinearRun) => linear.bodies(run.linearAgentSessionId, "thought");

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

  describe("the run", () => {
    it("resumes a stopped epic: fresh attempts and iteration cap, a note, the next story enqueued", async () => {
      const { epic } = twoStoryEpic();
      const run = await session(epic.id);
      await activeJob(run.id);
      await stopRun(deps(), run, "Steve");
      const [alpha] = await listStories(db, run.id);
      await updateStory(db, alpha!.id, { attempts: 2 });
      await updateRun(db, run.id, { iterations: 5 });
      expect((await getRun(db, run.id))!.status).toBe("stopped");

      const result = await retry(run);
      expect(result).toMatchObject({ status: "retried", advanced: { action: "enqueued" } });
      // The cap starts over (the new story attempt counts one).
      expect(await getRun(db, run.id)).toMatchObject({ status: "running", iterations: 1 });
      expect(thoughts(run)).toContain("Retried from Omniralph by Ada Admin.");
      const payload = await work(run.id, { commitSha: sha(1) });
      expect(payload.story.identifier).toBe("ENG-2");
      expect(payload.attempt).toBe(1);
    });

    it("resumes a failed epic", async () => {
      const { epic } = twoStoryEpic();
      const run = await session(epic.id);
      await stopRun(deps(), run, undefined);
      await updateRun(db, run.id, { status: "failed", error: "The repository went away." });

      expect(await retry(run)).toMatchObject({
        status: "retried",
        advanced: { action: "enqueued" },
      });
      expect(await getRun(db, run.id)).toMatchObject({ status: "running", error: null });
    });

    it("continues an epic waiting at the iteration cap, and gives exhausted stories another go", async () => {
      const { epic } = twoStoryEpic();
      const run = await session(epic.id);
      await updateRun(db, run.id, { iterations: MAX_ITERATIONS_PER_RUN });
      await work(run.id, { commitSha: sha(1) });
      expect(await getRun(db, run.id)).toMatchObject({ status: "waiting" });
      const [, beta] = await listStories(db, run.id);
      await updateStory(db, beta!.id, { status: "exhausted", attempts: 3 });

      expect(await retry(run)).toMatchObject({
        status: "retried",
        advanced: { action: "enqueued" },
      });
      expect(await storyStates(run.id)).toEqual([
        ["ENG-2", "completed", 1],
        ["ENG-3", "running", 0],
      ]);
      expect((await work(run.id)).story.identifier).toBe("ENG-3");
    });

    it("answers busy while one of the run's jobs is queued", async () => {
      const { epic } = twoStoryEpic();
      const run = await session(epic.id);
      await updateRun(db, run.id, { status: "waiting" });
      expect(await retry(run)).toEqual({ status: "busy" });
      expect(thoughts(run)).not.toContain("Retried from Omniralph by Ada Admin.");
    });
  });

  describe("one story", () => {
    it("resets an exhausted story's attempts and focuses it ahead of a higher priority one", async () => {
      const { epic, beta } = twoStoryEpic();
      const run = await session(epic.id);
      await stopRun(deps(), run, undefined);
      const [alpha, betaRow] = await listStories(db, run.id);
      await updateStory(db, alpha!.id, { status: "pending", attempts: 1 });
      await updateStory(db, betaRow!.id, { status: "exhausted", attempts: 3 });

      expect(await retry(run, { kind: "story", storyId: betaRow!.id })).toMatchObject({
        status: "retried",
        advanced: { action: "enqueued", story: { identifier: "ENG-3" } },
      });
      expect(await getRun(db, run.id)).toMatchObject({ focusStoryId: beta.id, iterations: 1 });
      expect(thoughts(run)).toContain("Retried **ENG-3** from Omniralph by Ada Admin.");
      // Only the retried story starts over.
      expect(await storyStates(run.id)).toEqual([
        ["ENG-2", "pending", 1],
        ["ENG-3", "running", 0],
      ]);
      const payload = await work(run.id);
      expect(payload).toMatchObject({ story: { identifier: "ENG-3" }, attempt: 1 });
    });

    it.each(["canceled", "expired"] as const)(
      "retries a story whose last attempt was %s",
      async (status) => {
        const { epic, alpha } = twoStoryEpic();
        const run = await session(epic.id);
        const job = await activeJob(run.id);
        if (status === "expired") {
          // Nobody picked it up: the expiry cron fails it through the job's hooks.
          expect(await expireQueuedJobs(db, new Date(Date.now() + 60_000))).toContain(job.id);
          await onRalphJobFinished(db, (await getJob(db, job.id))!, deps());
        }
        // Stopped (a queued attempt is canceled at once).
        await stopRun(deps(), run, undefined);
        expect((await getRun(db, run.id))!.status).toBe("stopped");
        if (status === "canceled") expect((await getJob(db, job.id))!.status).toBe("canceled");
        expect(await activeJobs(run.id)).toEqual([]);
        // The attempt was the first story's.
        const [alphaRow] = await listStories(db, run.id);
        expect(job.ralphStoryId).toBe(alphaRow!.id);

        expect(await retry(run, { kind: "story", storyId: alphaRow!.id })).toMatchObject({
          status: "retried",
          advanced: { action: "enqueued", story: { identifier: "ENG-2" } },
        });
        expect(await getRun(db, run.id)).toMatchObject({
          status: "running",
          focusStoryId: alpha.id,
        });
        expect(thoughts(run)).toContain("Retried **ENG-2** from Omniralph by Ada Admin.");
        expect((await storyStates(run.id))[0]).toEqual(["ENG-2", "running", 0]);
        const payload = await work(run.id);
        expect(payload).toMatchObject({ story: { identifier: "ENG-2" }, attempt: 1 });
      },
    );

    it("re-runs a completed story of a finished epic, then describes the PR again", async () => {
      const { epic, alpha } = twoStoryEpic();
      const run = await session(epic.id);
      await work(run.id, { commitSha: sha(1) });
      await work(run.id, { commitSha: sha(2) });
      await describePr(run.id);
      expect(await getRun(db, run.id)).toMatchObject({ status: "completed" });
      expect(linear.issues.get(alpha.id)!.stateType).toBe("completed");
      const [alphaRow] = await listStories(db, run.id);

      expect(await retry(run, { kind: "story", storyId: alphaRow!.id })).toMatchObject({
        status: "retried",
        advanced: { action: "enqueued", story: { identifier: "ENG-2" } },
      });
      // The work item is open again, so Linear doesn't complete it on the next sync.
      expect(linear.issues.get(alpha.id)!.stateType).toBe("started");
      expect(await getRun(db, run.id)).toMatchObject({
        status: "running",
        focusStoryId: alpha.id,
      });
      expect(await storyStates(run.id)).toEqual([
        ["ENG-2", "running", 0],
        ["ENG-3", "completed", 1],
      ]);
      const payload = await work(run.id, { commitSha: sha(3) });
      expect(payload).toMatchObject({ story: { identifier: "ENG-2" }, attempt: 1 });

      // The PR step runs again, through the dispatcher, and the run completes.
      const describe = await activeJob(run.id);
      expect(describe.type).toBe("ralph.describe-pr");
      await describePr(run.id);
      expect(await getRun(db, run.id)).toMatchObject({ status: "completed" });
      expect(scm.changeRequests).toHaveLength(1);
    });

    it("refuses a story whose pull request is merged or closed", async () => {
      const { epic } = twoStoryEpic();
      const run = await session(epic.id);
      await stopRun(deps(), run, undefined);
      const [alpha] = await listStories(db, run.id);
      const lane = (await getMainLane(db, run))!;
      await updateLane(db, lane.id, { prNumber: 3, prUrl: "https://github.com/acme/api/pull/3" });

      await updateLane(db, lane.id, { prMerged: true, prClosed: true });
      expect(await retry(run, { kind: "story", storyId: alpha!.id })).toEqual({
        status: "refused",
        message: "The pull request for this story is already merged.",
      });
      await updateLane(db, lane.id, { prMerged: false, prClosed: true });
      expect(await retry(run, { kind: "story", storyId: alpha!.id })).toEqual({
        status: "refused",
        message: "The pull request for this story is already closed.",
      });
      expect((await getRun(db, run.id))!.status).toBe("stopped");
    });

    it("leaves the run as it was when the work item can't be reopened", async () => {
      const { epic } = twoStoryEpic();
      const run = await session(epic.id);
      await work(run.id, { commitSha: sha(1) });
      await work(run.id, { commitSha: sha(2) });
      await describePr(run.id);
      const [alphaRow] = await listStories(db, run.id);
      linear.setIssueState = async () => {
        throw new Error("Linear is down");
      };

      expect(await retry(run, { kind: "story", storyId: alphaRow!.id })).toEqual({
        status: "failed",
        message: "Couldn't reopen ENG-2 in Linear: Linear is down",
      });
      expect(await getRun(db, run.id)).toMatchObject({ status: "completed" });
      expect((await listStories(db, run.id))[0]!.status).toBe("completed");
    });
  });

  describe("a request run", () => {
    it.each(["failed", "canceled", "expired"] as const)(
      "re-queues the request of a %s request attempt and resumes the run",
      async (status) => {
        const { epic } = twoStoryEpic();
        const run = await session(epic.id, "@omniralph fix the typo in the README");
        // Stopped while queued: canceled at once, its request still pending (not queued twice).
        const job = status === "canceled" ? await activeJob(run.id) : await start(run.id);
        expect(job.type).toBe("ralph.request");
        if (status === "failed") {
          await finish(job, { jobError: "The agent crashed." });
        } else if (status === "canceled") {
          await stopRun(deps(), run, undefined);
          expect((await getJob(db, job.id))!.status).toBe("canceled");
        } else {
          await db.update(jobs).set({ status, finishedAt: new Date() }).where(eq(jobs.id, job.id));
          await onRalphJobFinished(db, (await getJob(db, job.id))!, deps());
        }
        expect((await getRun(db, run.id))!.status).toBe(
          status === "canceled" ? "stopped" : "completed",
        );
        expect(await activeJobs(run.id)).toEqual([]);

        expect(await retry(run, { kind: "run", requestJobId: job.id })).toMatchObject({
          status: "retried",
          advanced: { action: "requesting" },
        });
        const again = await activeJob(run.id);
        expect(again.type).toBe("ralph.request");
        expect(
          RalphRequestPayload.parse(ralphJobPayload(again)).requests.map((r) => r.text),
        ).toEqual(["fix the typo in the README"]);
        expect(thoughts(run)).toContain("Retried from Omniralph by Ada Admin.");
      },
    );
  });
});
