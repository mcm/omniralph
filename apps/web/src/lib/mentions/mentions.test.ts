import { randomBytes, randomUUID } from "node:crypto";
import {
  harnesses,
  connectRepository,
  closeDb,
  createDb,
  createReview,
  createRun,
  feedback,
  findings,
  getJob,
  getMainLane,
  getReviewDetail,
  jobs,
  listPendingRequests,
  ralphRuns,
  repositories,
  reviewRuns,
  reviews,
  setAllowedTaskTypeDefaults,
  updateLane,
  updateRepositoryCoding,
  upsertScmConnection,
  users,
  type Database,
  type Job,
  organizations,
} from "@omniralph/db";
import type { ChangeRequest, ScmAdapter } from "@omniralph/scm";
import {
  MAX_REPLY_ANSWER_LENGTH,
  QUERY_TASKS_MIN_HARNESS_VERSION,
  reviewProfileConfigForDepth,
  reviewTriggerContext,
  RunSpecJobPayload,
  type QueryRunResult,
} from "@omniralph/shared";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeLinearGateway, linearRun } from "@/lib/linear/fake-gateway";
import { reviewDetailView } from "@/lib/reviews/history";
import type * as Adapters from "@/lib/scm/adapters";

vi.mock("server-only", () => ({}));

/** Records every code-host call; `writers` have write access. */
function fakeAdapter() {
  const calls = {
    postComment: [] as { number: number; body: string }[],
    replyToComment: [] as { number: number; commentId: string; body: string }[],
    resolveThread: [] as { number: number; commentId: string }[],
    hasWriteAccess: [] as string[],
  };
  const writers = new Set<string>(["maintainer", "dev"]);
  const head = { sha: "f".repeat(40), state: "open" as ChangeRequest["state"] };
  const adapter: ScmAdapter = {
    provider: "github",
    async getChangeRequest(_repo, number): Promise<ChangeRequest> {
      return {
        number,
        title: "Add login",
        description: "Please review",
        author: "octocat",
        draft: false,
        state: head.state,
        baseSha: "a".repeat(40),
        headSha: head.sha,
        baseRef: "main",
        headRef: "feature",
        url: `https://github.com/acme/app/pull/${number}`,
      };
    },
    async postReview() {
      throw new Error("not used");
    },
    async postComment(_repo, number, body) {
      calls.postComment.push({ number, body });
      return { id: `c${calls.postComment.length}` };
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
    async hasWriteAccess(_repo, username) {
      calls.hasWriteAccess.push(username);
      return writers.has(username);
    },
    async verifyWebhook() {
      return true;
    },
  };
  return { adapter, calls, writers, head };
}

const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  scm: undefined as unknown as ReturnType<typeof fakeAdapter>,
  linear: undefined as unknown as FakeLinearGateway,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/scm/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof Adapters>()),
  scmAdapterFor: () => state.scm.adapter,
}));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.APP_URL = "https://omniralph.example.com";

const { handleWebhook } = await import("@/lib/webhooks/ingest");
const { getDispatcher } = await import("@/lib/dispatch");
const { onReviewJobStarted } = await import("@/lib/review/jobs");
const { jobHooks } = await import("@/lib/sinks");
const { BUILTIN_PLAYBOOK_SOURCE } = await import("@/lib/playbooks");
const { resolveRunSpec } = await import("@/lib/runs/resolve");

/** The thread-reply sink's hooks for a `review.reply` job. */
async function replyHooks(job: Job) {
  const hooks = await jobHooks(job, BUILTIN_PLAYBOOK_SOURCE);
  if (!hooks?.onCompleted || !hooks.onFailed || !hooks.isValidResult)
    throw new Error("review.reply jobs have the finding-thread sink's hooks");
  return hooks as Required<Pick<typeof hooks, "onCompleted" | "onFailed" | "isValidResult">>;
}

/** A `review.reply` job's trigger context. */
function replyContext(job: Job): Record<string, unknown> {
  return RunSpecJobPayload.parse(job.payload).trigger.context;
}

const databaseAvailable = testDatabaseAvailable();

const SHA = (n: number) => n.toString(16).padStart(40, "0");

describe.skipIf(!databaseAvailable)("@bot mention commands", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let repoId: string;
  let prCounter = 0;
  let deferred: Promise<void>[] = [];

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
    state.db = db;
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
    state.scm = fakeAdapter();
    state.linear = new FakeLinearGateway();
    deferred = [];
  });

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  /** Delivers a comment webhook and waits for the deferred command to finish. */
  async function deliver(
    event: "issue_comment" | "pull_request_review_comment",
    body: Record<string, unknown>,
    delivery: string = randomUUID(),
  ) {
    const req = new Request("http://localhost/api/webhooks/github", {
      method: "POST",
      headers: { "x-github-event": event, "x-github-delivery": delivery },
      body: JSON.stringify({ installation: { id: 4242 }, repository: { id: 100 }, ...body }),
    });
    const res = await handleWebhook("github", req, {
      db,
      dispatcher: getDispatcher(),
      adapterFor: () => state.scm.adapter,
      defer: (task) => {
        deferred.push(task());
      },
      handle: "omniralph",
      linear: async () => state.linear,
    });
    await Promise.all(deferred);
    return (await res.json()) as Record<string, unknown>;
  }

  const conversationComment = (number: number, text: string, login = "maintainer") =>
    deliver("issue_comment", {
      action: "created",
      issue: { number, pull_request: {} },
      comment: { id: Math.floor(Math.random() * 1e9), body: text, user: { login, type: "User" } },
    });

  const threadComment = (number: number, threadId: string, text: string, login = "maintainer") =>
    deliver("pull_request_review_comment", {
      action: "created",
      pull_request: { number },
      comment: {
        id: Math.floor(Math.random() * 1e9),
        in_reply_to_id: Number(threadId),
        body: text,
        user: { login, type: "User" },
      },
    });

  /** A completed webhook review of `headSha` with one open finding posted as thread `commentId`. */
  async function reviewedPr(headSha = SHA(2)) {
    const number = ++prCounter;
    const review = await createReview(db, {
      repositoryId: repoId,
      prNumber: number,
      headSha,
      baseSha: SHA(1),
      trigger: "webhook",
      depth: "standard",
      model: null,
      budget: 200_000,
    });
    await db.update(reviews).set({ status: "completed" }).where(eq(reviews.id, review.id));
    const commentId = String(1000 + number);
    const [finding] = await db
      .insert(findings)
      .values({
        reviewId: review.id,
        path: "src/app.ts",
        startLine: 3,
        endLine: 4,
        severity: "high",
        category: "correctness",
        title: "Missing null check",
        body: "`load()` can return undefined.",
        confidence: 0.8,
        scmCommentId: commentId,
      })
      .returning();
    return { number, review, finding: finding!, commentId };
  }

  async function prReviewJobs(number: number): Promise<Job[]> {
    return db
      .select()
      .from(jobs)
      .where(and(eq(jobs.type, "review.task"), eq(jobs.repositoryId, repoId)))
      .then((rows) => rows.filter((j) => reviewTriggerContext(j.payload).prNumber === number));
  }

  describe("@bot review", () => {
    it("enqueues a full review of the current head that still suppresses open findings", async () => {
      const { number } = await reviewedPr();
      const res = await conversationComment(number, "@omniralph review");
      expect(res).toEqual({ status: "accepted", command: "review" });

      const [job] = await prReviewJobs(number);
      const payload = reviewTriggerContext(job!.payload);
      expect(payload.headSha).toBe("f".repeat(40));
      expect(payload.baseSha).toBe("a".repeat(40));
      // Full (not incremental) review: no previous head, but open findings are deduped.
      expect(payload.previousReview).toEqual({
        headSha: null,
        openFindings: [
          expect.objectContaining({
            path: "src/app.ts",
            startLine: 3,
            endLine: 4,
            category: "correctness",
          }),
        ],
      });
      expect(payload.reviewConfig.profile.id).toBe("standard");
      const [review] = await db.select().from(reviews).where(eq(reviews.id, payload.reviewId));
      expect(review).toMatchObject({ trigger: "mention", status: "queued", depth: "standard" });

      expect(state.scm.calls.hasWriteAccess).toEqual(["maintainer"]);
      expect(state.scm.calls.postComment).toHaveLength(1);
      expect(state.scm.calls.postComment[0]!.body).toContain("@maintainer");
      expect(state.scm.calls.postComment[0]!.body).toContain("full review");
      expect(payload.mode).toBe("full");
    });

    it("reviews with the Quick model and token cap for @bot review quick", async () => {
      const { number } = await reviewedPr();
      await conversationComment(number, "@omniralph review quick");
      const [job] = await prReviewJobs(number);
      const payload = reviewTriggerContext(job!.payload);
      // The repository is on Standard; the command overrides the depth for this review only.
      expect(payload.reviewConfig.profile).toEqual(reviewProfileConfigForDepth("quick"));
      const [review] = await db.select().from(reviews).where(eq(reviews.id, payload.reviewId));
      expect(review).toMatchObject({
        depth: "quick",
        model: "claude-haiku-5-5",
        budget: 60_000,
      });
      const [run] = await db
        .select()
        .from(reviewRuns)
        .where(eq(reviewRuns.id, review!.reviewRunId!));
      expect(run!.depth).toBe("quick");
      // The agent runs it with the Quick preset's model, cap and file limit, without exploring.
      const token = { jobId: job!.id, token: "t", expiresIn: 900 };
      const spec = await resolveRunSpec(db, job!, {
        lifecycle: { ...token, kind: "lifecycle" },
        session: { ...token, kind: "session" },
      });
      expect(spec).toMatchObject({ model: "claude-haiku-5-5", tokenBudget: 60_000, maxFiles: 15 });
      expect(spec.agent.tools.builtin).not.toContain("Grep");
      expect(state.scm.calls.postComment[0]!.body).toContain("a full **Quick** review");
      const [repo] = await db.select().from(repositories).where(eq(repositories.id, repoId));
      expect(repo!.reviewDepth).toBe("standard");
    });

    it("applies a depth override", async () => {
      const { number } = await reviewedPr();
      await conversationComment(number, "@OmniRalph  Review   DEEP");
      const [job] = await prReviewJobs(number);
      const payload = reviewTriggerContext(job!.payload);
      expect(payload.reviewConfig.profile).toMatchObject({
        id: "deep",
        maxTokensPerReview: 500_000,
      });
      const [review] = await db.select().from(reviews).where(eq(reviews.id, payload.reviewId));
      expect(review).toMatchObject({ depth: "deep", budget: 500_000 });
      expect(state.scm.calls.postComment[0]!.body).toContain("**Deep**");
    });

    it("re-reviews a head that was already reviewed (no already_reviewed skip)", async () => {
      const { number } = await reviewedPr("f".repeat(40));
      await conversationComment(number, "@omniralph review");
      const [job] = await prReviewJobs(number);
      const [agent] = await db
        .insert(harnesses)
        .values({ organizationId: orgId, name: "agent-1" })
        .returning();
      await expect(onReviewJobStarted(db, job!, agent!.id)).resolves.toEqual({ skip: false });
    });

    it("refuses to review a closed or merged pull request", async () => {
      const { number } = await reviewedPr();
      state.scm.head.state = "merged";
      await conversationComment(number, "@omniralph review fresh");
      expect(await prReviewJobs(number)).toHaveLength(0);
      expect(state.scm.calls.postComment[0]!.body).toContain(
        "this merged pull request can't be reviewed again",
      );
    });

    it("answers a second request for the same head with the queued job", async () => {
      const { number } = await reviewedPr();
      await conversationComment(number, "@omniralph review");
      await conversationComment(number, "@omniralph review");
      expect(await prReviewJobs(number)).toHaveLength(1);
      expect(state.scm.calls.postComment[1]!.body).toContain("already queued or running");
    });

    it("politely refuses users without write access", async () => {
      const { number } = await reviewedPr();
      await conversationComment(number, "@omniralph review deep", "drive-by");
      expect(await prReviewJobs(number)).toHaveLength(0);
      expect(state.scm.calls.hasWriteAccess).toEqual(["drive-by"]);
      expect(state.scm.calls.postComment).toHaveLength(1);
      expect(state.scm.calls.postComment[0]!.body).toMatch(
        /^Sorry @drive-by, only people with write access/,
      );
    });
  });

  describe("@bot review fresh", () => {
    it("enqueues a fresh mention review of the current head with no open findings to suppress", async () => {
      const { number } = await reviewedPr();
      const res = await conversationComment(number, "@OmniRalph   review  FRESH  quick");
      expect(res).toEqual({ status: "accepted", command: "review" });

      const [job] = await prReviewJobs(number);
      const payload = reviewTriggerContext(job!.payload);
      expect(payload.mode).toBe("fresh");
      expect(payload.headSha).toBe("f".repeat(40));
      expect(payload.previousReview).toBeNull();
      expect(payload.reviewConfig.profile.id).toBe("quick");
      const [review] = await db.select().from(reviews).where(eq(reviews.id, payload.reviewId));
      expect(review).toMatchObject({ trigger: "mention", depth: "quick" });
      expect(state.scm.calls.postComment[0]!.body).toContain("a fresh **Quick** review");

      const [agent] = await db
        .insert(harnesses)
        .values({ organizationId: orgId, name: "agent-fresh" })
        .returning();
      await expect(onReviewJobStarted(db, job!, agent!.id)).resolves.toEqual({ skip: false });
    });

    it("politely refuses users without write access", async () => {
      const { number } = await reviewedPr();
      await conversationComment(number, "@omniralph review fresh", "drive-by");
      expect(await prReviewJobs(number)).toHaveLength(0);
      expect(state.scm.calls.hasWriteAccess).toEqual(["drive-by"]);
      expect(state.scm.calls.postComment[0]!.body).toMatch(
        /^Sorry @drive-by, only people with write access/,
      );
    });
  });

  describe("@bot dismiss", () => {
    it("dismisses the thread's finding, records scm feedback, resolves the thread and acknowledges", async () => {
      const { number, finding, commentId } = await reviewedPr();
      const res = await threadComment(
        number,
        commentId,
        "@omniralph dismiss won't fix: legacy code",
      );
      expect(res).toEqual({ status: "accepted", command: "dismiss" });

      const [row] = await db.select().from(findings).where(eq(findings.id, finding.id));
      expect(row!.status).toBe("dismissed");
      const [entry] = await db.select().from(feedback).where(eq(feedback.findingId, finding.id));
      expect(entry).toMatchObject({
        source: "scm",
        reason: "wont_fix",
        note: "legacy code",
        scmUsername: "maintainer",
        userId: null,
      });
      expect(state.scm.calls.resolveThread).toEqual([{ number, commentId }]);
      expect(state.scm.calls.replyToComment).toHaveLength(1);
      expect(state.scm.calls.replyToComment[0]).toMatchObject({ number, commentId });
      expect(state.scm.calls.replyToComment[0]!.body).toContain(
        "dismissed this finding (won't fix)",
      );
      // Only false positives become learned rules.
      expect(await db.select().from(jobs).where(eq(jobs.type, "review.learn-rule"))).toHaveLength(
        0,
      );
    });

    it("shows the dismissal in the review's history, beside older control panel feedback", async () => {
      const { number, finding, commentId } = await reviewedPr();
      // History from before dismissing moved to the PR: a `ui` dismissal, since restored.
      await db
        .insert(users)
        .values({ id: "history-user", name: "Mia Member", email: "mia@example.com" })
        .onConflictDoNothing();
      await db.insert(feedback).values({
        findingId: finding.id,
        source: "ui",
        reason: "false_positive",
        note: "safe",
        userId: "history-user",
        createdAt: new Date("2026-10-01T09:00:00Z"),
        restoredAt: new Date("2026-10-01T10:00:00Z"),
        restoredBy: "history-user",
      });
      await threadComment(number, commentId, "@omniralph dismiss not relevant");

      const view = reviewDetailView((await getReviewDetail(db, orgId, finding.reviewId))!);
      const shown = view.files.flatMap((f) => f.findings).find((f) => f.id === finding.id);
      expect(shown).toMatchObject({
        status: "dismissed",
        feedback: [
          {
            source: "ui",
            reason: "false_positive",
            note: "safe",
            actor: "Mia Member",
            restoredBy: "Mia Member",
            restoredAt: expect.any(String),
          },
          {
            source: "scm",
            reason: "not_relevant",
            note: null,
            actor: "@maintainer",
            restoredAt: null,
            restoredBy: null,
          },
        ],
      });
    });

    it("defaults to false_positive, which enqueues rule generation", async () => {
      const { number, finding, commentId } = await reviewedPr();
      await threadComment(number, commentId, "@omniralph dismiss");
      const [entry] = await db.select().from(feedback).where(eq(feedback.findingId, finding.id));
      expect(entry).toMatchObject({ source: "scm", reason: "false_positive", note: null });
      const learn = await db.select().from(jobs).where(eq(jobs.type, "review.learn-rule"));
      const findingIdOf = (payload: unknown) =>
        (payload as { trigger: { context: { finding: { id: string } } } }).trigger.context.finding
          .id;
      expect(
        learn.some(
          (j) => j.taskId === "builtin:learn-rule" && findingIdOf(j.payload) === finding.id,
        ),
      ).toBe(true);
      expect(state.scm.calls.replyToComment[0]!.body).toContain("I'll learn from it");
    });

    it("dismisses a false positive without rule generation when query tasks are off", async () => {
      const setQuery = (queryEnabled: boolean | null) =>
        db.update(repositories).set({ queryEnabled }).where(eq(repositories.id, repoId));
      const learnJobs = () => db.select().from(jobs).where(eq(jobs.type, "review.learn-rule"));
      const before = (await learnJobs()).length;
      try {
        await setQuery(false);
        const { number, finding, commentId } = await reviewedPr();
        await threadComment(number, commentId, "@omniralph dismiss");
        const [row] = await db.select().from(findings).where(eq(findings.id, finding.id));
        expect(row!.status).toBe("dismissed");
        expect(await learnJobs()).toHaveLength(before);
        expect(state.scm.calls.replyToComment).toHaveLength(1);
        expect(state.scm.calls.replyToComment[0]!.body).toContain("dismissed this finding");
        expect(state.scm.calls.replyToComment[0]!.body).not.toContain("learn");

        // Inheriting an organization default without query tasks.
        await setQuery(null);
        await setAllowedTaskTypeDefaults(db, orgId, ["review", "coding"], null);
        const inheriting = await reviewedPr();
        await threadComment(inheriting.number, inheriting.commentId, "@omniralph dismiss");
        expect(await learnJobs()).toHaveLength(before);
      } finally {
        await setQuery(null);
        await setAllowedTaskTypeDefaults(db, orgId, null, null);
      }
    });

    it("refuses users without write access and leaves the finding open", async () => {
      const { number, finding, commentId } = await reviewedPr();
      await threadComment(number, commentId, "@omniralph dismiss", "drive-by");
      const [row] = await db.select().from(findings).where(eq(findings.id, finding.id));
      expect(row!.status).toBe("open");
      expect(state.scm.calls.resolveThread).toHaveLength(0);
      expect(state.scm.calls.replyToComment[0]!.body).toMatch(/^Sorry @drive-by/);
    });

    it("says so when the finding is already dismissed or the thread isn't a finding's", async () => {
      const { number, commentId } = await reviewedPr();
      await threadComment(number, commentId, "@omniralph dismiss");
      await threadComment(number, commentId, "@omniralph dismiss");
      expect(state.scm.calls.replyToComment[1]!.body).toContain("already dismissed");

      await threadComment(number, "999999", "@omniralph dismiss");
      expect(state.scm.calls.replyToComment[2]).toMatchObject({ commentId: "999999" });
      expect(state.scm.calls.replyToComment[2]!.body).toContain(
        "only works in the thread of one of my findings",
      );
    });
  });

  describe("questions", () => {
    async function replyJobs(): Promise<Job[]> {
      return db.select().from(jobs).where(eq(jobs.type, "review.reply"));
    }

    it("creates a review.reply job for any other mention in a finding's thread", async () => {
      const { number, review, finding, commentId } = await reviewedPr();
      const before = (await replyJobs()).length;
      const res = await threadComment(
        number,
        commentId,
        "Is this really reachable, @omniralph?",
        "maintainer",
      );
      expect(res).toEqual({ status: "accepted", command: "question" });
      expect(state.scm.calls.hasWriteAccess).toEqual(["maintainer"]);

      const created = (await replyJobs()).slice(before);
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({
        repositoryId: repoId,
        status: "queued",
        targetHarnessId: null,
      });
      expect(created[0]).toMatchObject({
        taskType: "query",
        taskId: "builtin:reply-to-finding",
        minHarnessVersion: QUERY_TASKS_MIN_HARNESS_VERSION,
        // Once per asking comment.
        dedupeKey: expect.stringMatching(new RegExp(`^review\\.reply:${repoId}:\\d+$`)),
      });
      const payload = RunSpecJobPayload.parse(created[0]!.payload);
      expect(payload).toMatchObject({
        trigger: {
          kind: "finding.mention",
          context: {
            repository: "acme/app",
            pr: { number },
            review: { id: review.id },
            finding: {
              id: finding.id,
              path: "src/app.ts",
              file: '"src/app.ts"',
              startLine: 3,
              endLine: 4,
              location: "lines 3-4",
              title: "Missing null check",
              baseSha: SHA(1),
              headSha: SHA(2),
            },
            question: "Is this really reachable, @omniralph?",
            askedBy: "maintainer",
            threadCommentId: commentId,
            // 10% of the Standard profile's 200,000-token budget.
            budgetTokens: 20_000,
          },
        },
        repositoryId: repoId,
        ref: SHA(2),
      });
      // The answer is the reply; nothing is posted yet.
      expect(state.scm.calls.replyToComment).toHaveLength(0);
    });

    it("skips questions without replying when the repository's query tasks are off", async () => {
      const setQuery = (queryEnabled: boolean | null) =>
        db.update(repositories).set({ queryEnabled }).where(eq(repositories.id, repoId));
      const before = (await replyJobs()).length;
      try {
        await setQuery(false);
        const off = await reviewedPr();
        await threadComment(off.number, off.commentId, "Is this reachable, @omniralph?");
        expect(await replyJobs()).toHaveLength(before);
        expect(state.scm.calls.replyToComment).toEqual([]);

        // Inheriting an organization default without query tasks.
        await setQuery(null);
        await setAllowedTaskTypeDefaults(db, orgId, ["review", "coding"], null);
        const inheriting = await reviewedPr();
        await threadComment(inheriting.number, inheriting.commentId, "Why, @omniralph?");
        expect(await replyJobs()).toHaveLength(before);
        expect(state.scm.calls.replyToComment).toEqual([]);

        // An explicit switch wins over the organization default.
        await setQuery(true);
        const on = await reviewedPr();
        await threadComment(on.number, on.commentId, "And now, @omniralph?");
        expect(await replyJobs()).toHaveLength(before + 1);
      } finally {
        await setQuery(null);
        await setAllowedTaskTypeDefaults(db, orgId, null, null);
      }
    });

    it("politely refuses questions in a finding's thread from users without write access", async () => {
      const { number, commentId } = await reviewedPr();
      const before = (await replyJobs()).length;
      await threadComment(number, commentId, "@omniralph is this real?", "drive-by");
      expect(await replyJobs()).toHaveLength(before);
      expect(state.scm.calls.hasWriteAccess).toEqual(["drive-by"]);
      expect(state.scm.calls.replyToComment[0]!.body).toMatch(
        /^Sorry @drive-by, only people with write access to this repository can ask me about findings/,
      );
    });

    it("answers mentions outside a finding thread with the command list", async () => {
      const { number } = await reviewedPr();
      await conversationComment(number, "@omniralph what can you do?", "drive-by");
      expect(state.scm.calls.postComment[0]!.body).toContain("`@omniralph review`");
    });

    it("posts the agent's answer (sanitized) in the thread once, and an apology on failure", async () => {
      const { number, commentId } = await reviewedPr();
      await threadComment(number, commentId, "@omniralph why?", "dev");
      const [job] = (await replyJobs()).filter(
        (j) => replyContext(j).threadCommentId === commentId,
      );
      const hooks = await replyHooks(job!);
      const result: QueryRunResult = {
        outcome: "answered",
        answer: "It is, see [this](https://evil.example/x). cc @someone and @dev",
        structured: null,
        references: [],
        usage: { inputTokens: 5000, outputTokens: 200 },
        durationMs: 900,
      };
      expect(hooks.isValidResult(result)).toBe(true);
      expect(hooks.isValidResult({ ...result, answer: null })).toBe(false);
      expect(hooks.isValidResult({ ...result, answer: null, structured: { rule: null } })).toBe(
        false,
      );
      const [completed] = await db
        .update(jobs)
        .set({ status: "completed", result })
        .where(eq(jobs.id, job!.id))
        .returning();
      expect(await hooks.onCompleted(db, completed!)).toBe(true);
      expect(await hooks.onCompleted(db, completed!)).toBe(false);
      expect(state.scm.calls.replyToComment).toHaveLength(1);
      const { body } = state.scm.calls.replyToComment[0]!;
      expect(state.scm.calls.replyToComment[0]!.commentId).toBe(commentId);
      expect(body).toContain("`https://evil.example/x`");
      expect(body).toContain("`@someone`");
      expect(body).toContain("@dev");
      expect(body).toContain(`https://omniralph.example.com/reviews/`);
      expect((await getJob(db, job!.id))!.scmCommentId).toBe("r1");

      // A failed reply posts an apology (once).
      await threadComment(number, commentId, "@omniralph and this?", "dev");
      const [second] = (await replyJobs()).filter(
        (j) => replyContext(j).question === "@omniralph and this?",
      );
      expect(await hooks.onFailed(db, second!, "boom")).toBe(true);
      expect(await hooks.onFailed(db, (await getJob(db, second!.id))!, "boom")).toBe(false);
      expect(state.scm.calls.replyToComment[1]!.body).toContain("Sorry, I couldn't answer");
    });

    it("posts a note when the answer ran out of budget", async () => {
      const { number, commentId } = await reviewedPr();
      await threadComment(number, commentId, "@omniralph explain", "dev");
      const [job] = (await replyJobs()).filter(
        (j) => replyContext(j).threadCommentId === commentId,
      );
      const [completed] = await db
        .update(jobs)
        .set({
          status: "completed",
          result: {
            outcome: "budget_exhausted",
            answer: null,
            structured: null,
            references: [],
            usage: { inputTokens: 20_000, outputTokens: 0 },
            durationMs: 5,
          } satisfies QueryRunResult,
        })
        .where(eq(jobs.id, job!.id))
        .returning();
      await (await replyHooks(completed!)).onCompleted(db, completed!);
      expect(state.scm.calls.replyToComment[0]!.body).toContain("reply budget (20,000 tokens)");
    });

    it("caps a long answer at the thread reply length", async () => {
      const { number, commentId } = await reviewedPr();
      await threadComment(number, commentId, "@omniralph explain at length", "dev");
      const [job] = (await replyJobs()).filter(
        (j) => replyContext(j).threadCommentId === commentId,
      );
      const [completed] = await db
        .update(jobs)
        .set({
          status: "completed",
          result: {
            outcome: "answered",
            answer: `  ${"word ".repeat(2000)}`,
            structured: null,
            references: [],
            usage: { inputTokens: 5000, outputTokens: 3000 },
            durationMs: 5,
          } satisfies QueryRunResult,
        })
        .where(eq(jobs.id, job!.id))
        .returning();
      await (await replyHooks(completed!)).onCompleted(db, completed!);
      const answer = state.scm.calls.replyToComment[0]!.body.split("\n\n_Omniralph · ")[0]!;
      expect(answer.length).toBeLessThanOrEqual(MAX_REPLY_ANSWER_LENGTH);
      expect(answer).toMatch(/^word word/);
      expect(answer).toMatch(/_…truncated_$/);
    });
  });

  describe("on ralph pull requests", () => {
    let runSeq = 0;

    /**
     * PR `number` opened by a ralph run of ENG-1 whose story job is queued
     * (so requests wait for it, and nothing else runs).
     */
    async function ralphPr(number: number) {
      await updateRepositoryCoding(db, repoId, {
        ralphEnabled: true,
      });
      runSeq += 1;
      const created = await createRun(db, {
        organizationId: orgId,
        linearIssueId: `issue-ralph-${runSeq}`,
        linearIdentifier: "ENG-1",
        linearUrl: "https://linear.app/acme/issue/ENG-1",
        linearAgentSessionId: `session-ralph-${runSeq}`,
        kind: "children",
        repositoryId: repoId,
        branch: "eng-1-epic",
        baseBranch: "main",
        status: "running",
      });
      const run = linearRun(created.run);
      const lane = (await getMainLane(db, run))!;
      await updateLane(db, lane.id, {
        prNumber: number,
        prUrl: `https://github.com/acme/app/pull/${number}`,
      });
      await db.insert(jobs).values({
        organizationId: orgId,
        type: "ralph.story",
        taskType: "coding",
        ralphRunId: run.id,
        repositoryId: repoId,
      });
      return run;
    }

    const pending = async (runId: string) =>
      (await listPendingRequests(db, runId)).map((r) => ({
        text: r.text,
        author: r.author,
        trigger: r.trigger,
      }));

    it("@bot fix [text] becomes a request on the lane, with a link to the Linear issue", async () => {
      const { number } = await reviewedPr();
      const run = await ralphPr(number);
      const res = await conversationComment(number, "@omniralph fix rename `load` to `fetch`");
      expect(res).toEqual({ status: "accepted", command: "fix" });
      expect(state.scm.calls.hasWriteAccess).toEqual(["maintainer"]);
      const [request, ...more] = await pending(run.id);
      expect(more).toEqual([]);
      expect(request!.author).toBe("maintainer");
      expect(request!.trigger).toBe("pr.fix-command");
      expect(request!.text).toContain(
        `@maintainer asked on pull request #${number} (https://github.com/acme/app/pull/${number}):`,
      );
      expect(request!.text).toContain("rename `load` to `fetch`");
      expect(request!.text).toContain("push `eng-1-epic`");
      expect(request!.text).not.toContain("The finding:");
      expect(state.scm.calls.postComment).toHaveLength(1);
      expect(state.scm.calls.postComment[0]!.body).toContain(
        "On it, @maintainer: I passed this to the coding task of [ENG-1](<https://linear.app/acme/issue/ENG-1>), which will work on it once its current step finishes",
      );
      expect(state.linear.bodies(run.linearAgentSessionId, "thought")).toEqual([
        "@maintainer asked for changes on the pull request. I'll work through it as soon as the current step finishes.",
      ]);
    });

    it("@bot fix in a finding's thread includes the finding", async () => {
      const { number, commentId } = await reviewedPr();
      const run = await ralphPr(number);
      await threadComment(number, commentId, "@omniralph fix");
      const [request] = await pending(run.id);
      expect(request!.text).toContain("Fix this finding.");
      expect(request!.text).toContain("`src/app.ts:3` (high): **Missing null check**");
      expect(state.scm.calls.replyToComment).toHaveLength(1);
      expect(state.scm.calls.replyToComment[0]).toMatchObject({ number, commentId });
      expect(state.scm.calls.replyToComment[0]!.body).toContain("linear.app/acme/issue/ENG-1");
    });

    it("other @bot text outside finding threads becomes a request", async () => {
      const { number } = await reviewedPr();
      const run = await ralphPr(number);
      const res = await conversationComment(number, "@omniralph please also update the README");
      expect(res).toEqual({ status: "accepted", command: "question" });
      const [request] = await pending(run.id);
      expect(request!.text).toContain("please also update the README");
      expect(state.scm.calls.postComment[0]!.body).toContain("I passed this to the coding task");
    });

    /** PR `number`'s review run (with a summary) of one review with three findings: two open, posted as threads. */
    async function reviewRunPr() {
      const number = ++prCounter;
      const [reviewRun] = await db
        .insert(reviewRuns)
        .values({
          organizationId: orgId,
          repositoryId: repoId,
          prNumber: number,
          headSha: SHA(2),
          baseSha: SHA(1),
          trigger: "webhook",
          mode: "incremental",
          status: "completed",
          summary: "Two problems in the loader.",
        })
        .returning();
      const review = await createReview(db, {
        reviewRunId: reviewRun!.id,
        repositoryId: repoId,
        prNumber: number,
        headSha: SHA(2),
        baseSha: SHA(1),
        trigger: "webhook",
        depth: "standard",
        model: null,
        budget: 200_000,
      });
      await db.update(reviews).set({ status: "completed" }).where(eq(reviews.id, review.id));
      const base = {
        reviewId: review.id,
        endLine: 4,
        severity: "high",
        category: "correctness",
        body: "Details.",
        confidence: 0.8,
      } as const;
      const rows = await db
        .insert(findings)
        .values([
          {
            ...base,
            path: "src/b.ts",
            startLine: 3,
            title: "Missing null check",
            scmCommentId: String(5000 + number),
          },
          {
            ...base,
            path: "src/a.ts",
            startLine: 9,
            title: "Unbounded retry",
            scmCommentId: String(6000 + number),
          },
          {
            ...base,
            path: "src/c.ts",
            startLine: 1,
            title: "Already dismissed",
            status: "dismissed" as const,
          },
        ])
        .returning();
      return { number, commentId: String(5000 + number), findings: rows };
    }

    it("other @bot text in a finding's thread goes to the Linear session with the whole review", async () => {
      const { number, commentId, findings: rows } = await reviewRunPr();
      const run = await ralphPr(number);
      const res = await threadComment(
        number,
        commentId,
        "@omniralph please handle this and the retry one",
      );
      expect(res).toEqual({ status: "accepted", command: "question" });
      expect(
        (await db.select().from(jobs).where(eq(jobs.type, "review.reply"))).filter(
          (j) => replyContext(j).threadCommentId === commentId,
        ),
      ).toEqual([]);
      const [request, ...more] = await pending(run.id);
      expect(more).toEqual([]);
      expect(request!.trigger).toBe("pr.fix-command");
      expect(request!.text).toContain(
        `@maintainer asked on pull request #${number} (https://github.com/acme/app/pull/${number}) in the thread of one of Omniralph's review findings:`,
      );
      expect(request!.text).toContain("please handle this and the retry one");
      expect(request!.text).toContain(
        `\`src/b.ts:3\` (high): **Missing null check** [finding \`${rows[0]!.id}\`]`,
      );
      expect(request!.text).toContain("Summary:\nTwo problems in the loader.");
      expect(request!.text).toContain("Its other open findings (1):");
      expect(request!.text).toContain(
        `1. \`src/a.ts:9\` (high): **Unbounded retry** [finding \`${rows[1]!.id}\`]`,
      );
      expect(request!.text).not.toContain("Already dismissed");
      expect(state.scm.calls.replyToComment).toHaveLength(1);
      expect(state.scm.calls.replyToComment[0]).toMatchObject({ number, commentId });
      expect(state.scm.calls.replyToComment[0]!.body).toContain(
        "I passed this to the coding task of [ENG-1]",
      );
      expect(state.linear.bodies(run.linearAgentSessionId, "thought")).toEqual([
        "@maintainer asked for changes on the pull request. I'll work through it as soon as the current step finishes.",
      ]);
    });

    it("@bot fix in a finding's thread carries the rest of its review", async () => {
      const { number, commentId } = await reviewRunPr();
      const run = await ralphPr(number);
      await threadComment(number, commentId, "@omniralph fix");
      const [request] = await pending(run.id);
      expect(request!.text).toContain("Fix this finding.");
      expect(request!.text).toContain("**Missing null check**");
      expect(request!.text).toContain("**Unbounded retry**");
      expect(request!.text).toContain("Report each finding you worked on");
    });

    it("questions in a finding's thread are answered when the ralph run is over", async () => {
      const { number, commentId } = await reviewedPr();
      const run = await ralphPr(number);
      await db.update(jobs).set({ status: "canceled" }).where(eq(jobs.ralphRunId, run.id));
      await db.update(ralphRuns).set({ status: "failed" }).where(eq(ralphRuns.id, run.id));
      await threadComment(number, commentId, "@omniralph is this reachable?");
      const replies = await db.select().from(jobs).where(eq(jobs.type, "review.reply"));
      expect(
        replies.some(
          (j) =>
            j.taskId === "builtin:reply-to-finding" &&
            replyContext(j).threadCommentId === commentId,
        ),
      ).toBe(true);
      expect(await pending(run.id)).toEqual([]);
    });

    it("review, dismiss and help keep their v1 behaviour", async () => {
      const { number, commentId, finding } = await reviewedPr();
      const run = await ralphPr(number);
      await conversationComment(number, "@omniralph review");
      expect(await prReviewJobs(number)).toHaveLength(1);
      await conversationComment(number, "@omniralph help");
      expect(state.scm.calls.postComment.at(-1)!.body).toContain(
        "`@omniralph fix [what to change]`",
      );
      await threadComment(number, commentId, "@omniralph dismiss");
      const [row] = await db.select().from(findings).where(eq(findings.id, finding.id));
      expect(row!.status).toBe("dismissed");
      expect(await pending(run.id)).toEqual([]);
    });

    it("refuses users without write access", async () => {
      const { number } = await reviewedPr();
      const run = await ralphPr(number);
      await conversationComment(number, "@omniralph fix it", "drive-by");
      await conversationComment(number, "@omniralph update the README", "drive-by");
      expect(await pending(run.id)).toEqual([]);
      expect(state.scm.calls.postComment.map((c) => c.body)).toEqual([
        expect.stringMatching(
          /^Sorry @drive-by, only people with write access to this repository can use `@omniralph fix`/,
        ),
        expect.stringMatching(
          /^Sorry @drive-by, only people with write access to this repository can ask for changes/,
        ),
      ]);
    });

    it("@bot fix on a pull request ralph didn't open says it only works on ralph PRs", async () => {
      const { number } = await reviewedPr();
      const res = await conversationComment(number, "@omniralph fix the typo");
      expect(res).toEqual({ status: "accepted", command: "fix" });
      expect(state.scm.calls.postComment[0]!.body).toBe(
        "Sorry @maintainer, `@omniralph fix` only works on pull requests that Omniralph opened.",
      );
    });

    it("says so when the ralph run is over", async () => {
      const { number } = await reviewedPr();
      const run = await ralphPr(number);
      await db.update(jobs).set({ status: "canceled" }).where(eq(jobs.ralphRunId, run.id));
      await db.update(ralphRuns).set({ status: "failed" }).where(eq(ralphRuns.id, run.id));
      await conversationComment(number, "@omniralph fix the typo");
      expect(await pending(run.id)).toEqual([]);
      expect(state.scm.calls.postComment[0]!.body).toContain("the coding task of [ENG-1]");
      expect(state.scm.calls.postComment[0]!.body).toContain("is over");
    });
  });

  describe("ignored comments", () => {
    it("ignores the bot's own comments, other bots and comments without a mention", async () => {
      const { number } = await reviewedPr();
      const bot = await deliver("issue_comment", {
        action: "created",
        issue: { number, pull_request: {} },
        comment: {
          id: 1,
          body: "@omniralph review",
          user: { login: "omniralph[bot]", type: "Bot" },
        },
      });
      expect(bot).toEqual({ status: "ignored", reason: "own_comment" });
      expect(await conversationComment(number, "@omniralph review", "omniralph")).toEqual({
        status: "ignored",
        reason: "own_comment",
      });
      expect(await conversationComment(number, "Looks good to me")).toEqual({
        status: "ignored",
        reason: "no_mention",
      });
      expect(await conversationComment(number, "Run `@omniralph review` later")).toEqual({
        status: "ignored",
        reason: "no_mention",
      });
      expect(await prReviewJobs(number)).toHaveLength(0);
      expect(state.scm.calls.postComment).toHaveLength(0);
    });

    it("runs a redelivered command once", async () => {
      const { number } = await reviewedPr();
      const delivery = randomUUID();
      const body = {
        action: "created",
        issue: { number, pull_request: {} },
        comment: { id: 5, body: "@omniralph review", user: { login: "maintainer", type: "User" } },
      };
      expect(await deliver("issue_comment", body, delivery)).toMatchObject({ status: "accepted" });
      expect(await deliver("issue_comment", body, delivery)).toEqual({ status: "duplicate" });
      expect(state.scm.calls.postComment).toHaveLength(1);
    });
  });

  describe("on GitLab", () => {
    const BOT = "service_account_group_12_omniralph";

    /** Connects GitLab project `projectId` on a connection whose bot username is `botUsername`. */
    async function gitlabProject(projectId: number, botUsername: string | null) {
      const connection = (await upsertScmConnection(db, {
        organizationId: orgId,
        provider: "gitlab",
        name: `${botUsername ?? "old-bot"} @ gitlab.example.com`,
        baseUrl: "https://gitlab.example.com",
        externalId: String(projectId),
        credentials: {},
        botUsername,
      }))!;
      await connectRepository(db, {
        connectionId: connection.id,
        provider: "gitlab",
        externalId: String(projectId),
        fullPath: `acme/app-${projectId}`,
      });
    }

    /** Delivers a GitLab MR note on project `projectId`, MR !1. */
    async function note(projectId: number, text: string, username = "maintainer") {
      const req = new Request("http://localhost/api/webhooks/gitlab", {
        method: "POST",
        headers: { "x-gitlab-event": "Note Hook", "x-gitlab-event-uuid": randomUUID() },
        body: JSON.stringify({
          object_kind: "note",
          project: { id: projectId },
          user: { username },
          merge_request: { iid: 1 },
          object_attributes: {
            id: Math.floor(Math.random() * 1e9),
            note: text,
            noteable_type: "MergeRequest",
            action: "create",
          },
        }),
      });
      const res = await handleWebhook("gitlab", req, {
        db,
        dispatcher: getDispatcher(),
        adapterFor: () => state.scm.adapter,
        defer: (task) => {
          deferred.push(task());
        },
        handle: "omniralph",
        linear: async () => state.linear,
      });
      await Promise.all(deferred);
      return (await res.json()) as Record<string, unknown>;
    }

    it("answers mentions of the connection's bot username, not BOT_HANDLE", async () => {
      await gitlabProject(300, BOT);
      expect(await note(300, `@${BOT} help`)).toEqual({ status: "accepted", command: "help" });
      expect(state.scm.calls.postComment[0]!.body).toContain(`@${BOT} review`);
      expect(await note(300, "@omniralph help")).toEqual({
        status: "ignored",
        reason: "no_mention",
      });
      expect(state.scm.calls.postComment).toHaveLength(1);
    });

    it("ignores the bot user's own notes", async () => {
      await gitlabProject(301, BOT);
      expect(await note(301, `@${BOT} review`, BOT)).toEqual({
        status: "ignored",
        reason: "own_comment",
      });
      expect(state.scm.calls.postComment).toHaveLength(0);
    });

    it("falls back to BOT_HANDLE for a connection without a bot username", async () => {
      await gitlabProject(302, null);
      expect(await note(302, "@omniralph help")).toEqual({ status: "accepted", command: "help" });
      expect(await note(302, "@omniralph help", "omniralph")).toEqual({
        status: "ignored",
        reason: "own_comment",
      });
    });
  });
});
