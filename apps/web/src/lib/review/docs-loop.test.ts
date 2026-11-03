import { randomBytes } from "node:crypto";
import {
  closeDb,
  connectRepository,
  createDb,
  createReview,
  createReviewRun,
  findings,
  getJob,
  jobs,
  listRunIterations,
  organizations,
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
import {
  DOCUMENTATION_DEPTHS,
  DOCUMENTATION_VERIFICATION_JOB_TYPE,
  DocumentationVerificationTriggerContext,
  REVIEW_TASK_JOB_TYPE,
  ReviewTriggerContext,
  RunSpecJobPayload,
  documentationCheckContext,
  reviewTriggerContext,
  type DocumentationDepth,
  type DocumentationUpdate,
  type ReviewTaskResult,
} from "@omniralph/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const HEAD = "f".repeat(40);
const BASE = "a".repeat(40);

const state = vi.hoisted(() => ({ db: undefined as unknown as Database }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.APP_URL = "https://omniralph.example.com";

const { startDocumentationCheckLoop } = await import("./loop");
const { getDispatcher } = await import("@/lib/dispatch");
const { jobHooks } = await import("@/lib/sinks");
const { getPlaybookTask, organizationPlaybooks, taskJobInput } = await import("@/lib/playbooks");

const databaseAvailable = testDatabaseAvailable();

const readme: DocumentationUpdate = {
  path: "README.md",
  reason: "Still documents the removed `--legacy` flag.",
  suggestion: "Drop the `--legacy` row of the flags table.",
};
const guide: DocumentationUpdate = {
  path: "docs/setup.md",
  reason: "Names the renamed `REVIEW_DEPTH` setting.",
};
const agents: DocumentationUpdate = {
  path: "AGENTS.md",
  reason: "Tells agents to run the removed `pnpm legacy` script.",
};

const workerResult = (
  updates: DocumentationUpdate[],
  summary = "Checked the docs.",
): ReviewTaskResult => ({
  findings: [],
  usage: { inputTokens: 1000, outputTokens: 100 },
  skipped: [],
  stopReason: "completed",
  scope: { mode: "full", baseSha: BASE, headSha: HEAD },
  discarded: { invalid: 0, outsideDiff: 0, duplicate: 0 },
  durationMs: 1000,
  summary,
  documentationUpdates: updates,
});

type Verdict = "confirmed" | "rejected";

/** The verifier's answer: one verdict per update, by position (`u1`, `u2`, …). */
const verification = (verdicts: Verdict[]) => ({
  outcome: "answered",
  answer: null,
  structured: {
    verdicts: verdicts.map((verdict, i) => ({
      updateId: `u${i + 1}`,
      verdict,
      line: verdict === "confirmed" ? 3 : null,
      reason: verdict === "confirmed" ? "Line 3 still says it." : "The file doesn't mention it.",
    })),
    summary: "Re-read the docs against the diff.",
  },
  references: [],
  usage: { inputTokens: 300, outputTokens: 30 },
  durationMs: 500,
});

describe.skipIf(!databaseAvailable)("documentation check loop", { timeout: 60_000 }, () => {
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

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  /** Starts a documentation check of a new PR at `depth`, as a review run's task run. */
  async function start(depth: DocumentationDepth) {
    const prNumber = ++prCounter;
    const definitions = organizationPlaybooks(db, orgId);
    const task = (await getPlaybookTask(definitions, "builtin:check-docs"))!;
    const playbook = (await definitions.getPlaybook("builtin:check-docs"))!;
    const reviewRun = await createReviewRun(db, {
      organizationId: orgId,
      repositoryId: repoId,
      prNumber,
      headSha: HEAD,
      baseSha: BASE,
      trigger: "mention",
      mode: "full",
      depth: "standard",
      prAuthor: "octocat",
    });
    const preset = DOCUMENTATION_DEPTHS[depth];
    const review = await createReview(db, {
      reviewRunId: reviewRun.id,
      taskId: task.id,
      summaryOnly: true,
      checkType: null,
      repositoryId: repoId,
      prNumber,
      prTitle: "Rename the review depth setting",
      headSha: HEAD,
      baseSha: BASE,
      trigger: "mention",
      depth: "standard",
      model: preset.model,
      budget: preset.maxTokens,
    });
    const context = ReviewTriggerContext.parse({
      reviewId: review.id,
      repositoryId: repoId,
      repository: "acme/app",
      prNumber,
      pr: { number: prNumber, title: "Rename the review depth setting", body: null },
      baseSha: BASE,
      headSha: HEAD,
      changeRequest: {
        title: "Rename the review depth setting",
        description: null,
        author: "octocat",
      },
      reviewConfig: {
        profile: {
          id: "standard",
          name: "Standard",
          model: "claude-sonnet-5-5",
          maxTokensPerReview: 250_000,
          maxFiles: 100,
          allowRepoExploration: false,
        },
        customInstructions: null,
        rules: [],
        pathExcludes: [],
      },
      mode: "full",
      previousReview: null,
      documentation: documentationCheckContext(depth),
    });
    const { job } = await startDocumentationCheckLoop(
      db,
      getDispatcher(),
      review,
      playbook,
      depth,
      {
        organizationId: orgId,
        type: REVIEW_TASK_JOB_TYPE,
        ...(await taskJobInput(definitions, task, {
          trigger: { kind: "review.rerun", context },
          repositoryId: repoId,
          ref: HEAD,
        })),
        reviewRunId: reviewRun.id,
        dedupeKey: `test:docs:${prNumber}`,
      },
    );
    return { review, job };
  }

  async function reviewRow(id: string): Promise<Review> {
    const [row] = await db.select().from(reviews).where(eq(reviews.id, id));
    return row!;
  }

  async function iterations(reviewId: string) {
    return listRunIterations(db, { kind: "review", id: reviewId });
  }

  /** Finishes `jobId` as the agent would report it, through its sink's hooks. */
  async function finishJob(jobId: string, result: unknown): Promise<Job> {
    const [job] = await db
      .update(jobs)
      .set({ status: "completed", result: result as Record<string, unknown> })
      .where(eq(jobs.id, jobId))
      .returning();
    const hooks = (await jobHooks(job!, organizationPlaybooks(db, orgId)))!;
    await hooks.onCompleted!(db, job!);
    return job!;
  }

  /**
   * Runs the check's current iteration: its worker reports `updates`, then
   * (when a verifier job started) the verifier answers `verdicts`. Returns
   * the iteration's worker and verifier jobs.
   */
  async function runIteration(
    reviewId: string,
    updates: DocumentationUpdate[],
    verdicts: Verdict[] = [],
  ): Promise<{ worker: Job; verifier: Job | null }> {
    const current = (await iterations(reviewId)).at(-1)!;
    expect(current.status).toBe("working");
    const worker = (await getJob(db, current.workerJobId!))!;
    await finishJob(worker.id, workerResult(updates));
    const after = (await iterations(reviewId)).find((it) => it.id === current.id)!;
    if (!after.verifierJobId) return { worker, verifier: null };
    const verifier = (await getJob(db, after.verifierJobId))!;
    await finishJob(verifier.id, verification(verdicts));
    return { worker, verifier };
  }

  it("verifies each iteration's updates and stops once one confirms nothing new", async () => {
    const { review } = await start("standard");
    expect(await iterations(review.id)).toMatchObject([
      { number: 1, verifierPlaybookId: "builtin:verify-docs", maxIterations: 3 },
    ]);

    // Iteration 1: the verifier keeps README.md and drops docs/setup.md.
    const first = await runIteration(review.id, [readme, guide], ["confirmed", "rejected"]);
    expect(first.verifier).toMatchObject({
      type: DOCUMENTATION_VERIFICATION_JOB_TYPE,
      taskId: "builtin:verify-docs",
    });
    const payload = RunSpecJobPayload.parse(first.verifier!.payload);
    expect(payload.ref).toBe(HEAD);
    const sent = DocumentationVerificationTriggerContext.parse(payload.trigger.context);
    expect(sent.documentation.depth).toBe("standard");
    expect(sent.verification).toMatchObject({ iteration: 1, baseSha: BASE, headSha: HEAD });
    expect(sent.verification.updates.map((u) => [u.id, u.path])).toEqual([
      ["u1", "README.md"],
      ["u2", "docs/setup.md"],
    ]);
    // The worker's own result isn't saved: the review waits for its loop.
    expect(await reviewRow(review.id)).toMatchObject({ documentationUpdates: null });

    // Iteration 2 is told what was confirmed and dropped.
    const [, second] = await iterations(review.id);
    expect(second).toMatchObject({ number: 2, status: "working" });
    const secondJob = (await getJob(db, second!.workerJobId!))!;
    expect(reviewTriggerContext(secondJob.payload).documentation).toMatchObject({
      depth: "standard",
      earlier: {
        iteration: 2,
        confirmed: [readme],
        dropped: [{ path: "docs/setup.md", reason: "The file doesn't mention it." }],
      },
    });

    // It reports README.md again: confirmed, but not new, so the check stops.
    await runIteration(review.id, [readme], ["confirmed"]);
    expect(await iterations(review.id)).toMatchObject([
      { number: 1, verdict: "continue" },
      { number: 2, verdict: "converged", outcome: "converged" },
    ]);
    expect(await reviewRow(review.id)).toMatchObject({
      status: "completed",
      documentationUpdates: [readme],
      summary: "1 documentation file needs updating: `README.md`.",
      // Two workers and two verifiers.
      tokensIn: 2600,
    });
    expect(await db.select().from(findings).where(eq(findings.reviewId, review.id))).toEqual([]);
  });

  it("needs no verifier when nothing is reported, and saves that no change is needed", async () => {
    const { review } = await start("quick");
    const { verifier } = await runIteration(review.id, []);
    expect(verifier).toBeNull();
    expect(await iterations(review.id)).toMatchObject([{ number: 1, outcome: "converged" }]);
    expect(await reviewRow(review.id)).toMatchObject({
      status: "completed",
      documentationUpdates: [],
      summary: "No documentation changes needed for this change.",
    });
  });

  it("drops every update its verifier rejects", async () => {
    const { review } = await start("standard");
    await runIteration(review.id, [readme, guide], ["rejected", "rejected"]);
    expect(await iterations(review.id)).toMatchObject([{ number: 1, outcome: "converged" }]);
    expect(await reviewRow(review.id)).toMatchObject({
      status: "completed",
      documentationUpdates: [],
    });
  });

  it("stops at the documentation depth's iteration cap", async () => {
    const { review } = await start("quick");
    expect(DOCUMENTATION_DEPTHS.quick.maxIterations).toBe(2);
    await runIteration(review.id, [readme], ["confirmed"]);
    await runIteration(review.id, [guide], ["confirmed"]);
    expect(await iterations(review.id)).toMatchObject([
      { number: 1, verdict: "continue" },
      { number: 2, verdict: "continue", outcome: "max-iterations" },
    ]);
    expect(await reviewRow(review.id)).toMatchObject({
      status: "completed",
      documentationUpdates: [readme, guide],
    });
  });

  it("runs past Quick's cap at Deep", async () => {
    const { review } = await start("deep");
    await runIteration(review.id, [readme], ["confirmed"]);
    await runIteration(review.id, [guide], ["confirmed"]);
    await runIteration(review.id, [agents], ["confirmed"]);
    expect(await iterations(review.id)).toHaveLength(4);
    expect(await reviewRow(review.id)).toMatchObject({ status: "queued" });
  });
});
