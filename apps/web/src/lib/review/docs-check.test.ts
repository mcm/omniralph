import { randomBytes } from "node:crypto";
import {
  agents,
  claimJob,
  closeDb,
  connectRepository,
  createDb,
  findings,
  getJob,
  jobs,
  listRunIterations,
  organizations,
  repositories,
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
import type {
  ChangeRequest,
  ChangeRequestState,
  InlineComment,
  ScmAdapter,
  ScmProvider,
} from "@omniralph/scm";
import {
  DOCUMENTATION_CHECK_MIN_AGENT_VERSION,
  DOCUMENTATION_DEPTHS,
  MAX_JOB_DELIVERIES,
  reviewTriggerContext,
  type DocumentationCheckMode,
  type DocumentationDepth,
  type DocumentationUpdate,
  type Finding,
  type ReviewTaskResult,
} from "@omniralph/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Adapters from "@/lib/scm/adapters";
import type * as Tasks from "@omniralph/tasks";

vi.mock("server-only", () => ({}));
// builtin:review-pr as a single pass, so a review run is one code review next to the docs check.
vi.mock("@omniralph/tasks", async (importOriginal) =>
  (await import("./test-single-pass")).singlePassTasks(await importOriginal<typeof Tasks>()),
);

const BASE = "a".repeat(40);
const HEAD = "f".repeat(40);
const NEXT_HEAD = "e".repeat(40);

/** A code host that records the comments and reviews posted to it; `pr.headSha` is the PR's current head. */
function fakeAdapter(provider: ScmProvider) {
  const calls = {
    postReview: [] as { number: number; inlineComments: InlineComment[] }[],
    upsertComment: [] as { number: number; body: string; commentId: string | null }[],
    getChangeRequestState: [] as number[],
  };
  const pr = { state: "open" as ChangeRequestState, headSha: HEAD };
  const unused = async (): Promise<never> => {
    throw new Error("not used");
  };
  const adapter: ScmAdapter = {
    provider,
    async getChangeRequest(_repo, number): Promise<ChangeRequest> {
      return {
        number,
        title: "Rename the review depth setting",
        description: "",
        author: "octocat",
        draft: false,
        state: pr.state,
        baseSha: BASE,
        headSha: pr.headSha,
        baseRef: "main",
        headRef: "feature",
        url: `https://example.com/acme/app/pull/${number}`,
      };
    },
    async postReview(_repo, number, review) {
      calls.postReview.push({ number, inlineComments: review.inlineComments });
      return {
        reviewId: `review-${calls.postReview.length}`,
        summaryCommentId: `summary-${calls.postReview.length}`,
        inlineCommentIds: review.inlineComments.map((_, i) => `inline-${i}`),
      };
    },
    async upsertComment(_repo, number, body, commentId) {
      calls.upsertComment.push({ number, body, commentId });
      return { id: commentId ?? `comment-${calls.upsertComment.length}` };
    },
    async getChangeRequestState(_repo, number) {
      calls.getChangeRequestState.push(number);
      return { state: pr.state, headSha: pr.headSha, mergeSha: null };
    },
    postComment: unused,
    replyToComment: unused,
    resolveThread: unused,
    getReadOnlyCloneCredential: unused,
    getWriteCloneCredential: unused,
    getDefaultBranch: unused,
    getBranchHead: unused,
    createBranch: unused,
    mergeBranch: unused,
    findOpenChangeRequest: unused,
    createChangeRequest: unused,
    updateChangeRequest: unused,
    markChangeRequestReady: unused,
    getCiStatus: unused,
    getRequiredChecks: unused,
    approvePullRequest: unused,
    mergePullRequest: unused,
    getCiJobLog: unused,
    getCommitDiff: unused,
    async hasWriteAccess() {
      return true;
    },
    async verifyWebhook() {
      return true;
    },
  };
  return { adapter, calls, pr };
}

const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  scm: undefined as unknown as ReturnType<typeof fakeAdapter>,
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

const readme: DocumentationUpdate = {
  path: "README.md",
  reason: "The settings table still names `review_depth`, which the change renames.",
  suggestion: "| `reviewDepth` | How deep reviews go. |",
};
const guide: DocumentationUpdate = {
  path: "docs/setup.md",
  reason: "Step 3 sets `REVIEW_DEPTH`; the change renames it to `OMNIRALPH_REVIEW_DEPTH`.",
};

const reviewResult = (found: Finding[]): ReviewTaskResult => ({
  findings: found,
  usage: { inputTokens: 1000, outputTokens: 100 },
  skipped: [],
  stopReason: "completed",
  scope: { mode: "full", baseSha: BASE, headSha: HEAD },
  discarded: { invalid: 0, outsideDiff: 0, duplicate: 0 },
  durationMs: 1000,
  summary: "Reviewed the change.",
});

const docsResult = (updates: DocumentationUpdate[]): ReviewTaskResult => ({
  ...reviewResult([]),
  summary: "Checked the docs.",
  documentationUpdates: updates,
});

/** The docs verifier's answer, confirming every update (`u1`, `u2`, …). */
const confirmAll = (count: number) => ({
  outcome: "answered",
  answer: null,
  structured: {
    verdicts: Array.from({ length: count }, (_, i) => ({
      updateId: `u${i + 1}`,
      verdict: "confirmed",
      line: 3,
      reason: "The file still says it.",
    })),
    summary: "Re-read the docs.",
  },
  references: [],
  usage: { inputTokens: 300, outputTokens: 30 },
  durationMs: 500,
});

const finding: Finding = {
  path: "src/settings.ts",
  startLine: 4,
  endLine: 4,
  severity: "high",
  category: "correctness",
  title: "The old setting name is still read",
  body: "`load()` reads `review_depth`.",
  confidence: 0.9,
};

describe.skipIf(!databaseAvailable)(
  "the documentation check in review runs",
  { timeout: 60_000 },
  () => {
    let testDb: TestDatabase;
    let db: Database;
    let orgId: string;
    const repoIds = {} as Record<ScmProvider, string>;
    let prCounter = 0;

    beforeAll(async () => {
      testDb = await createTestDatabase();
      db = createDb(testDb.uri);
      state.db = db;
      const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
      orgId = org!.id;
      for (const provider of ["github", "gitlab"] as const) {
        const connection = (await upsertScmConnection(db, {
          organizationId: orgId,
          provider,
          name: `acme-${provider}`,
          baseUrl: `https://${provider}.com`,
          externalId: `${provider}-4242`,
          credentials: {},
        }))!;
        repoIds[provider] = (
          await connectRepository(db, {
            connectionId: connection.id,
            provider,
            externalId: "100",
            fullPath: "acme/app",
          })
        ).id;
      }
    }, 180_000);

    beforeEach(() => {
      state.scm = fakeAdapter("github");
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "info").mockImplementation(() => {});
    });

    afterAll(async () => {
      if (db) await closeDb(db);
      await testDb?.stop();
    });

    async function configure(
      provider: ScmProvider,
      check: DocumentationCheckMode,
      depth: DocumentationDepth = "standard",
    ) {
      await db
        .update(repositories)
        .set({ documentationCheck: check, documentationDepth: depth })
        .where(eq(repositories.id, repoIds[provider]));
    }

    async function enqueue(provider: ScmProvider, prNumber: number, headSha = HEAD) {
      const enqueued = await enqueueReview(db, getDispatcher(), {
        repositoryId: repoIds[provider],
        prNumber,
        baseSha: BASE,
        headSha,
        title: "Rename the review depth setting",
        description: null,
        author: "octocat",
        trigger: "webhook",
      });
      if (enqueued.status !== "enqueued") throw new Error(enqueued.status);
      return enqueued;
    }

    async function runJobs(reviewRunId: string): Promise<Job[]> {
      return db.select().from(jobs).where(eq(jobs.reviewRunId, reviewRunId));
    }

    async function reviewRow(id: string): Promise<Review> {
      const [row] = await db.select().from(reviews).where(eq(reviews.id, id));
      return row!;
    }

    /** Finishes `jobId` as the agent would report it, through its sink's hooks. */
    async function finishJob(jobId: string, result: unknown): Promise<void> {
      const [job] = await db
        .update(jobs)
        .set({ status: "completed", result: result as Record<string, unknown> })
        .where(eq(jobs.id, jobId))
        .returning();
      const hooks = (await jobHooks(job!, organizationPlaybooks(db, orgId)))!;
      await hooks.onCompleted!(db, job!);
    }

    /** Runs a docs check to its end: its worker reports `updates`, all confirmed. */
    async function finishDocsCheck(reviewId: string, updates: DocumentationUpdate[]) {
      const [iteration] = await listRunIterations(db, { kind: "review", id: reviewId });
      await finishJob(iteration!.workerJobId!, docsResult(updates));
      const [after] = await listRunIterations(db, { kind: "review", id: reviewId });
      if (after!.verifierJobId) await finishJob(after!.verifierJobId, confirmAll(updates.length));
      // A first iteration that confirmed something runs a second one, which finds nothing new.
      const second = (await listRunIterations(db, { kind: "review", id: reviewId }))[1];
      if (second) await finishJob(second.workerJobId!, docsResult([]));
    }

    function docsRun(enqueued: Awaited<ReturnType<typeof enqueue>>) {
      const run = enqueued.runs.find((r) => r.taskId === "builtin:check-docs");
      if (!run) throw new Error("no docs check");
      return run;
    }

    describe("enqueueing", () => {
      it("enqueues only the review tasks when the check is off", async () => {
        await configure("github", "off");
        const prNumber = ++prCounter;
        const enqueued = await enqueue("github", prNumber);
        expect(enqueued.runs.map((r) => r.taskId)).toEqual(["builtin:review-pr"]);
        expect(
          (await runJobs(enqueued.reviewRunId)).map((job) => ({
            type: job.type,
            taskId: job.taskId,
            dedupeKey: job.dedupeKey,
          })),
        ).toEqual([
          {
            type: "review.task",
            taskId: "builtin:review-pr",
            dedupeKey: `review.run:${repoIds.github}:${prNumber}:${HEAD}:builtin:review-pr`,
          },
        ]);
        const context = reviewTriggerContext((await runJobs(enqueued.reviewRunId))[0]!.payload);
        expect(context.documentation).toBeUndefined();
      });

      it.each([
        ["comment", "quick"],
        ["update", "deep"],
      ] as const)(
        "adds the docs check at the repo's depth in %s mode (%s)",
        async (mode, depth) => {
          await configure("github", mode, depth);
          const prNumber = ++prCounter;
          const enqueued = await enqueue("github", prNumber);
          expect(enqueued.runs.map((r) => r.taskId)).toEqual([
            "builtin:review-pr",
            "builtin:check-docs",
          ]);
          const preset = DOCUMENTATION_DEPTHS[depth];

          // The code review's job is the same as with the check off.
          const codeJob = (await getJob(db, enqueued.runs[0]!.jobId))!;
          expect(codeJob.dedupeKey).toBe(
            `review.run:${repoIds.github}:${prNumber}:${HEAD}:builtin:review-pr`,
          );
          expect(reviewTriggerContext(codeJob.payload).documentation).toBeUndefined();

          const docs = docsRun(enqueued);
          expect(await reviewRow(docs.reviewId)).toMatchObject({
            summaryOnly: true,
            checkType: null,
            model: preset.model,
            budget: preset.maxTokens,
          });
          const job = (await getJob(db, docs.jobId))!;
          expect(
            job.dedupeKey?.startsWith(`review.run:${repoIds.github}:${prNumber}:${HEAD}:`),
          ).toBe(true);
          const context = reviewTriggerContext(job.payload);
          expect(context).toMatchObject({
            reviewId: docs.reviewId,
            mode: "full",
            previousReview: null,
            documentation: { depth },
          });
          expect(await listRunIterations(db, { kind: "review", id: docs.reviewId })).toMatchObject([
            {
              number: 1,
              workerJobId: job.id,
              verifierPlaybookId: "builtin:verify-docs",
              maxIterations: preset.maxIterations,
            },
          ]);
        },
      );

      it("leaves the docs check to agents that report documentation updates", async () => {
        await configure("github", "comment");
        await db.delete(jobs);
        const enqueued = await enqueue("github", ++prCounter);
        const [agent] = await db
          .insert(agents)
          .values({ organizationId: orgId, name: `agent-${prCounter}` })
          .returning();
        const claimAll = async (agentVersion: string) => {
          const claimed: (string | null)[] = [];
          for (;;) {
            const { claim } = await claimJob(db, {
              organizationId: orgId,
              agentId: agent!.id,
              acceptedTaskTypes: ["query", "review"],
              pools: ["short", "long"],
              agentVersion,
              maxDeliveries: MAX_JOB_DELIVERIES,
            });
            if (!claim) return claimed;
            claimed.push(claim.job.taskId);
          }
        };

        // The release before: the code review only.
        expect(await claimAll("2.3.1")).toEqual(["builtin:review-pr"]);
        expect(await claimAll(DOCUMENTATION_CHECK_MIN_AGENT_VERSION)).toEqual([
          "builtin:check-docs",
        ]);
        expect((await getJob(db, docsRun(enqueued).jobId))!.minAgentVersion).toBe(
          DOCUMENTATION_CHECK_MIN_AGENT_VERSION,
        );
      });

      it("cancels an older head's docs check on a new push", async () => {
        await configure("github", "comment");
        const prNumber = ++prCounter;
        const first = await enqueue("github", prNumber);
        const second = await enqueue("github", prNumber, NEXT_HEAD);
        expect(second.canceledJobIds).toContain(docsRun(first).jobId);
        expect(await reviewRow(docsRun(first).reviewId)).toMatchObject({ status: "skipped" });
      });
    });

    describe("the documentation comment", () => {
      it("lists each file to update, apart from the posted review", async () => {
        await configure("github", "comment");
        const prNumber = ++prCounter;
        const enqueued = await enqueue("github", prNumber);

        // The code review ends first: its run is posted without waiting for the docs check.
        await finishJob(enqueued.runs[0]!.jobId, reviewResult([finding]));
        expect(state.scm.calls.postReview).toHaveLength(1);
        expect(state.scm.calls.postReview[0]!.inlineComments.map((c) => c.path)).toEqual([
          "src/settings.ts",
        ]);
        expect(state.scm.calls.upsertComment).toEqual([]);

        const docs = docsRun(enqueued);
        await finishDocsCheck(docs.reviewId, [readme, guide]);
        expect(await reviewRow(docs.reviewId)).toMatchObject({
          status: "completed",
          documentationUpdates: [readme, guide],
        });
        expect(
          await db.select().from(findings).where(eq(findings.reviewId, docs.reviewId)),
        ).toEqual([]);
        // Not part of the posted review or its correlation.
        expect(state.scm.calls.postReview).toHaveLength(1);
        const [run] = await db
          .select()
          .from(reviewRuns)
          .where(eq(reviewRuns.id, enqueued.reviewRunId));
        expect(run).toMatchObject({ status: "completed", correlationJobId: null });

        expect(state.scm.calls.getChangeRequestState).toEqual([prNumber]);
        expect(state.scm.calls.upsertComment).toHaveLength(1);
        const [comment] = state.scm.calls.upsertComment;
        expect(comment).toMatchObject({ number: prNumber, commentId: null });
        expect(comment!.body).toContain("## Check documentation");
        expect(comment!.body).toContain("2 documentation files need updating for this change:");
        expect(comment!.body).toContain(`- **\`README.md\`**: ${readme.reason}`);
        expect(comment!.body).toContain("Suggested text:\n\n  ```\n  | `reviewDepth` |");
        expect(comment!.body).toContain(`- **\`docs/setup.md\`**: ${guide.reason}`);
        expect(comment!.body).toContain(`_Updated for \`${HEAD.slice(0, 12)}\``);
      });

      it("says no change is needed, and edits the same comment on a later push", async () => {
        await configure("github", "comment");
        const prNumber = ++prCounter;
        const first = await enqueue("github", prNumber);
        await finishJob(first.runs[0]!.jobId, reviewResult([]));
        await finishDocsCheck(docsRun(first).reviewId, [readme]);
        expect(state.scm.calls.upsertComment).toHaveLength(1);
        const commentId = "comment-1";

        state.scm.pr.headSha = NEXT_HEAD;
        const second = await enqueue("github", prNumber, NEXT_HEAD);
        await finishDocsCheck(docsRun(second).reviewId, []);
        expect(state.scm.calls.upsertComment).toHaveLength(2);
        const edited = state.scm.calls.upsertComment[1]!;
        expect(edited.commentId).toBe(commentId);
        expect(edited.body).toContain("No documentation changes needed for this change.");
        expect(edited.body).not.toContain("README.md");
        expect(edited.body).toContain(`_Updated for \`${NEXT_HEAD.slice(0, 12)}\``);
      });

      it("isn't posted for a head that is no longer the PR's current head", async () => {
        await configure("github", "comment");
        const prNumber = ++prCounter;
        const enqueued = await enqueue("github", prNumber);
        // A push the control panel hasn't enqueued yet.
        state.scm.pr.headSha = NEXT_HEAD;
        await finishDocsCheck(docsRun(enqueued).reviewId, [readme]);
        expect(await reviewRow(docsRun(enqueued).reviewId)).toMatchObject({
          status: "completed",
        });
        expect(state.scm.calls.getChangeRequestState).toEqual([prNumber]);
        expect(state.scm.calls.upsertComment).toEqual([]);
      });

      it("is posted on a GitLab MR", async () => {
        state.scm = fakeAdapter("gitlab");
        await configure("gitlab", "comment", "quick");
        const prNumber = ++prCounter;
        const enqueued = await enqueue("gitlab", prNumber);
        await finishDocsCheck(docsRun(enqueued).reviewId, [guide]);
        expect(state.scm.calls.upsertComment).toHaveLength(1);
        expect(state.scm.calls.upsertComment[0]!.body).toContain(
          `1 documentation file needs updating for this change:\n\n- **\`docs/setup.md\`**`,
        );
      });
    });
  },
);
