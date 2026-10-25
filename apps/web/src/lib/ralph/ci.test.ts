import { randomBytes, randomUUID } from "node:crypto";
import {
  harnesses,
  completeJob,
  connectRepository,
  closeDb,
  createDb,
  getJob,
  getLane,
  getMainLane,
  getRun,
  getRunBySession,
  jobs,
  listPendingRequests,
  ralphLanes,
  ralphRuns,
  claimJob,
  updateRepositoryRalphSettings,
  upsertScmConnection,
  webhookDeliveries,
  DEFAULT_RALPH_SETTINGS,
  type Database,
  type Job,
  type RalphRun,
  organizations,
  seedReviewProfiles,
} from "@omniralph/db";
import { teamIs, setRoutingRules } from "@/lib/routing/testing";
import type { CiFailedJob, CiStatus } from "@omniralph/scm";
import {
  CODING_TASKS_MIN_HARNESS_VERSION,
  MAX_JOB_DELIVERIES,
  RalphRequestPayload,
  type RalphRequestResult,
  type RalphStoryResult,
} from "@omniralph/shared";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresDispatcher } from "@/lib/dispatch/dispatcher";
import { FakeLinearGateway } from "@/lib/linear/fake-gateway";
import { FakeScmAdapter } from "@/lib/scm/fake-adapter";
import { handleWebhook } from "@/lib/webhooks/ingest";
import { reconcileCi, respondToCi } from "./ci";
import { onRalphJobFinished, onRalphJobStarted } from "./jobs";
import { ralphJobPayload } from "./coding";
import { AGENT_SESSION_MARKER, startRun, type StartRunDeps } from "./start";

vi.mock("server-only", () => ({}));
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const databaseAvailable = testDatabaseAvailable();

const sha = (n: number) => n.toString(16).padStart(40, "0");

const EPIC_DESCRIPTION = `Build the thing.

## Quality Gates
- \`pnpm test\`
`;

const JOB_URL = "https://github.com/acme/api/actions/runs/5/job/1";

const failed = (
  headSha: string,
  failedJobs: CiFailedJob[] = [{ id: "1", name: "CI / test", url: JOB_URL, noLog: false }],
): CiStatus => ({ state: "failed", headSha, failedJobs });

describe.skipIf(!databaseAvailable)("failed CI on ralph pull requests", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let repoId: string;
  let otherRepoId: string;
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

  const ralphOn = (id: string, settings: Partial<typeof DEFAULT_RALPH_SETTINGS> = {}) =>
    updateRepositoryRalphSettings(db, id, {
      ralphEnabled: true,
      ralphSettings: { ...DEFAULT_RALPH_SETTINGS, ...settings },
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
    otherRepoId = (
      await connectRepository(db, {
        connectionId: connection.id,
        provider: "github",
        externalId: "2",
        fullPath: "acme/web",
      })
    ).id;
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
    await db.delete(webhookDeliveries);
    [{ id: agentA }] = (await db
      .insert(harnesses)
      .values([
        {
          organizationId: orgId,
          name: "agent-a",
          acceptedTaskTypes: ["query", "review", "coding"],
        },
      ])
      .returning({ id: harnesses.id })) as [{ id: string }];
    await ralphOn(repoId);
    await ralphOn(otherRepoId);
    linear = new FakeLinearGateway();
    scm = new FakeScmAdapter();
    dispatcher = new PostgresDispatcher({ db });
  });

  const activeJobs = (runId: string) =>
    db
      .select()
      .from(jobs)
      .where(and(eq(jobs.ralphRunId, runId), inArray(jobs.status, ["queued", "running"])));

  async function start(runId: string): Promise<Job> {
    const [job, ...more] = await activeJobs(runId);
    expect(job, "the run has a queued job").toBeDefined();
    expect(more).toEqual([]);
    const started = await claimJob(db, {
      organizationId: orgId,
      harnessId: agentA,
      acceptedTaskTypes: ["query", "coding"],
      pools: ["short", "long"],
      harnessVersion: CODING_TASKS_MIN_HARNESS_VERSION,
      maxDeliveries: MAX_JOB_DELIVERIES,
    });
    expect(started.claim?.job.id).toBe(job!.id);
    expect(await onRalphJobStarted(db, job!, agentA)).toEqual({ skip: false });
    return job!;
  }

  async function finish(job: Job, result: Record<string, unknown>): Promise<void> {
    expect(await completeJob(db, { jobId: job.id, harnessId: agentA, result })).toEqual({
      status: "completed",
    });
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

  const requestResult = (overrides: Partial<RalphRequestResult> = {}): RalphRequestResult => ({
    summary: "Fixed CI.",
    error: null,
    sessionId: "claude-req-1",
    usage: { inputTokens: 1, outputTokens: 1 },
    durationMs: 10,
    ...overrides,
  });

  /** A finished epic with PR #1 open (head `head1`), whose CI is checked. */
  async function ciEpic(): Promise<{ run: RalphRun; sessionId: string }> {
    const epic = linear.add({ identifier: "ENG-1", title: "Epic", description: EPIC_DESCRIPTION });
    linear.add({ identifier: "ENG-2", title: "Alpha", parentId: epic.id });
    sessionSeq += 1;
    const sessionId = `session-${sessionSeq}`;
    await startRun(
      {
        kind: "session_created",
        sessionId,
        issueId: epic.id,
        commentBody: `${AGENT_SESSION_MARKER}.`,
        creatorName: "Steve",
      },
      deps(),
    );
    const run = (await getRunBySession(db, sessionId))!;
    await finish(await start(run.id), storyResult({ commitSha: sha(1) }));
    const describe = await start(run.id);
    expect(describe.type).toBe("ralph.describe-pr");
    await finish(describe, {
      outcome: "answered",
      answer: null,
      structured: { title: "Build the epic", body: "Builds it." },
      references: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      durationMs: 10,
    });
    expect((await getRun(db, run.id))?.status).toBe("completed");
    expect(scm.changeRequests).toHaveLength(1);
    scm.changeRequests[0]!.headSha = "head1";
    return { run: (await getRun(db, run.id))!, sessionId };
  }

  const setCi = (status: CiStatus, fullPath = "acme/api", number = 1) =>
    scm.ciStatuses.set(`${fullPath}#${number}`, status);

  const requestJobs = async (runId: string) =>
    (await db.select().from(jobs).where(eq(jobs.ralphRunId, runId)))
      .filter((j) => j.type === "ralph.request")
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const requestTexts = async (runId: string) =>
    (await requestJobs(runId)).map((j) =>
      RalphRequestPayload.parse(ralphJobPayload(j))
        .requests.map((r) => r.text)
        .join("\n\n"),
    );

  const found = async (run: RalphRun) => ({
    run: (await getRun(db, run.id))!,
    lane: (await getMainLane(db, run))!,
  });

  it("hands a failed pipeline's jobs and logs to the epic's session, once per head commit", async () => {
    const { run, sessionId } = await ciEpic();
    const branch = (await getMainLane(db, run))!.branch;
    const prUrl = scm.changeRequests[0]!.url;

    // Still running or green: nothing to do.
    setCi({ state: "pending", headSha: "head1", failedJobs: [] });
    expect(await respondToCi(deps(), await found(run))).toEqual({
      status: "not_failed",
      state: "pending",
    });
    setCi({ state: "passed", headSha: "head1", failedJobs: [] });
    await reconcileCi(deps());
    expect(await requestJobs(run.id)).toHaveLength(0);

    setCi(failed("head1"));
    scm.ciJobLogs.set("1", "FAIL test/a.test.ts\nExpected 2, got 3");
    expect(await reconcileCi(deps())).toEqual({ checked: 1, failed: 0 });
    let texts = await requestTexts(run.id);
    expect(texts).toHaveLength(1);
    expect((await listPendingRequests(db, run.id)).map((m) => m.trigger)).toEqual(["pr.ci-failed"]);
    expect(texts[0]).toContain(
      `The GitHub Actions checks for pull request #1 (${prUrl}) failed on \`head1\``,
    );
    expect(texts[0]).toContain(`### CI / test (${JOB_URL})`);
    expect(texts[0]).toContain("Expected 2, got 3");
    expect(texts[0]).toContain(`push \`${branch}\``);
    expect(linear.bodies(sessionId, "thought")).toContain(
      "CI failed on the pull request (`head1`: `CI / test`). Working on a fix.",
    );
    expect(await getMainLane(db, run)).toMatchObject({
      ciFixRounds: 1,
      handledCiShas: ["head1"],
    });
    expect((await getRun(db, run.id))?.status).toBe("running");

    // The request session pushes a fix; the run completes again.
    await finish(await start(run.id), requestResult());
    expect((await getRun(db, run.id))?.status).toBe("completed");
    expect(await listPendingRequests(db, run.id)).toEqual([]);

    // The same failed commit on the next check is not acted on again.
    expect(await respondToCi(deps(), await found(run))).toEqual({ status: "handled" });
    await reconcileCi(deps());
    expect(await requestJobs(run.id)).toHaveLength(1);

    // A new push that fails again is; a job whose log can't be read is still reported.
    scm.changeRequests[0]!.headSha = "head2";
    setCi(failed("head2", [{ id: "2", name: "CI / build", url: null, noLog: false }]));
    await reconcileCi(deps());
    texts = await requestTexts(run.id);
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain("### CI / build\n(no log available)");
    await finish(await start(run.id), requestResult());

    // Many failed jobs: five logs read and listed, the rest counted.
    scm.changeRequests[0]!.headSha = "head3";
    const many = Array.from({ length: 7 }, (_, i) => ({
      id: String(10 + i),
      name: `job${i + 1}`,
      url: null,
      noLog: false,
    }));
    setCi(failed("head3", many));
    const logReads = scm.calls.filter((c) => c === "getCiJobLog").length;
    await reconcileCi(deps());
    expect(scm.calls.filter((c) => c === "getCiJobLog").length - logReads).toBe(5);
    texts = await requestTexts(run.id);
    expect(texts[2]).toContain("### job5");
    expect(texts[2]).not.toContain("### job6");
    expect(texts[2]).toContain("(2 more failed jobs not shown.)");
    expect(linear.bodies(sessionId, "thought")).toContain(
      "CI failed on the pull request (`head3`: `job1`, `job2`, `job3` and 4 more). Working on a fix.",
    );
  });

  it("stops after maxFixRounds and says so in the session", async () => {
    await ralphOn(repoId, { maxFixRounds: 1 });
    const { run, sessionId } = await ciEpic();
    const prUrl = scm.changeRequests[0]!.url;
    setCi(failed("head1"));
    expect(await respondToCi(deps(), await found(run))).toMatchObject({ status: "started" });
    await finish(await start(run.id), requestResult());

    scm.changeRequests[0]!.headSha = "head2";
    setCi(failed("head2"));
    expect(await respondToCi(deps(), await found(run))).toEqual({
      status: "round_limit",
      rounds: 1,
    });
    expect(await requestJobs(run.id)).toHaveLength(1);
    const limit = `CI failed again on ${prUrl} (\`head2\`). I've already tried to fix CI 1 time on this pull request, so I'm leaving this one for a person.`;
    expect(linear.bodies(sessionId, "response").at(-1)).toBe(limit);
    // Said once, not on every check.
    await reconcileCi(deps());
    expect(linear.bodies(sessionId, "response").filter((b) => b === limit)).toHaveLength(1);
    expect(await getMainLane(db, run)).toMatchObject({
      ciFixRounds: 1,
      handledCiShas: ["head1", "head2"],
    });
  });

  it("skips repositories that opted out, stopped sessions, busy runs and closed PRs", async () => {
    const { run } = await ciEpic();
    setCi(failed("head1"));
    const ciCalls = () =>
      scm.calls.filter((c) => c === "getCiStatus" || c === "getChangeRequestState").length;

    // Opted out: CI isn't even checked.
    await ralphOn(repoId, { respondToCiFailures: false });
    expect(await respondToCi(deps(), await found(run))).toEqual({
      status: "ignored",
      reason: "opted_out",
    });
    await reconcileCi(deps());
    expect(ciCalls()).toBe(0);
    await ralphOn(repoId);

    // A stopped run.
    await db.update(ralphRuns).set({ status: "stopped" }).where(eq(ralphRuns.id, run.id));
    expect(await respondToCi(deps(), await found(run))).toEqual({
      status: "ignored",
      reason: "run_over",
    });
    await db.update(ralphRuns).set({ status: "completed" }).where(eq(ralphRuns.id, run.id));

    // A run with an active job (it may push again): checked later.
    const [queued] = await db
      .insert(jobs)
      .values({
        organizationId: orgId,
        type: "ralph.request",
        taskType: "coding",
        payload: {},
        ralphRunId: run.id,
        repositoryId: repoId,
      })
      .returning();
    expect(await respondToCi(deps(), await found(run))).toEqual({
      status: "ignored",
      reason: "busy",
    });
    await db.delete(jobs).where(eq(jobs.id, queued!.id));
    expect(ciCalls()).toBe(0);
    expect(await requestJobs(run.id)).toHaveLength(0);

    // A merged PR: recorded on the lane and not checked again.
    scm.changeRequests[0]!.state = "merged";
    scm.changeRequests[0]!.mergeSha = sha(5);
    await reconcileCi(deps());
    expect(await requestJobs(run.id)).toHaveLength(0);
    expect(await getMainLane(db, run)).toMatchObject({
      prClosed: true,
      prMerged: true,
      mergeSha: sha(5),
      ciFixRounds: 0,
    });
    const calls = ciCalls();
    expect(await reconcileCi(deps())).toEqual({ checked: 0, failed: 0 });
    expect(ciCalls()).toBe(calls);
  });

  it("hands each PR's failed CI to a request in that PR's own worktree", async () => {
    const { run, sessionId } = await ciEpic();
    const main = (await getMainLane(db, run))!;
    // A second lane, with its own PR in the other repository.
    const webUrl = "https://github.com/acme/web/pull/8";
    scm.changeRequests.push({
      number: 8,
      url: webUrl,
      fullPath: "acme/web",
      sourceBranch: main.branch,
      targetBranch: "main",
      title: "Web",
      body: "",
      draft: false,
      state: "open",
      headSha: "head1",
    });
    const [web] = await db
      .insert(ralphLanes)
      .values({
        runId: run.id,
        repositoryId: otherRepoId,
        branch: main.branch,
        baseBranch: "main",
        prNumber: 8,
        prUrl: webUrl,
        publish: { status: "published", created: true },
      })
      .returning();
    setCi(failed("head1"));
    setCi(failed("head1"), "acme/web", 8);
    scm.ciJobLogs.set("1", "FAIL");

    await reconcileCi(deps());
    // Both PRs are handled in one pass: the main lane's request runs first.
    const first = await start(run.id);
    expect(first).toMatchObject({ type: "ralph.request", repositoryId: repoId });
    expect(RalphRequestPayload.parse(ralphJobPayload(first)).requests[0]!.text).toContain(
      `pull request #1 (${scm.changeRequests[0]!.url}) failed on \`head1\``,
    );
    await finish(first, requestResult());
    const second = await start(run.id);
    expect(second).toMatchObject({ type: "ralph.request", repositoryId: otherRepoId });
    const payload = RalphRequestPayload.parse(ralphJobPayload(second));
    expect(payload.requests[0]!.text).toContain(`pull request #8 (${webUrl}) failed on \`head1\``);
    expect(payload).toMatchObject({ branch: main.branch });
    await finish(second, requestResult());

    expect(await getLane(db, web!.id)).toMatchObject({ ciFixRounds: 1, handledCiShas: ["head1"] });
    expect(await getMainLane(db, run)).toMatchObject({ ciFixRounds: 1, handledCiShas: ["head1"] });
    expect(await listPendingRequests(db, run.id)).toEqual([]);
    expect(
      linear
        .bodies(sessionId, "thought")
        .filter((b) => b.startsWith("CI failed on the pull request")),
    ).toHaveLength(2);
    expect((await getRun(db, run.id))?.status).toBe("completed");
  });

  describe("webhooks", () => {
    const workflowRun = (
      conclusion: string,
      pullRequests: number[],
      options: { delivery?: string; branch?: string } = {},
    ) =>
      new Request("http://localhost/api/webhooks/github", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "workflow_run",
          "x-github-delivery": options.delivery ?? randomUUID(),
        },
        body: JSON.stringify({
          action: "completed",
          installation: { id: 1 },
          repository: { id: 1, full_name: "acme/api" },
          workflow_run: {
            head_sha: "head1",
            head_branch: options.branch ?? "feature",
            conclusion,
            pull_requests: pullRequests.map((number) => ({ number })),
          },
        }),
      });

    const webhook = (req: Request) =>
      handleWebhook("github", req, {
        db,
        dispatcher,
        adapterFor: () => scm.asAdapter(),
        linear: async () => linear,
      });

    it("acts on a failed workflow run of a ralph PR once per delivery and head commit", async () => {
      const { run, sessionId } = await ciEpic();
      setCi(failed("head1"));

      // Unverified deliveries are refused.
      scm.webhookValid = false;
      expect((await webhook(workflowRun("failure", [1]))).status).toBe(401);
      scm.webhookValid = true;
      expect(await requestJobs(run.id)).toHaveLength(0);

      // Passing runs and PRs that aren't ralph's are ignored.
      expect(await (await webhook(workflowRun("success", [1]))).json()).toEqual({
        status: "ignored",
        reason: "ci_not_failed",
      });
      expect(await (await webhook(workflowRun("failure", [99]))).json()).toEqual({
        status: "ignored",
        reason: "not_ralph",
      });
      expect(scm.calls).not.toContain("getCiStatus");

      const delivery = randomUUID();
      const res = await webhook(workflowRun("failure", [1], { delivery }));
      expect(await res.json()).toEqual({ status: "accepted", event: "ci_failure" });
      expect(await requestJobs(run.id)).toHaveLength(1);
      expect(linear.bodies(sessionId, "thought")).toContain(
        "CI failed on the pull request (`head1`: `CI / test`). Working on a fix.",
      );

      // A redelivery is a no-op.
      expect(await (await webhook(workflowRun("failure", [1], { delivery }))).json()).toEqual({
        status: "duplicate",
      });
      // Another workflow failing on the same head commit isn't acted on again.
      await finish(await start(run.id), requestResult());
      await webhook(workflowRun("timed_out", [1]));
      expect(await requestJobs(run.id)).toHaveLength(1);
      expect((await getMainLane(db, run))?.ciFixRounds).toBe(1);
    });

    it("finds the ralph PR by branch when the workflow run names none", async () => {
      const { run } = await ciEpic();
      const branch = (await getMainLane(db, run))!.branch;
      setCi(failed("head1"));
      expect(await (await webhook(workflowRun("failure", [], { branch: "other" }))).json()).toEqual(
        { status: "ignored", reason: "not_ralph" },
      );
      expect(await (await webhook(workflowRun("failure", [], { branch }))).json()).toEqual({
        status: "accepted",
        event: "ci_failure",
      });
      expect(await requestJobs(run.id)).toHaveLength(1);
    });
  });
});
