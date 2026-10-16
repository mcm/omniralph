import { randomBytes } from "node:crypto";
import {
  connectRepository,
  closeDb,
  createDb,
  createReview,
  findings,
  jobs,
  listReviewRunFindings,
  repositories,
  reviewRuns,
  reviews,
  scmConnections,
  upsertScmConnection,
  type Database,
  type FindingRow,
  type Job,
  organizations,
  seedReviewProfiles,
} from "@omniralph/db";
import type { ChangeRequest, ChangeRequestState, InlineComment, ScmAdapter } from "@omniralph/scm";
import { reviewTriggerContext, type Finding, type ReviewJobResult } from "@omniralph/shared";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRole, type Role } from "@/lib/auth/roles";
import type * as Adapters from "@/lib/scm/adapters";
import type * as Tasks from "@omniralph/tasks";

vi.mock("server-only", () => ({}));
// A second review task, as a repository could enable next to builtin:review-pr.
vi.mock("@omniralph/tasks", async (importOriginal) => {
  const actual = await importOriginal<typeof Tasks>();
  const security = {
    ...actual.getBuiltinTask("builtin:review-pr")!,
    id: "builtin:security-review",
    name: "Security review",
  };
  return {
    ...actual,
    getBuiltinTask: (id: string) => (id === security.id ? security : actual.getBuiltinTask(id)),
  };
});
const SECURITY_TASK_ID = "builtin:security-review";

const HEAD = "f".repeat(40);

/** Records code-host calls; `failResolve` makes `resolveThread` throw for those comment IDs. */
function fakeAdapter() {
  const calls = {
    getChangeRequest: [] as number[],
    postReview: [] as { number: number; summary: string; inlineComments: InlineComment[] }[],
    replyToComment: [] as { number: number; commentId: string; body: string }[],
    resolveThread: [] as { number: number; commentId: string }[],
  };
  const pr = { state: "open" as ChangeRequestState, headSha: HEAD };
  const failResolve = new Set<string>();
  const adapter: ScmAdapter = {
    provider: "github",
    async getChangeRequest(_repo, number): Promise<ChangeRequest> {
      calls.getChangeRequest.push(number);
      return {
        number,
        title: "Add login",
        description: "Please review",
        author: "octocat",
        draft: false,
        state: pr.state,
        baseSha: "a".repeat(40),
        headSha: pr.headSha,
        baseRef: "main",
        headRef: "feature",
        url: `https://github.com/acme/app/pull/${number}`,
      };
    },
    async postReview(_repo, number, review) {
      calls.postReview.push({
        number,
        summary: review.summary,
        inlineComments: review.inlineComments,
      });
      return {
        reviewId: `review-${calls.postReview.length}`,
        summaryCommentId: `summary-${calls.postReview.length}`,
        inlineCommentIds: review.inlineComments.map(
          (_, i) => `new-${calls.postReview.length}-${i}`,
        ),
      };
    },
    async postComment() {
      throw new Error("not used");
    },
    async upsertComment() {
      throw new Error("not used");
    },
    async replyToComment(_repo, number, commentId, body) {
      calls.replyToComment.push({ number, commentId, body });
      return { id: `r${calls.replyToComment.length}` };
    },
    async resolveThread(_repo, number, commentId) {
      calls.resolveThread.push({ number, commentId });
      if (failResolve.has(commentId)) throw new Error("GitHub said no");
    },
    async getReadOnlyCloneCredential() {
      throw new Error("not used");
    },
    async getWriteCloneCredential() {
      throw new Error("not used");
    },
    async getDefaultBranch() {
      throw new Error("not used");
    },
    async findOpenChangeRequest() {
      throw new Error("not used");
    },
    async createChangeRequest() {
      throw new Error("not used");
    },
    async updateChangeRequest() {
      throw new Error("not used");
    },
    async markChangeRequestReady() {
      throw new Error("not used");
    },
    async getCiStatus() {
      throw new Error("not used");
    },
    async getCiJobLog() {
      throw new Error("not used");
    },
    async getChangeRequestState() {
      throw new Error("not used");
    },
    async hasWriteAccess() {
      return true;
    },
    async verifyWebhook() {
      return true;
    },
  };
  return { adapter, calls, pr, failResolve };
}

const state = vi.hoisted(() => ({
  orgId: "",
  db: undefined as unknown as Database,
  user: null as { id: string; role: Role; name: null; email: null; image: null } | null,
  scm: undefined as unknown as ReturnType<typeof fakeAdapter>,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  // The signed-in user works in `state.orgId`.
  requireUser: async (role: Role = "member") =>
    assertRole(
      state.user && { ...state.user, organization: { id: state.orgId, name: "Acme" } },
      role,
    ),
}));
vi.mock("@/lib/scm/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof Adapters>()),
  scmAdapterFor: () => state.scm.adapter,
}));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.APP_URL = "https://omniralph.example.com";

const { enqueueReview } = await import("./enqueue");
const { onReviewJobCompleted, onReviewJobFailed } = await import("./jobs");
const { onCorrelationFailed } = await import("./correlate");
const { getDispatcher } = await import("@/lib/dispatch");
const rerunRoute = await import("@/app/api/ui/reviews/[id]/rerun/route");

type RerunOutcome =
  { ok: true; reviewId: string } | { ok: false; error: string; activeReviewId?: string };

/**
 * Re-runs through `POST /api/ui/reviews/{id}/rerun`, answering as the server action did: the
 * review of the same head already running (`active`) as an error with its ID.
 */
async function rerunReview(reviewId: string, input: unknown): Promise<RerunOutcome> {
  const response = await rerunRoute.POST(
    new Request("http://localhost/api/ui", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
    { params: Promise.resolve({ id: reviewId }) },
  );
  const body = (await response.json()) as {
    error: string;
    reviewId: string;
    active: boolean;
    message?: string;
  };
  if (!response.ok) return { ok: false, error: body.error };
  return body.active
    ? { ok: false, error: body.message!, activeReviewId: body.reviewId }
    : { ok: true, reviewId: body.reviewId };
}

const databaseAvailable = testDatabaseAvailable();

const SHA = (n: number) => n.toString(16).padStart(40, "0");
const admin = { id: "admin-1", role: "admin" as const, name: null, email: null, image: null };
const member = { id: "member-1", role: "member" as const, name: null, email: null, image: null };

describe.skipIf(!databaseAvailable)("re-running reviews", { timeout: 30_000 }, () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let repoId: string;
  let connectionId: string;
  let prCounter = 0;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    await seedReviewProfiles(db, org!.id);
    orgId = org!.id;
    state.orgId = orgId;
    state.db = db;
    const connection = (await upsertScmConnection(db, {
      organizationId: orgId,
      provider: "github",
      name: "acme",
      baseUrl: "https://github.com",
      externalId: "4242",
      credentials: {},
    }))!;
    connectionId = connection.id;
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
    state.scm = fakeAdapter();
    state.user = admin;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  /** A completed webhook review of the PR with open findings posted as threads `thread-<i>`. */
  async function reviewedPr(open: Partial<typeof findings.$inferInsert>[] = [{}]) {
    const number = ++prCounter;
    const review = await createReview(db, {
      repositoryId: repoId,
      prNumber: number,
      headSha: SHA(2),
      baseSha: SHA(1),
      trigger: "webhook",
      profileId: "standard",
      model: null,
      budget: 200_000,
    });
    await db.update(reviews).set({ status: "completed" }).where(eq(reviews.id, review.id));
    const rows = await db
      .insert(findings)
      .values(
        open.map((over, i) => ({
          reviewId: review.id,
          path: "src/app.ts",
          startLine: 10,
          endLine: 12,
          severity: "high" as const,
          category: "correctness",
          title: "Missing null check",
          body: "`load()` can return undefined.",
          confidence: 0.8,
          scmCommentId: `thread-${number}-${i}`,
          createdAt: new Date(Date.now() + i),
          ...over,
        })),
      )
      .returning();
    return { number, review, findings: rows };
  }

  const enqueue = (number: number, mode: "incremental" | "full" | "fresh") =>
    enqueueReview(db, getDispatcher(), {
      repositoryId: repoId,
      prNumber: number,
      baseSha: SHA(1),
      headSha: HEAD,
      title: "Add login",
      description: null,
      author: "octocat",
      trigger: "mention",
      mode,
    });

  async function reviewJob(reviewId: string): Promise<Job> {
    const rows = await db.select().from(jobs).where(eq(jobs.type, "review.task"));
    const job = rows.find((j) => reviewTriggerContext(j.payload).reviewId === reviewId);
    if (!job) throw new Error(`no job for review ${reviewId}`);
    return job;
  }

  const result = (found: Finding[]): ReviewJobResult => ({
    findings: found,
    usage: { inputTokens: 1000, outputTokens: 100 },
    skipped: [],
    stopReason: "completed",
    scope: { mode: "full", baseSha: SHA(1), headSha: HEAD },
    discarded: { invalid: 0, outsideDiff: 0, duplicate: 0 },
    durationMs: 1000,
  });

  const newFinding = (over: Partial<Finding> = {}): Finding => ({
    path: "src/app.ts",
    startLine: 11,
    endLine: 11,
    severity: "high",
    category: "correctness",
    title: "load() may return undefined",
    body: "Check the result.",
    confidence: 0.9,
    ...over,
  });

  async function findingRow(id: string): Promise<FindingRow> {
    const [row] = await db.select().from(findings).where(eq(findings.id, id));
    return row!;
  }

  describe("enqueueReview modes", () => {
    it("passes no open findings for a fresh review", async () => {
      const { number } = await reviewedPr();
      const enqueued = await enqueue(number, "fresh");
      expect(enqueued.status).toBe("enqueued");
      if (enqueued.status !== "enqueued") return;
      const payload = reviewTriggerContext((await reviewJob(enqueued.reviewId)).payload);
      expect(payload.mode).toBe("fresh");
      expect(payload.previousReview).toBeNull();
    });

    it("still passes open findings for a full review, without a previous head", async () => {
      const { number } = await reviewedPr();
      const enqueued = await enqueue(number, "full");
      if (enqueued.status !== "enqueued") throw new Error(enqueued.status);
      const payload = reviewTriggerContext((await reviewJob(enqueued.reviewId)).payload);
      expect(payload.mode).toBe("full");
      expect(payload.previousReview).toEqual({
        headSha: null,
        openFindings: [
          expect.objectContaining({
            path: "src/app.ts",
            startLine: 10,
            endLine: 12,
            category: "correctness",
          }),
        ],
      });
    });

    it("keeps the previous head for an incremental (webhook) review", async () => {
      const { number } = await reviewedPr();
      const enqueued = await enqueue(number, "incremental");
      if (enqueued.status !== "enqueued") throw new Error(enqueued.status);
      const payload = reviewTriggerContext((await reviewJob(enqueued.reviewId)).payload);
      expect(payload.mode).toBe("incremental");
      expect(payload.previousReview?.headSha).toBe(SHA(2));
    });
  });

  describe("superseding after a fresh review", () => {
    async function completeFresh(number: number, found: Finding[]) {
      const enqueued = await enqueue(number, "fresh");
      if (enqueued.status !== "enqueued") throw new Error(enqueued.status);
      const job = await reviewJob(enqueued.reviewId);
      await onReviewJobCompleted(db, { ...job, status: "completed", result: result(found) });
      const rows = await db.select().from(findings).where(eq(findings.reviewId, enqueued.reviewId));
      return { reviewId: enqueued.reviewId, rows };
    }

    it("supersedes a matching open finding, replies with a link and resolves its thread", async () => {
      const { number, findings: prior } = await reviewedPr([
        {},
        // Another file: no match, stays open.
        { path: "src/other.ts" },
        // Same lines, other category: no match.
        { category: "security" },
      ]);
      const { reviewId, rows } = await completeFresh(number, [newFinding()]);
      expect(rows).toHaveLength(1);

      expect(await findingRow(prior[0]!.id)).toMatchObject({
        status: "superseded",
        supersededByFindingId: rows[0]!.id,
      });
      expect((await findingRow(prior[1]!.id)).status).toBe("open");
      expect((await findingRow(prior[2]!.id)).status).toBe("open");
      expect((await findingRow(prior[2]!.id)).supersededByFindingId).toBeNull();

      const thread = prior[0]!.scmCommentId!;
      expect(state.scm.calls.replyToComment).toHaveLength(1);
      expect(state.scm.calls.replyToComment[0]).toMatchObject({ number, commentId: thread });
      expect(state.scm.calls.replyToComment[0]!.body).toContain("superseded");
      expect(state.scm.calls.replyToComment[0]!.body).toContain(
        `https://omniralph.example.com/reviews/${reviewId}#finding-${rows[0]!.id}`,
      );
      expect(state.scm.calls.resolveThread).toEqual([{ number, commentId: thread }]);
    });

    it("leaves unmatched open findings alone", async () => {
      const { number, findings: prior } = await reviewedPr();
      const { rows } = await completeFresh(number, [newFinding({ startLine: 40, endLine: 41 })]);
      expect(rows).toHaveLength(1);
      expect((await findingRow(prior[0]!.id)).status).toBe("open");
      expect(state.scm.calls.replyToComment).toHaveLength(0);
      expect(state.scm.calls.resolveThread).toHaveLength(0);
    });

    it("logs a failed thread resolve as a warning without failing the review", async () => {
      const { number, findings: prior } = await reviewedPr();
      state.scm.failResolve.add(prior[0]!.scmCommentId!);
      const { reviewId } = await completeFresh(number, [newFinding()]);

      expect((await findingRow(prior[0]!.id)).status).toBe("superseded");
      const [review] = await db.select().from(reviews).where(eq(reviews.id, reviewId));
      expect(review!.status).toBe("completed");
      const [run] = await db
        .select()
        .from(reviewRuns)
        .where(eq(reviewRuns.id, review!.reviewRunId!));
      expect(run!.summaryCommentId).not.toBeNull();
      expect(console.warn).toHaveBeenCalledWith(
        "couldn't resolve a superseded finding's SCM thread",
        expect.objectContaining({ findingId: prior[0]!.id, error: "GitHub said no" }),
      );
    });

    it("doesn't supersede anything after a full review", async () => {
      const { number, findings: prior } = await reviewedPr();
      const enqueued = await enqueue(number, "full");
      if (enqueued.status !== "enqueued") throw new Error(enqueued.status);
      const job = await reviewJob(enqueued.reviewId);
      await onReviewJobCompleted(db, {
        ...job,
        status: "completed",
        result: result([newFinding()]),
      });
      expect((await findingRow(prior[0]!.id)).status).toBe("open");
    });

    it("ends the summary comment with the re-run footer", async () => {
      const { number } = await reviewedPr();
      const { reviewId } = await completeFresh(number, []);
      const summary = state.scm.calls.postReview.at(-1)!.summary;
      expect(summary.trimEnd().split("\n").at(-1)).toBe(
        `Re-run: comment \`@omniralph review\` (new issues only) or \`@omniralph review fresh\` (from scratch), or use **Re-run** on the [review page](https://omniralph.example.com/reviews/${reviewId}).`,
      );
    });
    it("names a GitLab connection's bot username in the re-run footer", async () => {
      const { number } = await reviewedPr();
      const asGitLab = { provider: "gitlab" as const, botUsername: "service_account_group_12_bot" };
      await db.update(scmConnections).set(asGitLab).where(eq(scmConnections.id, connectionId));
      try {
        await completeFresh(number, []);
      } finally {
        await db
          .update(scmConnections)
          .set({ provider: "github", botUsername: null })
          .where(eq(scmConnections.id, connectionId));
      }
      const summary = state.scm.calls.postReview.at(-1)!.summary;
      expect(summary).toContain("`@service_account_group_12_bot review`");
      expect(summary).not.toContain("@omniralph");
    });
  });

  describe("resolving findings a re-review found fixed", () => {
    /** Completes a review of the PR whose result marks the `fixed` findings (by ID) fixed. */
    async function completeReview(
      number: number,
      outcome: ReviewJobResult,
      fixed: string[] = [],
      mode: "incremental" | "full" = "incremental",
    ) {
      const enqueued = await enqueue(number, mode);
      if (enqueued.status !== "enqueued") throw new Error(enqueued.status);
      const job = await reviewJob(enqueued.reviewId);
      const given = reviewTriggerContext(job.payload).previousReview?.openFindings ?? [];
      const fixedOpenFindings = fixed.map((id) => given.findIndex((f) => f.id === id));
      expect(fixedOpenFindings).not.toContain(-1);
      await onReviewJobCompleted(db, {
        ...job,
        status: "completed",
        result: { ...outcome, fixedOpenFindings },
      });
      return enqueued.reviewId;
    }

    it("passes the open findings' IDs, titles and bodies to the review", async () => {
      const { number, findings: prior } = await reviewedPr();
      const enqueued = await enqueue(number, "incremental");
      if (enqueued.status !== "enqueued") throw new Error(enqueued.status);
      const job = await reviewJob(enqueued.reviewId);
      expect(reviewTriggerContext(job.payload).previousReview?.openFindings).toEqual([
        expect.objectContaining({
          id: prior[0]!.id,
          title: "Missing null check",
          body: "`load()` can return undefined.",
        }),
      ]);
    });

    it("resolves only the open findings the review found fixed, with their threads", async () => {
      const { number, findings: prior } = await reviewedPr([{}, { path: "src/other.ts" }]);
      const reviewId = await completeReview(number, result([]), [prior[1]!.id]);

      expect((await findingRow(prior[0]!.id)).status).toBe("open");
      expect((await findingRow(prior[1]!.id)).status).toBe("resolved");
      const thread = prior[1]!.scmCommentId!;
      expect(state.scm.calls.replyToComment).toHaveLength(1);
      expect(state.scm.calls.replyToComment[0]).toMatchObject({ number, commentId: thread });
      expect(state.scm.calls.replyToComment[0]!.body).toContain("found it fixed");
      expect(state.scm.calls.replyToComment[0]!.body).toContain(
        `https://omniralph.example.com/reviews/${reviewId}`,
      );
      expect(state.scm.calls.resolveThread).toEqual([{ number, commentId: thread }]);
    });

    it("resolves fixed findings after an incremental review that stopped early", async () => {
      const { number, findings: prior } = await reviewedPr();
      await completeReview(
        number,
        {
          ...result([]),
          stopReason: "budget_exhausted",
          scope: { mode: "incremental", fromSha: SHA(2), headSha: HEAD },
        },
        [prior[0]!.id],
      );
      expect((await findingRow(prior[0]!.id)).status).toBe("resolved");
    });

    it("keeps a finding open when a new finding raises it again", async () => {
      const { number, findings: prior } = await reviewedPr();
      await completeReview(number, result([newFinding()]), [prior[0]!.id], "full");
      expect((await findingRow(prior[0]!.id)).status).toBe("open");
      expect(state.scm.calls.resolveThread).toHaveLength(0);
    });

    it("resolves nothing when no finding was found fixed or the agent doesn't report it", async () => {
      const { number, findings: prior } = await reviewedPr();
      await completeReview(number, result([]), [], "full");
      const other = await reviewedPr();
      const enqueued = await enqueue(other.number, "full");
      if (enqueued.status !== "enqueued") throw new Error(enqueued.status);
      const job = await reviewJob(enqueued.reviewId);
      await onReviewJobCompleted(db, { ...job, status: "completed", result: result([]) });
      expect((await findingRow(prior[0]!.id)).status).toBe("open");
      expect((await findingRow(other.findings[0]!.id)).status).toBe("open");
      expect(state.scm.calls.resolveThread).toHaveLength(0);
    });

    it("logs a failed thread resolve without failing the review", async () => {
      const { number, findings: prior } = await reviewedPr();
      state.scm.failResolve.add(prior[0]!.scmCommentId!);
      const reviewId = await completeReview(number, result([]), [prior[0]!.id]);
      expect((await findingRow(prior[0]!.id)).status).toBe("resolved");
      const [review] = await db.select().from(reviews).where(eq(reviews.id, reviewId));
      expect(review!.status).toBe("completed");
      expect(console.warn).toHaveBeenCalledWith(
        "couldn't resolve a fixed finding's SCM thread",
        expect.objectContaining({ findingId: prior[0]!.id, error: "GitHub said no" }),
      );
    });
  });

  describe("review runs of several tasks", () => {
    beforeEach(async () => {
      await db
        .update(repositories)
        .set({ reviewTaskIds: ["builtin:review-pr", SECURITY_TASK_ID] })
        .where(eq(repositories.id, repoId));
    });
    afterEach(async () => {
      await db
        .update(repositories)
        .set({ reviewTaskIds: ["builtin:review-pr"] })
        .where(eq(repositories.id, repoId));
    });

    /**
     * Enqueues a review run of both tasks and completes each task run with
     * `outcomes[i]` (null: it fails for good), its `fixed` findings (by ID)
     * reported fixed. With two finished task runs the correlation fails, so
     * the run is posted with its findings unmerged.
     */
    async function completeRun(
      number: number,
      mode: "incremental" | "fresh",
      outcomes: ({ found: Finding[]; fixed?: string[] } | null)[],
    ) {
      const enqueued = await enqueue(number, mode);
      if (enqueued.status !== "enqueued") throw new Error(enqueued.status);
      expect(enqueued.runs.map((r) => r.taskId)).toEqual(["builtin:review-pr", SECURITY_TASK_ID]);
      for (const [i, run] of enqueued.runs.entries()) {
        const job = await reviewJob(run.reviewId);
        const outcome = outcomes[i];
        if (!outcome) {
          await onReviewJobFailed(db, { ...job, status: "failed" }, "boom");
          continue;
        }
        const given = reviewTriggerContext(job.payload).previousReview?.openFindings ?? [];
        const fixedOpenFindings = (outcome.fixed ?? []).map((id) =>
          given.findIndex((f) => f.id === id),
        );
        expect(fixedOpenFindings).not.toContain(-1);
        await onReviewJobCompleted(db, {
          ...job,
          status: "completed",
          result: { ...result(outcome.found), fixedOpenFindings },
        });
      }
      const [run] = await db
        .select()
        .from(reviewRuns)
        .where(eq(reviewRuns.id, enqueued.reviewRunId));
      if (run!.status === "correlating") {
        // Nothing is posted, superseded or resolved before the correlation ends.
        expect(state.scm.calls.postReview.filter((p) => p.number === number)).toHaveLength(0);
        const [correlation] = await db
          .select()
          .from(jobs)
          .where(eq(jobs.id, run!.correlationJobId!));
        await onCorrelationFailed(db, correlation!, "Correlation failed: boom");
      }
      return enqueued;
    }

    it("resolves an open finding only when every completed task run reported it fixed", async () => {
      const { number, findings: prior } = await reviewedPr([
        {},
        { path: "src/other.ts" },
        { path: "src/third.ts" },
      ]);
      await completeRun(number, "incremental", [
        { found: [], fixed: [prior[0]!.id, prior[1]!.id] },
        { found: [], fixed: [prior[1]!.id, prior[2]!.id] },
      ]);
      expect((await findingRow(prior[0]!.id)).status).toBe("open");
      expect((await findingRow(prior[1]!.id)).status).toBe("resolved");
      expect((await findingRow(prior[2]!.id)).status).toBe("open");
      expect(state.scm.calls.resolveThread).toEqual([
        { number, commentId: prior[1]!.scmCommentId },
      ]);
      expect(state.scm.calls.postReview.filter((p) => p.number === number)).toHaveLength(1);
    });

    it("keeps a finding open that another task of the run raised again", async () => {
      const { number, findings: prior } = await reviewedPr();
      await completeRun(number, "incremental", [
        { found: [], fixed: [prior[0]!.id] },
        { found: [newFinding()], fixed: [prior[0]!.id] },
      ]);
      expect((await findingRow(prior[0]!.id)).status).toBe("open");
    });

    it("lets a failed task run neither block the post nor the resolve", async () => {
      const { number, findings: prior } = await reviewedPr();
      const enqueued = await completeRun(number, "incremental", [
        { found: [], fixed: [prior[0]!.id] },
        null,
      ]);
      expect((await findingRow(prior[0]!.id)).status).toBe("resolved");
      const posts = state.scm.calls.postReview.filter((p) => p.number === number);
      expect(posts).toHaveLength(1);
      expect(posts[0]!.summary).toContain(
        "This review task failed, so its findings are missing: Security review.",
      );
      const [run] = await db
        .select()
        .from(reviewRuns)
        .where(eq(reviewRuns.id, enqueued.reviewRunId));
      expect(run!.status).toBe("completed");
    });

    it("never supersedes findings of the same review run", async () => {
      const { number, findings: prior } = await reviewedPr();
      const enqueued = await completeRun(number, "fresh", [
        { found: [newFinding()] },
        { found: [newFinding({ title: "Same issue, other task" })] },
      ]);
      const runFindings = await listReviewRunFindings(db, enqueued.reviewRunId);
      expect(runFindings).toHaveLength(2);
      // Both stay open and are posted (the correlation failed, so unmerged).
      expect(runFindings.map((f) => f.status)).toEqual(["open", "open"]);
      expect(runFindings.every((f) => f.scmCommentId !== null)).toBe(true);
      // The earlier review's matching finding is superseded once, by the run's first finding.
      expect(await findingRow(prior[0]!.id)).toMatchObject({
        status: "superseded",
        supersededByFindingId: runFindings[0]!.id,
      });
      expect(state.scm.calls.resolveThread).toEqual([
        { number, commentId: prior[0]!.scmCommentId },
      ]);
      const posts = state.scm.calls.postReview.filter((p) => p.number === number);
      expect(posts).toHaveLength(1);
      expect(posts[0]!.inlineComments.map((c) => c.body.split("\n").at(-1))).toEqual([
        "_correctness · confidence 90% · Review a pull request_",
        "_correctness · confidence 90% · Security review_",
      ]);
    });
  });

  describe("Re-run (POST /api/ui/reviews/{id}/rerun)", () => {
    const prJobs = async (number: number) =>
      (
        await db
          .select()
          .from(jobs)
          .where(and(eq(jobs.type, "review.task")))
      ).filter((j) => reviewTriggerContext(j.payload).prNumber === number);

    it("enqueues a manual fresh review of the PR's current head", async () => {
      const { number, review } = await reviewedPr();
      const res = await rerunReview(review.id, { mode: "fresh", profileId: "deep" });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(state.scm.calls.getChangeRequest).toEqual([number]);
      const payload = reviewTriggerContext((await reviewJob(res.reviewId)).payload);
      expect(payload).toMatchObject({ mode: "fresh", headSha: HEAD, previousReview: null });
      expect(payload.reviewConfig.profile.id).toBe("deep");
      const [created] = await db.select().from(reviews).where(eq(reviews.id, res.reviewId));
      expect(created).toMatchObject({ trigger: "manual", headSha: HEAD, profileId: "deep" });
    });

    it("runs Incremental as a full review that keeps the repository's profile", async () => {
      const { review } = await reviewedPr();
      const res = await rerunReview(review.id, { mode: "incremental", profileId: null });
      if (!res.ok) throw new Error(res.error);
      const payload = reviewTriggerContext((await reviewJob(res.reviewId)).payload);
      expect(payload.mode).toBe("full");
      expect(payload.previousReview?.openFindings).toHaveLength(1);
      expect(payload.reviewConfig.profile.id).toBe("standard");
    });

    it("rejects members", async () => {
      const { number, review } = await reviewedPr();
      state.user = member;
      const res = await rerunReview(review.id, { mode: "fresh", profileId: null });
      expect(res.ok).toBe(false);
      expect(state.scm.calls.getChangeRequest).toHaveLength(0);
      expect(await prJobs(number)).toHaveLength(0);
    });

    it("refuses a closed or merged PR without creating a job", async () => {
      for (const prState of ["closed", "merged"] as const) {
        const { number, review } = await reviewedPr();
        state.scm.pr.state = prState;
        const res = await rerunReview(review.id, { mode: "incremental", profileId: null });
        expect(res).toEqual({
          ok: false,
          error: `This change request is ${prState}, so it can't be reviewed again.`,
        });
        expect(await prJobs(number)).toHaveLength(0);
      }
    });

    it("reports an active review of the same head instead of enqueuing a second job", async () => {
      const { number, review } = await reviewedPr();
      const first = await rerunReview(review.id, { mode: "fresh", profileId: null });
      if (!first.ok) throw new Error(first.error);
      const second = await rerunReview(review.id, { mode: "incremental", profileId: null });
      expect(second).toEqual({
        ok: false,
        error: `A review of ${HEAD.slice(0, 12)} is already queued or running.`,
        activeReviewId: first.reviewId,
      });
      expect(await prJobs(number)).toHaveLength(1);
    });

    it("rejects invalid options and unknown reviews", async () => {
      const { review } = await reviewedPr();
      const bad = await rerunReview(review.id, {
        mode: "sideways" as "fresh",
        profileId: null,
      });
      expect(bad.ok).toBe(false);
      const missing = await rerunReview("00000000-0000-4000-8000-000000000000", {
        mode: "fresh",
        profileId: null,
      });
      expect(missing).toEqual({ ok: false, error: "That review doesn't exist." });
    });
  });
});
