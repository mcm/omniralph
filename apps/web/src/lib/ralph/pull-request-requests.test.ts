import { randomBytes } from "node:crypto";
import {
  harnesses,
  completeJob,
  connectRepository,
  closeDb,
  createDb,
  createReview,
  findings,
  getJob,
  getLane,
  getMainLane,
  getRun,
  getRunBySession,
  jobs,
  listPendingRequests,
  listReviewFindings,
  listMessages,
  ralphRuns,
  reviews,
  runMigrations,
  claimJob,
  updateRepositoryRalphSettings,
  upsertScmConnection,
  DEFAULT_RALPH_SETTINGS,
  type Database,
  type FindingRow,
  type Job,
  type RalphRun,
  organizations,
  seedReviewProfiles,
} from "@omniralph/db";
import {
  MAX_JOB_DELIVERIES,
  RalphRequestPayload,
  type RalphRequestResult,
  type RalphStoryResult,
} from "@omniralph/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq, inArray } from "drizzle-orm";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresDispatcher } from "@/lib/dispatch/dispatcher";
import { FakeLinearGateway } from "@/lib/linear/fake-gateway";
import { FakeScmAdapter } from "@/lib/scm/fake-adapter";
import { onRalphJobFinished, onRalphJobStarted, onReviewForRalph } from "./jobs";
import { exchangeJobMessages } from "./messages";
import { respondToReview } from "./pull-request-requests";
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

describe.skipIf(!dockerAvailable)("Omniralph reviews of ralph pull requests", () => {
  let container: StartedPostgreSqlContainer;
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
      linearTeamKeys: id === repoId ? ["ENG"] : [],
      linearProjectNames: [],
      linearLabels: [],
      ralphSettings: { ...DEFAULT_RALPH_SETTINGS, ...settings },
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
    otherRepoId = (
      await connectRepository(db, {
        connectionId: connection.id,
        provider: "github",
        externalId: "2",
        fullPath: "acme/other",
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
    await db.delete(reviews);
    await db.delete(harnesses);
    [{ id: agentA }] = (await db
      .insert(harnesses)
      .values([
        { organizationId: orgId, name: "agent-a", enabledCapabilities: ["review", "ralph"] },
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
      capabilities: ["ralph"],
      enabledCapabilities: ["ralph"],
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
    summary: "Fixed the findings.",
    error: null,
    sessionId: "claude-req-1",
    usage: { inputTokens: 1, outputTokens: 1 },
    durationMs: 10,
    ...overrides,
  });

  /** A finished epic with PR #1 open (head `head1`), ready to receive reviews. */
  async function reviewedEpic(): Promise<{ run: RalphRun; sessionId: string }> {
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
    const story = await start(run.id);
    await finish(story, storyResult({ commitSha: sha(1) }));
    const describe = await start(run.id);
    expect(describe.type).toBe("ralph.describe-pr");
    await finish(describe, {
      title: "Build the epic",
      body: "Builds it.",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect((await getRun(db, run.id))?.status).toBe("completed");
    expect(scm.changeRequests).toHaveLength(1);
    scm.changeRequests[0]!.headSha = "head1";
    expect(await getMainLane(db, run)).toMatchObject({ prNumber: 1 });
    return { run: (await getRun(db, run.id))!, sessionId };
  }

  /** A completed Omniralph review of `prNumber` at `headSha`, with `count` open findings (and a dismissed one). */
  async function review(
    options: { prNumber?: number; headSha?: string; count?: number; repositoryId?: string } = {},
  ) {
    const created = await createReview(db, {
      repositoryId: options.repositoryId ?? repoId,
      prNumber: options.prNumber ?? 1,
      headSha: options.headSha ?? "head1",
      baseSha: sha(9),
      trigger: "webhook",
      profileId: "standard",
      model: null,
      budget: 200_000,
    });
    await db.update(reviews).set({ status: "completed" }).where(eq(reviews.id, created.id));
    const count = options.count ?? 1;
    const row = (i: number) => ({
      reviewId: created.id,
      path: "src/a.ts",
      startLine: 3 + i,
      endLine: 4 + i,
      severity: "high" as const,
      category: "correctness",
      title: `Possible null dereference ${i + 1}`,
      body: "`load()` can return undefined.",
      suggestion: "if (!x) return;",
      confidence: 0.9,
    });
    await db
      .insert(findings)
      .values([
        ...Array.from({ length: count }, (_, i) => row(i)),
        { ...row(0), title: "Dismissed one", status: "dismissed" as const },
      ]);
    return created;
  }

  const requestJobs = async (runId: string) =>
    (await db.select().from(jobs).where(eq(jobs.ralphRunId, runId))).filter(
      (j) => j.type === "ralph.request",
    );

  it("works through a review's open findings on the epic branch", async () => {
    const { run, sessionId } = await reviewedEpic();
    const branch = (await getMainLane(db, run))!.branch;
    const reviewed = await review();
    // The review outcome handler hands it to the run.
    await onReviewForRalph(db, reviewed.id, deps());

    const [job] = await requestJobs(run.id);
    expect(job).toBeDefined();
    const payload = RalphRequestPayload.parse(job!.payload);
    expect(payload.requests).toHaveLength(1);
    const text = payload.requests[0]!.text;
    expect(text).toContain(
      `Omniralph reviewed pull request #1 (${scm.changeRequests[0]!.url}) and left 1 open finding.`,
    );
    expect(text).toContain("`src/a.ts:3` (high): **Possible null dereference 1**");
    expect(text).toContain("`load()` can return undefined.");
    expect(text).toContain("if (!x) return;");
    expect(text).toContain(`push \`${branch}\``);
    expect(text).not.toContain("Dismissed one");
    expect(linear.bodies(sessionId, "thought")).toContain(
      "Omniralph reviewed the pull request with 1 finding. Working through it.",
    );
    expect(await getMainLane(db, run)).toMatchObject({
      reviewRounds: 1,
      handledReviewIds: [reviewed.id],
    });
    expect((await getRun(db, run.id))?.status).toBe("running");

    // The same review again (a replayed result) is not acted on twice.
    expect(await respondToReview(deps(), reviewed.id)).toEqual({
      status: "ignored",
      reason: "handled",
    });
    expect(await requestJobs(run.id)).toHaveLength(1);

    // The request session pushes the fixes; the run completes again with what it said.
    await finish(await start(run.id), requestResult());
    expect((await getRun(db, run.id))?.status).toBe("completed");
    expect(linear.bodies(sessionId, "response").at(-1)).toContain("Fixed the findings.");
  });

  it("replies in the threads of the findings the session reported on, and resolves the fixed ones", async () => {
    const { run, sessionId } = await reviewedEpic();
    const reviewed = await review({ count: 3 });
    const rows = (await listReviewFindings(db, reviewed.id)).filter((f) => f.status === "open");
    const [fixed, skipped, summaryOnly] = rows as [FindingRow, FindingRow, FindingRow];
    await db.update(findings).set({ scmCommentId: "c-fixed" }).where(eq(findings.id, fixed.id));
    await db.update(findings).set({ scmCommentId: "c-skipped" }).where(eq(findings.id, skipped.id));
    // A finding of another PR's review is never touched.
    const other = await review({ prNumber: 99 });
    const [foreign] = (await listReviewFindings(db, other.id)).filter((f) => f.status === "open");
    await db
      .update(findings)
      .set({ scmCommentId: "c-foreign" })
      .where(eq(findings.id, foreign!.id));
    await onReviewForRalph(db, reviewed.id, deps());

    const [job] = await requestJobs(run.id);
    const text = RalphRequestPayload.parse(job!.payload).requests[0]!.text;
    expect(text).toContain(`[finding \`${fixed.id}\`]`);
    expect(text).toContain("structured result's `findings`");

    await finish(
      await start(run.id),
      requestResult({
        findings: [
          { findingId: fixed.id, outcome: "fixed", comment: "Guarded `load()` before use." },
          { findingId: skipped.id, outcome: "skipped", comment: "It can't be undefined here." },
          { findingId: summaryOnly.id, outcome: "fixed", comment: "Fixed too." },
          { findingId: foreign!.id, outcome: "fixed", comment: "Not this PR's." },
        ],
      }),
    );

    const status = async (id: string) =>
      (await db.select().from(findings).where(eq(findings.id, id)))[0]?.status;
    expect(await status(fixed.id)).toBe("resolved");
    expect(await status(summaryOnly.id)).toBe("resolved");
    expect(await status(skipped.id)).toBe("open");
    expect(await status(foreign!.id)).toBe("open");
    expect(scm.replies).toEqual([
      {
        fullPath: "acme/api",
        number: 1,
        commentId: "c-fixed",
        body: "Fixed: Guarded `load()` before use.",
      },
      {
        fullPath: "acme/api",
        number: 1,
        commentId: "c-skipped",
        body: "Not changed: It can't be undefined here.",
      },
    ]);
    expect(scm.resolvedThreads).toEqual(["c-fixed"]);
    expect(linear.bodies(sessionId, "response").at(-1)).toContain(
      "Resolved 2 fixed review findings.",
    );
  });

  it("keeps a fixed finding resolved when its thread can't be replied to or resolved", async () => {
    const { run } = await reviewedEpic();
    const reviewed = await review();
    const [finding] = (await listReviewFindings(db, reviewed.id)).filter(
      (f) => f.status === "open",
    );
    await db.update(findings).set({ scmCommentId: "c-1" }).where(eq(findings.id, finding!.id));
    await onReviewForRalph(db, reviewed.id, deps());
    scm.failures.set("replyToComment", "boom");
    scm.failures.set("resolveThread", "boom");
    await finish(
      await start(run.id),
      requestResult({
        findings: [{ findingId: finding!.id, outcome: "fixed", comment: "Done." }],
      }),
    );
    const [row] = await db.select().from(findings).where(eq(findings.id, finding!.id));
    expect(row?.status).toBe("resolved");
    expect(scm.calls).toEqual(expect.arrayContaining(["replyToComment", "resolveThread"]));
    expect((await getRun(db, run.id))?.status).toBe("completed");
  });

  it("leaves findings open when the session reported an error", async () => {
    const { run } = await reviewedEpic();
    const reviewed = await review();
    const [finding] = (await listReviewFindings(db, reviewed.id)).filter(
      (f) => f.status === "open",
    );
    await db.update(findings).set({ scmCommentId: "c-1" }).where(eq(findings.id, finding!.id));
    await onReviewForRalph(db, reviewed.id, deps());
    await finish(
      await start(run.id),
      requestResult({
        error: "the push failed",
        findings: [{ findingId: finding!.id, outcome: "fixed", comment: "Done." }],
      }),
    );
    const [row] = await db.select().from(findings).where(eq(findings.id, finding!.id));
    expect(row?.status).toBe("open");
    expect(scm.replies).toEqual([]);
    expect(scm.resolvedThreads).toEqual([]);
  });

  it("ignores other PRs, other repositories, stale commits, closed PRs and repositories that opted out", async () => {
    const { run } = await reviewedEpic();
    expect(await respondToReview(deps(), (await review({ prNumber: 99 })).id)).toEqual({
      status: "ignored",
      reason: "not_ralph",
    });
    expect(await respondToReview(deps(), (await review({ repositoryId: otherRepoId })).id)).toEqual(
      { status: "ignored", reason: "not_ralph" },
    );
    // A review with no open findings does nothing.
    const clean = await review({ count: 0 });
    expect(await respondToReview(deps(), clean.id)).toEqual({ status: "no_findings" });
    // A review of an older commit is recorded as handled and skipped.
    const stale = await review({ headSha: "old" });
    expect(await respondToReview(deps(), stale.id)).toEqual({ status: "stale" });
    expect((await getMainLane(db, run))?.handledReviewIds).toContain(stale.id);
    expect(await requestJobs(run.id)).toHaveLength(0);
    expect((await getMainLane(db, run))?.reviewRounds).toBe(0);
    expect((await getRun(db, run.id))?.status).toBe("completed");

    // Opted out.
    await ralphOn(repoId, { respondToReviews: false });
    expect(await respondToReview(deps(), (await review()).id)).toEqual({
      status: "ignored",
      reason: "opted_out",
    });
    await ralphOn(repoId);

    // A stopped run.
    await db.update(ralphRuns).set({ status: "stopped" }).where(eq(ralphRuns.id, run.id));
    expect(await respondToReview(deps(), (await review()).id)).toEqual({
      status: "ignored",
      reason: "run_over",
    });
    await db.update(ralphRuns).set({ status: "completed" }).where(eq(ralphRuns.id, run.id));

    // A merged PR: the lane records it and isn't followed up any more.
    scm.changeRequests[0]!.state = "merged";
    scm.changeRequests[0]!.mergeSha = sha(5);
    expect(await respondToReview(deps(), (await review()).id)).toEqual({
      status: "ignored",
      reason: "closed",
    });
    expect(await getMainLane(db, run)).toMatchObject({
      prClosed: true,
      prMerged: true,
      mergeSha: sha(5),
    });
    expect(await requestJobs(run.id)).toHaveLength(0);
  });

  it("stops after maxReviewRounds and says so in the session", async () => {
    await ralphOn(repoId, { maxReviewRounds: 1 });
    const { run, sessionId } = await reviewedEpic();
    expect(await respondToReview(deps(), (await review()).id)).toMatchObject({
      status: "started",
    });
    await finish(await start(run.id), requestResult());
    scm.changeRequests[0]!.headSha = "head2";
    expect(await respondToReview(deps(), (await review({ headSha: "head2" })).id)).toEqual({
      status: "round_limit",
      rounds: 1,
    });
    expect(await requestJobs(run.id)).toHaveLength(1);
    expect(linear.bodies(sessionId, "response").at(-1)).toBe(
      `Omniralph reviewed ${scm.changeRequests[0]!.url} again. I've already worked through 1 of its reviews on this pull request, so I'm leaving this one for a person.`,
    );
  });

  it("lists at most 25 findings in the request", async () => {
    const { run } = await reviewedEpic();
    await respondToReview(deps(), (await review({ count: 27 })).id);
    const [job] = await requestJobs(run.id);
    const text = RalphRequestPayload.parse(job!.payload).requests[0]!.text;
    expect(text).toContain("left 27 open findings");
    expect(text).toContain("25. `src/a.ts:27`");
    expect(text).toContain("(2 more findings not shown; see the review on the pull request.)");
  });

  it("passes a review to the request job working in that lane right now", async () => {
    const { run, sessionId } = await reviewedEpic();
    expect(await respondToReview(deps(), (await review()).id)).toMatchObject({
      status: "started",
    });
    const job = await start(run.id);
    scm.changeRequests[0]!.headSha = "head2";
    expect(await respondToReview(deps(), (await review({ headSha: "head2" })).id)).toMatchObject({
      status: "live",
    });
    expect(linear.bodies(sessionId, "thought").at(-1)).toBe(
      "Omniralph reviewed the pull request with 1 finding. Passing it to the agent that's working right now.",
    );
    // The heartbeat delivers it to the running job.
    const delivered = await exchangeJobMessages(
      { db, linear: async () => linear },
      agentA,
      [job.id],
      { deliveredMessageIds: [], rejectedMessageIds: [] },
    );
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).toContain("Omniralph reviewed pull request #1");
    await exchangeJobMessages({ db, linear: async () => linear }, agentA, [job.id], {
      deliveredMessageIds: [delivered[0]!.messageId],
      rejectedMessageIds: [],
    });
    await finish(job, requestResult());
    // Delivered: no second request job.
    expect(await requestJobs(run.id)).toHaveLength(1);
    expect(await listPendingRequests(db, run.id)).toEqual([]);
    expect((await getMainLane(db, run))?.reviewRounds).toBe(2);
  });

  it("queues a review while a story runs, and runs it as a request after the loop", async () => {
    const epic = linear.add({ identifier: "ENG-1", title: "Epic", description: EPIC_DESCRIPTION });
    linear.add({ identifier: "ENG-2", title: "Alpha", parentId: epic.id, priority: 1 });
    linear.add({ identifier: "ENG-3", title: "Beta", parentId: epic.id, priority: 2 });
    await ralphOn(repoId, { openPullRequestEarly: true });
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
    // The draft PR opened early; the second story is running.
    expect(scm.changeRequests).toHaveLength(1);
    const story = await start(run.id);
    expect(story.type).toBe("ralph.story");
    expect(await respondToReview(deps(), (await review({ headSha: "head" })).id)).toMatchObject({
      status: "queued",
    });
    expect(linear.bodies(sessionId, "thought").at(-1)).toBe(
      "Omniralph reviewed the pull request with 1 finding. I'll work through it as soon as the current step finishes.",
    );
    // A story agent never gets it: it waits for the loop to end.
    expect(await listMessages(db, run.id)).toMatchObject([{ kind: "request", jobId: null }]);
    await finish(story, storyResult({ commitSha: sha(2) }));
    const request = await start(run.id);
    expect(request.type).toBe("ralph.request");
    const lane = await getLane(db, (await getMainLane(db, run))!.id);
    expect(lane?.reviewRounds).toBe(1);
  });
});
