import { randomBytes } from "node:crypto";
import {
  closeDb,
  connectRepository,
  createDb,
  findings,
  getJob,
  jobs,
  listRunIterations,
  organizations,
  reviewRuns,
  reviews,
  upsertScmConnection,
  type Database,
  type Job,
  type Review,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import type { ChangeRequest, InlineComment, ScmAdapter } from "@omniralph/scm";
import {
  CORRELATION_JOB_TYPE,
  CorrelationTriggerContext,
  FINDING_VERIFICATION_JOB_TYPE,
  FindingVerificationTriggerContext,
  RunSpecJobPayload,
  reviewTriggerContext,
  type Finding,
  type ReviewCheckType,
  type ReviewDepth,
  type ReviewTaskResult,
} from "@omniralph/shared";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Adapters from "@/lib/scm/adapters";

vi.mock("server-only", () => ({}));

const HEAD = "f".repeat(40);
const BASE = "a".repeat(40);

/** A code host that records posted reviews; everything else isn't used. */
function fakeScm() {
  const posted: { number: number; summary: string; inlineComments: InlineComment[] }[] = [];
  const known: Partial<ScmAdapter> = {
    provider: "github",
    async getChangeRequest(_repo, number): Promise<ChangeRequest> {
      return {
        number,
        title: "Add login",
        description: "",
        author: "octocat",
        draft: false,
        state: "open",
        baseSha: BASE,
        headSha: HEAD,
        baseRef: "main",
        headRef: "feature",
        url: `https://github.com/acme/app/pull/${number}`,
      };
    },
    async postReview(_repo, number, review) {
      posted.push({ number, summary: review.summary, inlineComments: review.inlineComments });
      return {
        reviewId: `review-${posted.length}`,
        summaryCommentId: `summary-${posted.length}`,
        inlineCommentIds: review.inlineComments.map((_, i) => `c-${posted.length}-${i}`),
      };
    },
  };
  const adapter = new Proxy(known, {
    get: (target, prop: string) =>
      prop in target
        ? target[prop as keyof ScmAdapter]
        : async () => {
            throw new Error(`${prop} isn't used`);
          },
  }) as ScmAdapter;
  return { adapter, posted };
}

const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  scm: undefined as unknown as ReturnType<typeof fakeScm>,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/scm/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof Adapters>()),
  scmAdapterFor: () => state.scm.adapter,
}));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.APP_URL = "https://omniralph.example.com";

const { enqueueReview } = await import("./enqueue");
const { getDispatcher } = await import("@/lib/dispatch");
const { jobHooks } = await import("@/lib/sinks");
const { organizationPlaybooks } = await import("@/lib/playbooks");

const databaseAvailable = testDatabaseAvailable();

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  path: "src/app.ts",
  startLine: 2,
  endLine: 2,
  severity: "high",
  category: "correctness",
  title: "Reads past the end",
  body: "`xs[xs.length]` is undefined.",
  confidence: 0.9,
  ...overrides,
});

/** A security finding that explains how it could be exploited. */
const exploitable = finding({
  category: "security",
  title: "Token logged",
  body: "Anyone with log access reads the session token and replays it to sign in as the user.",
});
/** A security finding without an exploit. */
const vague = finding({
  startLine: 5,
  endLine: 5,
  category: "security",
  title: "Looks unsafe",
  body: "This might be insecure.",
});

const workerResult = (
  checkType: ReviewCheckType,
  found: Finding[],
  files = ["src/app.ts", "src/db.ts"],
): ReviewTaskResult => ({
  findings: found,
  usage: { inputTokens: 1000, outputTokens: 100 },
  skipped: [],
  stopReason: "completed",
  scope: { mode: "full", baseSha: BASE, headSha: HEAD },
  discarded: { invalid: 0, outsideDiff: 0, duplicate: 0 },
  durationMs: 1000,
  pass: { checkType, files },
});

const answered = (structured: unknown) => ({
  outcome: "answered",
  answer: null,
  structured,
  references: [],
  usage: { inputTokens: 300, outputTokens: 30 },
  durationMs: 500,
});

type Verdict = "confirmed" | "rejected";

/** The verifier's answer: one verdict per finding (by position), and the unreached areas. */
const verification = (
  pass: number,
  verdicts: Verdict[],
  unreached: { path: string; reason: string }[] = [],
) =>
  answered({
    verdicts: verdicts.map((verdict, i) => ({
      findingId: `p${pass}-${i + 1}`,
      verdict,
      path: "src/app.ts",
      line: 2,
      reason:
        verdict === "confirmed" ? "Line 2 has the problem." : "It doesn't say how it is exploited.",
    })),
    unreached: unreached.map((area) => ({ ...area, startLine: null, endLine: null })),
    summary: `Checked pass ${pass}.`,
  });

describe.skipIf(!databaseAvailable)("looped reviews", { timeout: 60_000 }, () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let repoId: string;
  let prCounter = 0;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
    const connection = (await upsertScmConnection(db, {
      organizationId: orgId,
      provider: "github",
      name: "acme",
      baseUrl: "https://github.com",
      externalId: "4242",
      credentials: {},
    }))!;
    repoId = (
      await connectRepository(db, {
        connectionId: connection.id,
        provider: "github",
        externalId: "100",
        fullPath: "acme/app",
      })
    ).id;
  }, 180_000);

  beforeEach(() => {
    state.scm = fakeScm();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  async function enqueue(depth: ReviewDepth, prNumber = ++prCounter, headSha = HEAD) {
    const enqueued = await enqueueReview(db, getDispatcher(), {
      repositoryId: repoId,
      prNumber,
      baseSha: BASE,
      headSha,
      title: "Add login",
      description: null,
      author: "octocat",
      trigger: "mention",
      depth,
    });
    if (enqueued.status !== "enqueued") throw new Error(enqueued.status);
    const byType = (type: ReviewCheckType) => enqueued.runs.find((r) => r.checkType === type)!;
    return { ...enqueued, prNumber, byType };
  }

  async function reviewRow(id: string): Promise<Review> {
    const [row] = await db.select().from(reviews).where(eq(reviews.id, id));
    return row!;
  }

  async function iterations(reviewId: string) {
    return listRunIterations(db, { kind: "review", id: reviewId });
  }

  /** Finishes `jobId` as the agent would report it, through its sink's hooks. */
  async function finishJob(
    jobId: string,
    outcome: { result: unknown } | { error: string },
  ): Promise<Job> {
    const [job] = await db
      .update(jobs)
      .set(
        "result" in outcome
          ? { status: "completed", result: outcome.result as Record<string, unknown> }
          : { status: "failed", error: outcome.error },
      )
      .where(eq(jobs.id, jobId))
      .returning();
    const hooks = (await jobHooks(job!, organizationPlaybooks(db, orgId)))!;
    if ("result" in outcome) await hooks.onCompleted!(db, job!);
    else await hooks.onFailed!(db, job!, outcome.error);
    return job!;
  }

  /**
   * Runs the review's current pass: its worker reports `found` over `files`,
   * then (when a verifier job started) the verifier answers `verdicts`.
   * Returns the pass's verifier job, if any.
   */
  async function runPass(
    reviewId: string,
    checkType: ReviewCheckType,
    found: Finding[],
    verdicts: Verdict[] = [],
    options: { files?: string[]; unreached?: { path: string; reason: string }[] } = {},
  ): Promise<Job | null> {
    const current = (await iterations(reviewId)).at(-1)!;
    expect(current.status).toBe("working");
    await finishJob(current.workerJobId!, {
      result: workerResult(checkType, found, options.files),
    });
    const after = (await iterations(reviewId)).find((it) => it.id === current.id)!;
    if (!after.verifierJobId) return null;
    const verifier = (await getJob(db, after.verifierJobId))!;
    await finishJob(verifier.id, {
      result: verification(current.number, verdicts, options.unreached),
    });
    return verifier;
  }

  async function correlationJob(reviewRunId: string): Promise<Job | undefined> {
    const [job] = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.reviewRunId, reviewRunId), eq(jobs.type, CORRELATION_JOB_TYPE)));
    return job;
  }

  it("fans a review task out to one looped review per check type, each starting with its first pass", async () => {
    const run = await enqueue("standard");
    expect(run.runs.map((r) => r.checkType)).toEqual([
      "security",
      "stability",
      "performance",
      "compatibility",
    ]);
    for (const taskRun of run.runs) {
      expect(await reviewRow(taskRun.reviewId)).toMatchObject({
        checkType: taskRun.checkType,
        taskId: "builtin:review-pr",
        status: "queued",
      });
      const job = (await getJob(db, taskRun.jobId))!;
      expect(reviewTriggerContext(job.payload).pass).toEqual({
        checkType: taskRun.checkType,
        number: 1,
        confirmed: [],
        unreached: [],
      });
      expect(await iterations(taskRun.reviewId)).toMatchObject([
        {
          number: 1,
          status: "working",
          workerJobId: job.id,
          verifierPlaybookId: "builtin:verify-findings",
          // Standard runs up to two passes.
          maxIterations: 2,
        },
      ]);
    }
  });

  it("verifies each pass in a fresh session, posts only confirmed findings and counts the dropped ones", async () => {
    const run = await enqueue("quick");
    const security = run.byType("security");
    const verifier = await runPass(
      security.reviewId,
      "security",
      [exploitable, vague],
      ["confirmed", "rejected"],
    );
    // The verifier is a run of builtin:verify-findings in a checkout of the head, with the
    // pass's findings by ID.
    expect(verifier).toMatchObject({
      type: FINDING_VERIFICATION_JOB_TYPE,
      taskId: "builtin:verify-findings",
      reviewRunId: run.reviewRunId,
    });
    const payload = RunSpecJobPayload.parse(verifier!.payload);
    expect(payload.ref).toBe(HEAD);
    const context = FindingVerificationTriggerContext.parse(payload.trigger.context);
    expect(context.verification).toMatchObject({
      checkType: "security",
      pass: 1,
      headSha: HEAD,
      files: "src/app.ts\nsrc/db.ts",
    });
    expect(context.verification.findings.map((f) => [f.id, f.title])).toEqual([
      ["p1-1", "Token logged"],
      ["p1-2", "Looks unsafe"],
    ]);

    await runPass(run.byType("stability").reviewId, "stability", [finding()], ["confirmed"]);
    // A pass that reported nothing needs no verifier.
    expect(await runPass(run.byType("performance").reviewId, "performance", [])).toBeNull();
    // The change has no file for compatibility: nothing was reviewed.
    await runPass(run.byType("compatibility").reviewId, "compatibility", [], [], { files: [] });

    expect(await reviewRow(security.reviewId)).toMatchObject({
      status: "completed",
      droppedFindings: 1,
      passes: [
        {
          number: 1,
          reported: 2,
          confirmed: 1,
          new: 1,
          dropped: 1,
          verification: "verified",
        },
      ],
      // The pass's worker and verifier.
      tokensIn: 1300,
    });
    expect(
      (await db.select().from(findings).where(eq(findings.reviewId, security.reviewId))).map(
        (f) => f.title,
      ),
    ).toEqual(["Token logged"]);
    expect(await reviewRow(run.byType("compatibility").reviewId)).toMatchObject({
      status: "skipped",
      error: "The change has no file for the compatibility check type.",
    });

    // The confirmed findings of every check type go to the run's correlation, as before.
    const correlation = (await correlationJob(run.reviewRunId))!;
    const correlated = CorrelationTriggerContext.parse(
      RunSpecJobPayload.parse(correlation.payload).trigger.context,
    );
    expect(
      correlated.reviewRun.tasks.items.map((task) => task.findings?.map((f) => f.title) ?? []),
    ).toEqual([["Token logged"], ["Reads past the end"], []]);
    await finishJob(correlation.id, {
      result: answered({ findings: [], summary: "Logs the session token." }),
    });

    // One review is posted for the run, without the dropped finding.
    expect(state.scm.posted).toHaveLength(1);
    expect(state.scm.posted[0]!.inlineComments.map((c) => c.body.split("\n")[0])).toEqual([
      "**[high] Token logged**",
      "**[high] Reads past the end**",
    ]);
    const [reviewRun] = await db
      .select()
      .from(reviewRuns)
      .where(eq(reviewRuns.id, run.reviewRunId));
    expect(reviewRun).toMatchObject({ status: "completed" });
  });

  it("runs the next pass over the unreached areas with what was confirmed, and stops when it adds nothing new", async () => {
    const run = await enqueue("deep");
    const stability = run.byType("stability").reviewId;
    await runPass(stability, "stability", [finding()], ["confirmed"], {
      unreached: [{ path: "src/db.ts", reason: "The new query isn't checked." }],
    });
    const second = (await iterations(stability)).at(-1)!;
    expect(second).toMatchObject({
      number: 2,
      status: "working",
      feedback: expect.stringContaining("src/db.ts: The new query isn't checked."),
    });
    const secondJob = (await getJob(db, second.workerJobId!))!;
    expect(reviewTriggerContext(secondJob.payload).pass).toEqual({
      checkType: "stability",
      number: 2,
      confirmed: [
        {
          path: "src/app.ts",
          startLine: 2,
          endLine: 2,
          severity: "high",
          category: "correctness",
          title: "Reads past the end",
        },
      ],
      unreached: [
        {
          path: "src/db.ts",
          startLine: null,
          endLine: null,
          reason: "The new query isn't checked.",
        },
      ],
    });

    // The second pass only confirms the same issue again: nothing new, so stability stops
    // before Deep's cap of three.
    await runPass(stability, "stability", [finding({ title: "Off by one" })], ["confirmed"]);
    expect((await iterations(stability)).map((it) => [it.verdict, it.outcome])).toEqual([
      ["continue", null],
      ["converged", "converged"],
    ]);
    expect(await reviewRow(stability)).toMatchObject({
      status: "completed",
      passes: [
        { number: 1, confirmed: 1, new: 1 },
        { number: 2, confirmed: 1, new: 0 },
      ],
    });
    // Its findings: the first pass's, without the repeat.
    expect(
      (await db.select().from(findings).where(eq(findings.reviewId, stability))).map(
        (f) => f.title,
      ),
    ).toEqual(["Reads past the end"]);
  });

  it.each([
    ["quick", 1],
    ["standard", 2],
    ["deep", 3],
  ] as const)("stops a check type at %s's pass cap (%i)", async (depth, cap) => {
    const run = await enqueue(depth);
    const performance = run.byType("performance").reviewId;
    // Every pass confirms a new finding: only the cap stops it.
    for (let pass = 1; pass <= cap; pass++) {
      await runPass(
        performance,
        "performance",
        [finding({ startLine: 10 * pass, endLine: 10 * pass, category: "performance" })],
        ["confirmed"],
      );
    }
    const loop = await iterations(performance);
    expect(loop).toHaveLength(cap);
    expect(loop.at(-1)).toMatchObject({ verdict: "continue", outcome: "max-iterations" });
    expect(await reviewRow(performance)).toMatchObject({ status: "completed" });
    expect(await db.select().from(findings).where(eq(findings.reviewId, performance))).toHaveLength(
      cap,
    );
  });

  it("runs security at least twice at Deep, even when its first pass finds nothing", async () => {
    const run = await enqueue("deep");
    const security = run.byType("security").reviewId;
    const stability = run.byType("stability").reviewId;
    await runPass(security, "security", []);
    await runPass(stability, "stability", []);
    // Stability stops after one empty pass; security runs its second.
    expect((await iterations(stability)).map((it) => it.outcome)).toEqual(["converged"]);
    expect((await iterations(security)).map((it) => [it.number, it.status])).toEqual([
      [1, "done"],
      [2, "working"],
    ]);
    await runPass(security, "security", []);
    expect((await iterations(security)).map((it) => it.outcome)).toEqual([null, "converged"]);
    expect(await reviewRow(security)).toMatchObject({ status: "completed" });
  });

  it("stops security after one pass below Deep", async () => {
    const run = await enqueue("standard");
    const security = run.byType("security").reviewId;
    await runPass(security, "security", []);
    expect((await iterations(security)).map((it) => it.outcome)).toEqual(["converged"]);
  });

  it("keeps a pass's findings unverified when its verifier fails", async () => {
    const run = await enqueue("quick");
    const stability = run.byType("stability").reviewId;
    await finishJob((await iterations(stability))[0]!.workerJobId!, {
      result: workerResult("stability", [finding()]),
    });
    await finishJob((await iterations(stability))[0]!.verifierJobId!, { error: "boom" });
    expect(await reviewRow(stability)).toMatchObject({
      status: "completed",
      droppedFindings: 0,
      passes: [{ number: 1, confirmed: 1, verification: "unverified" }],
    });
  });

  it("fails a check type whose first pass fails", async () => {
    const run = await enqueue("quick");
    const stability = run.byType("stability").reviewId;
    await finishJob((await iterations(stability))[0]!.workerJobId!, { error: "agent crashed" });
    expect(await reviewRow(stability)).toMatchObject({ status: "failed", error: "agent crashed" });
    expect((await iterations(stability))[0]).toMatchObject({ status: "failed", outcome: "failed" });

    // The other check types finish: the run is posted, naming the failed check type.
    await runPass(run.byType("security").reviewId, "security", []);
    await runPass(run.byType("performance").reviewId, "performance", []);
    await runPass(run.byType("compatibility").reviewId, "compatibility", []);
    const correlation = (await correlationJob(run.reviewRunId))!;
    await finishJob(correlation.id, { result: answered({ findings: [], summary: "Nothing." }) });
    expect(state.scm.posted).toHaveLength(1);
    expect(state.scm.posted[0]!.summary).toContain("Review a pull request (stability)");
  });

  it("supersedes the old head's looped reviews, passes and verifiers on a new push", async () => {
    const prNumber = ++prCounter;
    const old = await enqueue("standard", prNumber, "e".repeat(40));
    const stability = old.byType("stability").reviewId;
    // A pass waiting for its verifier.
    await finishJob((await iterations(stability))[0]!.workerJobId!, {
      result: workerResult("stability", [finding()]),
    });
    const verifierId = (await iterations(stability))[0]!.verifierJobId!;

    const next = await enqueue("standard", prNumber, HEAD);
    expect(next.canceledJobIds).toEqual(
      expect.arrayContaining([
        verifierId,
        old.byType("security").jobId,
        old.byType("performance").jobId,
        old.byType("compatibility").jobId,
      ]),
    );
    const oldReviews = await db
      .select()
      .from(reviews)
      .where(eq(reviews.reviewRunId, old.reviewRunId))
      .orderBy(asc(reviews.createdAt));
    expect(oldReviews.map((r) => r.status)).toEqual(["skipped", "skipped", "skipped", "skipped"]);
    expect(oldReviews.every((r) => r.error?.startsWith("Superseded by a newer push"))).toBe(true);
    // Their loops ended too.
    for (const review of oldReviews) {
      expect((await iterations(review.id)).at(-1)).toMatchObject({ outcome: "failed" });
    }
    const [oldRun] = await db.select().from(reviewRuns).where(eq(reviewRuns.id, old.reviewRunId));
    expect(oldRun!.status).toBe("skipped");
    expect(await db.select().from(findings).where(eq(findings.reviewId, stability))).toEqual([]);
  });
});
