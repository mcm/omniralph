import { randomBytes } from "node:crypto";
import {
  agents,
  completeJob,
  connectRepository,
  closeDb,
  createDb,
  createReview,
  createReviewRun,
  documentationRequests,
  insertDocumentationRequest,
  listDocumentationRequests,
  getJob,
  getMainLane,
  getRun,
  getRunBySession,
  jobs,
  ralphRuns,
  reviewRuns,
  reviews,
  claimJob,
  repositories,
  updateRepositoryCoding,
  upsertScmConnection,
  type Database,
  type Job,
  type RalphRun,
  organizations,
} from "@omniralph/db";
import { teamIs, setRoutingRules } from "@/lib/routing/testing";
import {
  TRACKER_PROTOCOL_MIN_AGENT_VERSION,
  MAX_JOB_DELIVERIES,
  RalphRequestPayload,
  type RalphRequestResult,
  type RalphStoryResult,
} from "@omniralph/shared";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
  setCodingEnabled,
} from "@omniralph/db/testing";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresDispatcher } from "@/lib/dispatch/dispatcher";
import { FakeLinearGateway } from "@omniralph/tracker/linear/testing";
import { FakeScmAdapter } from "@/lib/scm/fake-adapter";
import { onDocumentationCheckForRalph, onRalphJobFinished, onRalphJobStarted } from "./jobs";
import { ralphJobPayload } from "./coding";
import { acceptTaskVerifier } from "./testing";
import { respondToDocumentationCheck } from "./pull-request-requests";
import { startRun, type StartRunDeps } from "./start";

vi.mock("server-only", () => ({}));
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const databaseAvailable = testDatabaseAvailable();

const sha = (n: number) => n.toString(16).padStart(40, "0");

const EPIC_DESCRIPTION = `Build the thing.

## Quality Gates
- \`pnpm test\`
`;

describe.skipIf(!databaseAvailable)("documentation updates on ralph pull requests", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let repoId: string;
  let otherRepoId: string;
  let agentA: string;
  let tracker: FakeLinearGateway;
  let dispatcher: PostgresDispatcher;
  let scm: FakeScmAdapter;
  let sessionSeq = 0;

  const deps = (): StartRunDeps => ({
    db,
    organizationId: orgId,
    tracker,
    dispatcher,
    adapterFor: () => scm.asAdapter(),
  });

  const ralphOn = async (
    id: string,
    policy: { respondToReviewsAndCi?: boolean; openPullRequestEarly?: boolean } = {},
  ) => {
    await db
      .update(repositories)
      .set({ requestPlaybookId: "builtin:handle-request" })
      .where(eq(repositories.id, id));
    await setCodingEnabled(db, id);
    return updateRepositoryCoding(db, id, {
      respondToReviewsAndCi: true,
      openPullRequestEarly: false,
      ...policy,
    });
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
        fullPath: "acme/other",
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
    await db.delete(reviews);
    await db.delete(documentationRequests);
    await db.delete(agents);
    [{ id: agentA }] = (await db
      .insert(agents)
      .values([
        {
          organizationId: orgId,
          name: "agent-a",
          reportedAcceptedTaskTypes: ["query", "review", "coding"],
        },
      ])
      .returning({ id: agents.id })) as [{ id: string }];
    await ralphOn(repoId);
    await ralphOn(otherRepoId);
    await db
      .update(repositories)
      .set({ documentationCheck: "update" })
      .where(eq(repositories.id, repoId));
    tracker = new FakeLinearGateway();
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
      agentId: agentA,
      acceptedTaskTypes: ["query", "coding"],
      pools: ["short", "long"],
      agentVersion: TRACKER_PROTOCOL_MIN_AGENT_VERSION,
      maxDeliveries: MAX_JOB_DELIVERIES,
    });
    expect(started.claim?.job.id).toBe(job!.id);
    expect(await onRalphJobStarted(db, job!, agentA)).toEqual({ skip: false });
    return job!;
  }

  async function finish(job: Job, result: Record<string, unknown>): Promise<void> {
    expect(await completeJob(db, { jobId: job.id, agentId: agentA, result })).toEqual({
      status: "completed",
    });
    await onRalphJobFinished(db, (await getJob(db, job.id))!, deps());
    if (job.type === "ralph.story") await acceptTaskVerifier(db, deps(), job.ralphRunId!, agentA);
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
    summary: "Fixed the findings.",
    error: null,
    sessionId: "claude-req-1",
    usage: { inputTokens: 1, outputTokens: 1 },
    durationMs: 10,
    ...overrides,
  });

  /** A finished epic with PR #1 open (head `head1`), ready to receive reviews. */
  async function reviewedEpic(): Promise<{ run: RalphRun; sessionId: string }> {
    const epic = tracker.add({ identifier: "ENG-1", title: "Epic", description: EPIC_DESCRIPTION });
    tracker.add({ identifier: "ENG-2", title: "Alpha", parentId: epic.id });
    sessionSeq += 1;
    const sessionId = `session-${sessionSeq}`;
    await startRun(
      {
        kind: "issue_delegated",
        sessionId,
        issueId: epic.id,
        creatorName: "Steve",
      },
      deps(),
    );
    const run = (await getRunBySession(db, sessionId))!;
    const story = await start(run.id);
    await finish(story, storyResult({ commitSha: sha(1) }));
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
    expect(await getMainLane(db, run)).toMatchObject({ prNumber: 1 });
    return { run: (await getRun(db, run.id))!, sessionId };
  }

  const README = {
    path: "README.md",
    reason: "Shows the old `--fast` flag.",
    suggestion: "Run `tool --quick`.",
  };
  const SETUP = { path: "docs/setup.md", reason: "Describes the removed `cache` setting." };

  /** A documentation check of PR #1 at `headSha` that ended with `updates` confirmed. */
  async function docsCheck(
    options: {
      headSha?: string;
      updates?: { path: string; reason: string; suggestion?: string }[];
      status?: "completed" | "failed";
    } = {},
  ): Promise<string> {
    const target = {
      repositoryId: repoId,
      prNumber: 1,
      headSha: options.headSha ?? "head1",
      baseSha: sha(9),
      trigger: "webhook" as const,
      depth: "standard" as const,
    };
    const reviewRun = await createReviewRun(db, { ...target, organizationId: orgId, mode: "full" });
    await db.update(reviewRuns).set({ status: "completed" }).where(eq(reviewRuns.id, reviewRun.id));
    const created = await createReview(db, {
      ...target,
      reviewRunId: reviewRun.id,
      taskId: "builtin:check-docs",
      model: null,
      budget: 200_000,
    });
    await db
      .update(reviews)
      .set({
        status: options.status ?? "completed",
        documentationUpdates: options.updates ?? [README, SETUP],
      })
      .where(eq(reviews.id, created.id));
    return created.id;
  }

  const requestJobs = async (runId: string) =>
    (await db.select().from(jobs).where(eq(jobs.ralphRunId, runId))).filter(
      (j) => j.type === "ralph.request",
    );

  /** PR #1 moves to `headSha`, as after Om's push. */
  const pushed = (headSha: string) => {
    scm.changeRequests[0]!.headSha = headSha;
  };

  it("hands a check's confirmed updates to the run as one request, shipped by the request session", async () => {
    const { run, sessionId } = await reviewedEpic();
    const branch = (await getMainLane(db, run))!.branch;
    const reviewId = await docsCheck();

    expect(await onDocumentationCheckForRalph(db, reviewId, deps())).toEqual({
      status: "handed_off",
      paths: ["README.md", "docs/setup.md"],
      delivery: "started",
      runId: run.id,
    });
    const [job, ...more] = await requestJobs(run.id);
    expect(more).toEqual([]);
    const text = RalphRequestPayload.parse(ralphJobPayload(job!)).requests[0]!.text;
    expect(text).toContain(
      `Omniralph's documentation check found 2 documentation files that pull request #1 (${scm.changeRequests[0]!.url}) makes wrong or incomplete.`,
    );
    expect(text).toContain("1. `README.md`: Shows the old `--fast` flag.");
    expect(text).toContain("Run `tool --quick`.");
    expect(text).toContain("2. `docs/setup.md`: Describes the removed `cache` setting.");
    expect(text).toContain(`push \`${branch}\` as a normal commit`);
    expect(text).toContain("Don't force-push");
    expect(tracker.bodies(sessionId, "thought")).toContain(
      "Omniralph's documentation check found 2 files to update on the pull request. Working through it.",
    );
    expect(await listDocumentationRequests(db, repoId, 1)).toMatchObject([
      { headSha: "head1", reviewId, ralphRunId: run.id, paths: ["README.md", "docs/setup.md"] },
    ]);

    // Another check of the same head (a rerun, a replay) doesn't ask again.
    const again = await docsCheck({ updates: [SETUP] });
    expect(await respondToDocumentationCheck(deps(), again)).toEqual({
      status: "handed_off",
      paths: ["README.md", "docs/setup.md"],
      delivery: "earlier",
      runId: run.id,
    });
    expect(await requestJobs(run.id)).toHaveLength(1);
    expect(await listDocumentationRequests(db, repoId, 1)).toHaveLength(1);

    // The request session commits and pushes the docs; the run completes again.
    await finish(await start(run.id), requestResult({ summary: "Updated the docs." }));
    expect((await getRun(db, run.id))?.status).toBe("completed");
    expect(tracker.bodies(sessionId, "response").at(-1)).toContain("Updated the docs.");
  });

  it("doesn't ask again for the files Om's docs commit was made for", async () => {
    const { run } = await reviewedEpic();
    await respondToDocumentationCheck(deps(), await docsCheck());
    await finish(await start(run.id), requestResult());
    // Om's commit is the new head; the check still reports some of the same files.
    pushed("head2");
    const repeated = await docsCheck({ headSha: "head2", updates: [README] });
    expect(await respondToDocumentationCheck(deps(), repeated)).toEqual({
      status: "repeated",
      paths: ["README.md"],
    });
    expect(await requestJobs(run.id)).toHaveLength(1);
    expect(await listDocumentationRequests(db, repoId, 1)).toHaveLength(1);
    expect((await getRun(db, run.id))?.status).toBe("completed");
  });

  it("makes at most three requests per pull request, then leaves the rest to a person", async () => {
    const { run } = await reviewedEpic();
    const files = ["a.md", "b.md", "c.md", "d.md"];
    for (const [i, file] of files.slice(0, 3).entries()) {
      pushed(`head${i + 1}`);
      const reviewId = await docsCheck({
        headSha: `head${i + 1}`,
        updates: [{ path: file, reason: "Out of date." }],
      });
      expect(await respondToDocumentationCheck(deps(), reviewId)).toMatchObject({
        status: "handed_off",
        paths: [file],
      });
      await finish(await start(run.id), requestResult());
    }
    pushed("head4");
    const fourth = await docsCheck({
      headSha: "head4",
      updates: [{ path: "d.md", reason: "Out of date." }],
    });
    expect(await respondToDocumentationCheck(deps(), fourth)).toEqual({
      status: "limit",
      requests: 3,
    });
    expect(await requestJobs(run.id)).toHaveLength(3);
    expect(await listDocumentationRequests(db, repoId, 1)).toHaveLength(3);
  });

  it("records one request per head", async () => {
    await reviewedEpic();
    await insertDocumentationRequest(db, {
      repositoryId: repoId,
      prNumber: 1,
      headSha: "head1",
      reviewId: null,
      ralphRunId: null,
      paths: ["README.md"],
    });
    expect(
      await insertDocumentationRequest(db, {
        repositoryId: repoId,
        prNumber: 1,
        headSha: "head1",
        reviewId: null,
        ralphRunId: null,
        paths: ["docs/setup.md"],
      }),
    ).toBeNull();
    expect(await listDocumentationRequests(db, repoId, 1)).toMatchObject([
      { paths: ["README.md"] },
    ]);
  });

  it("gives a stopped or failed run no request", async () => {
    const { run } = await reviewedEpic();
    for (const status of ["stopped", "failed"] as const) {
      await db.update(ralphRuns).set({ status }).where(eq(ralphRuns.id, run.id));
      expect(await respondToDocumentationCheck(deps(), await docsCheck())).toEqual({
        status: "ignored",
        reason: "run_over",
      });
    }
    expect(await requestJobs(run.id)).toEqual([]);
    expect(await listDocumentationRequests(db, repoId, 1)).toEqual([]);
    expect((await getRun(db, run.id))?.status).toBe("failed");
  });

  it("asks nothing outside Update mode, for an old head, or for a check with no updates", async () => {
    const { run } = await reviewedEpic();
    expect(await respondToDocumentationCheck(deps(), await docsCheck({ updates: [] }))).toEqual({
      status: "ignored",
      reason: "no_updates",
    });
    expect(
      await respondToDocumentationCheck(deps(), await docsCheck({ status: "failed" })),
    ).toEqual({
      status: "ignored",
      reason: "not_completed",
    });
    pushed("head2");
    expect(await respondToDocumentationCheck(deps(), await docsCheck())).toEqual({
      status: "ignored",
      reason: "stale",
    });
    await db
      .update(repositories)
      .set({ documentationCheck: "comment" })
      .where(eq(repositories.id, repoId));
    expect(
      await respondToDocumentationCheck(deps(), await docsCheck({ headSha: "head2" })),
    ).toEqual({ status: "ignored", reason: "not_update_mode" });
    expect(await requestJobs(run.id)).toEqual([]);
    expect(await listDocumentationRequests(db, repoId, 1)).toEqual([]);
  });
});
