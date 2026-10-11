import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  harnesses,
  connectRepository,
  closeDb,
  createDb,
  findings,
  jobs,
  listReviewRunFindings,
  listReviewRunReviews,
  previousReviewState,
  repositories,
  reviewRuns,
  reviews,
  rules,
  runMigrations,
  stickyComments,
  upsertScmConnection,
  type Database,
  organizations,
  seedReviewProfiles,
} from "@omniralph/db";
import { runReview, type ReviewProvider } from "@omniralph/engine";
import { GitHubAdapter } from "@omniralph/scm";
import {
  CORRELATION_JOB_TYPE,
  CorrelationTriggerContext,
  RunSpecJobPayload,
  reviewTriggerContext,
  REVIEW_TASKS_MIN_HARNESS_VERSION,
  type Finding,
  type JobOutcomeResponse,
  type JobStartResponse,
  type ReviewJobResult,
} from "@omniralph/shared";
import type * as Tasks from "@omniralph/tasks";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, asc, eq, inArray, lte, ne, sql } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
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

const signingKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const appKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
delete process.env.KMS_AGENT_ISSUER_ID;
delete process.env.GITHUB_APP_KMS_ISSUER_ID;
process.env.LOCAL_AGENT_SIGNING_KEY = signingKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.GITHUB_APP_ID = "12345";
process.env.GITHUB_APP_PRIVATE_KEY = appKey.export({ type: "pkcs8", format: "pem" }).toString();
process.env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
process.env.APP_URL = "https://omniralph.example.com";

const { getTokenSigner } = await import("@/lib/harness-auth/signer");
const { PostgresDispatcher } = await import("@/lib/dispatch");
const { enqueueReview } = await import("@/lib/review/enqueue");
const { POST: claim } = await import("./claim/route");
const { POST: result } = await import("./jobs/[id]/result/route");
const { POST: fail } = await import("./jobs/[id]/fail/route");

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

/** A deterministic git repo standing in for the harness's worktree. */
class Repo {
  readonly dir = mkdtempSync(join(tmpdir(), "omniralph-review-loop-"));
  private tick = 0;

  git(...args: string[]): string {
    this.tick += 1;
    const date = `2026-01-01T00:00:${String(this.tick).padStart(2, "0")}Z`;
    return execFileSync("git", args, {
      cwd: this.dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      },
    });
  }

  commit(files: Record<string, string>): string {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(this.dir, path)), { recursive: true });
      writeFileSync(join(this.dir, path), content);
    }
    this.git("add", "-A");
    this.git("commit", "-q", "-m", `change ${this.tick}`);
    return this.git("rev-parse", "HEAD").trim();
  }

  /** GitHub's `patch` for a file: the diff from its first hunk on. */
  patch(base: string, head: string, path: string): string {
    const diff = this.git("diff", `${base}...${head}`, "--", path);
    return diff.slice(diff.indexOf("@@"));
  }
}

const PHISHING_BODY = [
  "`token` is logged in plain text.",
  '<img src="https://evil.example/pixel.gif">',
  "Re-authenticate at [GitHub](https://github-login.evil.example/session) and ping @acme/security.",
  "Author: @octocat",
].join("\n");

/** The review provider (Claude) is mocked: one finding on the first changed line of the task. */
const provider: ReviewProvider = {
  async review(request) {
    const file = request.task.files[0]!;
    const line = file.hunks[0]!.lines.find((l) => l.type === "add")!.newLine!;
    const finding: Finding = {
      path: file.path,
      startLine: line,
      endLine: line,
      severity: "high",
      category: "security",
      title: "Token <b>logged</b>",
      body: PHISHING_BODY,
      suggestion: "logger.info({ user }, `login`);",
      confidence: 0.9,
    };
    return {
      findings: [finding],
      usage: { inputTokens: 1200, outputTokens: 300 },
      stopReason: "completed",
      discarded: { invalid: 0, outsideDiff: 0 },
    };
  },
};

const GITHUB = "https://api.github.com/repos/acme/app";
const github = {
  /** Current PR state the GitHub mock serves. */
  pr: { baseSha: "", headSha: "", files: [] as { filename: string; patch: string }[] },
  reviews: [] as { id: number; body: Record<string, unknown> }[],
  /** Issue (PR conversation) comments by ID. */
  comments: new Map<number, { issue: number; body: string }>(),
  /** Comment requests, in order: `create` (POST) or `edit` (PATCH). */
  commentRequests: [] as { kind: "create" | "edit"; id: number }[],
};
const server = setupServer(
  http.post("https://api.github.com/app/installations/4242/access_tokens", () =>
    HttpResponse.json(
      { token: "ghs_installation", expires_at: new Date(Date.now() + 3_600_000).toISOString() },
      { status: 201 },
    ),
  ),
  http.get(`${GITHUB}/pulls/:number`, ({ params }) =>
    HttpResponse.json({
      number: Number(params.number),
      head: { sha: github.pr.headSha },
      base: { sha: github.pr.baseSha },
    }),
  ),
  http.get(`${GITHUB}/pulls/:number/files`, () => HttpResponse.json(github.pr.files)),
  http.get(`${GITHUB}/compare/:basehead`, () => HttpResponse.json({ files: github.pr.files })),
  http.post(`${GITHUB}/pulls/:number/reviews`, async ({ request }) => {
    const id = 9000 + github.reviews.length;
    github.reviews.push({ id, body: (await request.json()) as Record<string, unknown> });
    return HttpResponse.json({ id });
  }),
  http.post(`${GITHUB}/issues/:number/comments`, async ({ params, request }) => {
    const id = 7000 + github.comments.size;
    const { body } = (await request.json()) as { body: string };
    github.comments.set(id, { issue: Number(params.number), body });
    github.commentRequests.push({ kind: "create", id });
    return HttpResponse.json({ id }, { status: 201 });
  }),
  http.patch(`${GITHUB}/issues/comments/:id`, async ({ params, request }) => {
    const id = Number(params.id);
    const comment = github.comments.get(id);
    if (!comment) return HttpResponse.json({ message: "Not Found" }, { status: 404 });
    comment.body = ((await request.json()) as { body: string }).body;
    github.commentRequests.push({ kind: "edit", id });
    return HttpResponse.json({ id });
  }),
  http.get(`${GITHUB}/pulls/:number/reviews/:id/comments`, ({ params }) => {
    const posted = github.reviews.find((r) => r.id === Number(params.id))!;
    const comments = posted.body.comments as { path: string; line: number; side: string }[];
    return HttpResponse.json(
      comments.map((c, i) => ({
        id: posted.id * 10 + i,
        path: c.path,
        line: c.line,
        side: c.side,
      })),
    );
  }),
);

let ipCounter = 0;
function agentRequest(path: string, accessToken: string, body?: unknown): Request {
  ipCounter += 1;
  return new Request(`http://localhost/api/harness/${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "x-real-ip": `192.0.2.${ipCounter % 250}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe.skipIf(!dockerAvailable)("review capability end to end", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let orgId: string;
  let repositoryId: string;
  let repo: Repo;
  let base: string;
  let head1: string;
  let head2: string;
  let prCounter = 0;
  const postReview = vi.spyOn(GitHubAdapter.prototype, "postReview");

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    await seedReviewProfiles(db, org!.id);
    orgId = org!.id;
    state.db = db;
    server.listen({ onUnhandledFrame: "error" });

    const connection = (await upsertScmConnection(db, {
      organizationId: orgId,
      provider: "github",
      name: "acme",
      baseUrl: "https://api.github.com",
      externalId: "4242",
      credentials: {},
    }))!;
    repositoryId = (
      await connectRepository(db, {
        connectionId: connection.id,
        provider: "github",
        externalId: "100",
        fullPath: "acme/app",
      })
    ).id;
    await db.insert(rules).values({ repositoryId, kind: "custom", text: "No logging of secrets." });

    repo = new Repo();
    repo.git("init", "-q", "--initial-branch=main");
    base = repo.commit({ "src/app.ts": "export function login() {\n  return 1;\n}\n" });
    head1 = repo.commit({
      "src/app.ts": "export function login() {\n  console.log(token);\n  return 1;\n}\n",
    });
    head2 = repo.commit({ "src/other.ts": "export const other = token;\n" });
  }, 180_000);

  afterAll(async () => {
    server.close();
    if (db) await closeDb(db);
    await container?.stop();
    rmSync(repo.dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    github.reviews.length = 0;
    github.comments.clear();
    github.commentRequests.length = 0;
    postReview.mockClear();
    await setReviewTasks(["builtin:review-pr"]);
  });

  async function setReviewTasks(reviewTaskIds: string[]) {
    await db.update(repositories).set({ reviewTaskIds }).where(eq(repositories.id, repositoryId));
  }

  function dispatcher() {
    return new PostgresDispatcher({ db });
  }

  async function newAgent() {
    const [agent] = await db
      .insert(harnesses)
      .values({
        organizationId: orgId,
        name: "coder-1",
        reportedVersion: REVIEW_TASKS_MIN_HARNESS_VERSION,
      })
      .returning();
    return { harnessId: agent!.id, accessToken: await getTokenSigner().signAccessToken(agent!.id) };
  }

  function enqueue(
    prNumber: number,
    headSha: string,
    trigger: "webhook" | "mention" | "manual" = "webhook",
  ) {
    github.pr = {
      baseSha: base,
      headSha,
      files: [
        { filename: "src/app.ts", patch: repo.patch(base, headSha, "src/app.ts") },
        ...(headSha === head2
          ? [{ filename: "src/other.ts", patch: repo.patch(base, headSha, "src/other.ts") }]
          : []),
      ],
    };
    return enqueueReview(db, dispatcher(), {
      repositoryId,
      prNumber,
      baseSha: base,
      headSha,
      title: "Add login logging",
      description: "Please review",
      author: "octocat",
      trigger,
    });
  }

  /**
   * Claims `jobId` through `POST /api/harness/claim`: makes it claimable now (as
   * once a retry delay passed) and holds the other queued jobs back meanwhile,
   * so no other job is claimed instead. Null when the claim settled or skipped
   * the job.
   */
  async function startAs(jobId: string, accessToken: string): Promise<JobStartResponse | null> {
    await db
      .update(jobs)
      .set({ availableAt: new Date(Date.now() - 1000) })
      .where(eq(jobs.id, jobId));
    const held = (
      await db
        .update(jobs)
        .set({ availableAt: sql`${jobs.availableAt} + interval '1 day'` })
        .where(
          and(eq(jobs.status, "queued"), ne(jobs.id, jobId), lte(jobs.availableAt, sql`now()`)),
        )
        .returning({ id: jobs.id })
    ).map((j) => j.id);
    try {
      const res = await claim(
        agentRequest("claim", accessToken, { pools: ["short"], waitSeconds: 0 }),
      );
      if (res.status === 204) return null;
      expect(res.status).toBe(200);
      const body = (await res.json()) as JobStartResponse & { action: "run" };
      expect(body.job.id).toBe(jobId);
      return body;
    } finally {
      if (held.length > 0) {
        await db
          .update(jobs)
          .set({ availableAt: sql`${jobs.availableAt} - interval '1 day'` })
          .where(inArray(jobs.id, held));
      }
    }
  }

  async function submit(jobId: string, accessToken: string, body: ReviewJobResult) {
    const res = await result(
      agentRequest(`jobs/${jobId}/result`, accessToken, { result: body }),
      ctx(jobId),
    );
    return { status: res.status, body: (await res.json()) as JobOutcomeResponse };
  }

  /** What the harness's review task type does in the worktree, with the provider mocked. */
  async function agentRun(payload: unknown): Promise<ReviewJobResult> {
    const job = reviewTriggerContext(payload);
    const review = await runReview(
      {
        cwd: repo.dir,
        baseSha: job.baseSha,
        headSha: job.headSha,
        reviewConfig: job.reviewConfig,
        changeRequest: job.changeRequest,
        previousReview: job.previousReview ?? undefined,
      },
      { provider, logger: { info: () => {}, warn: () => {} } },
    );
    expect(review.stopReason).toBe("completed");
    return {
      findings: review.findings,
      usage: review.usage,
      skipped: review.skipped,
      stopReason: "completed",
      scope: review.scope,
      discarded: review.discarded,
      durationMs: 1234,
    };
  }

  async function reviewRow(id: string) {
    const [row] = await db.select().from(reviews).where(eq(reviews.id, id));
    return row!;
  }

  async function jobRow(id: string) {
    const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
    return row!;
  }

  async function reviewRunRow(id: string) {
    const [row] = await db.select().from(reviewRuns).where(eq(reviewRuns.id, id));
    return row!;
  }

  async function failFinal(jobId: string, accessToken: string) {
    const res = await fail(
      agentRequest(`jobs/${jobId}/fail`, accessToken, { retryable: false, error: "boom" }),
      ctx(jobId),
    );
    expect(await res.json()).toEqual({ status: "failed" });
  }

  /** Starts, runs and completes a review job. */
  async function complete(jobId: string, accessToken: string) {
    const run = await startAs(jobId, accessToken);
    if (run?.action !== "run") throw new Error("expected run");
    expect((await submit(jobId, accessToken, await agentRun(run.job.payload))).body).toEqual({
      status: "completed",
    });
  }

  it("goes from a created job to persisted findings and exactly one postReview, also on replay", async () => {
    const prNumber = ++prCounter;
    const enqueued = await enqueue(prNumber, head1);
    if (enqueued.status !== "enqueued") throw new Error(enqueued.status);
    const { jobId, reviewId } = enqueued;

    // The job runs builtin:review-pr and carries the resolved config and no credentials.
    const job = await jobRow(jobId);
    expect(job).toMatchObject({
      organizationId: orgId,
      status: "queued",
      targetHarnessId: null,
      type: "review.run",
      taskType: "review",
      pool: "short",
      taskId: "builtin:review-pr",
      repositoryId,
      minHarnessVersion: REVIEW_TASKS_MIN_HARNESS_VERSION,
    });
    expect(job.payload).toMatchObject({
      trigger: { kind: "pr.updated" },
      repositoryId,
      ref: head1,
    });
    const payload = reviewTriggerContext(job.payload);
    expect(payload).toMatchObject({
      reviewId,
      repositoryId,
      repository: "acme/app",
      prNumber,
      pr: { number: prNumber, title: "Add login logging", body: "Please review" },
      baseSha: base,
      headSha: head1,
      reviewConfig: {
        profile: { id: "standard" },
        customInstructions: null,
        rules: [{ kind: "custom", text: "No logging of secrets.", enabled: true }],
        pathExcludes: [],
      },
      previousReview: null,
    });
    expect(JSON.stringify(job.payload)).not.toMatch(/token"|password|secret"|ghs_|glpat/i);
    expect(await reviewRow(reviewId)).toMatchObject({
      status: "queued",
      prTitle: "Add login logging",
    });

    // Harness start → run.
    const { harnessId, accessToken } = await newAgent();
    const started = await startAs(jobId, accessToken);
    expect(started).toMatchObject({
      action: "run",
      job: { id: jobId, payload: job.payload },
      runSpec: {
        taskType: "review",
        task: { id: "builtin:review-pr", sink: "review" },
        agent: { id: "builtin:reviewer" },
        trigger: job.payload.trigger,
        repository: { provider: "github", fullPath: "acme/app" },
        // Narrowed by the review profile at claim time.
        model: payload.reviewConfig.profile.model,
        tokenBudget: payload.reviewConfig.profile.maxTokensPerReview,
        maxFiles: payload.reviewConfig.profile.maxFiles,
      },
    });
    expect(await reviewRow(reviewId)).toMatchObject({ status: "running", harnessId });

    // Harness runs the review and reports the result.
    const output = await agentRun(job.payload);
    expect(await submit(jobId, accessToken, output)).toEqual({
      status: 200,
      body: { status: "completed" },
    });

    const review = await reviewRow(reviewId);
    expect(review).toMatchObject({
      status: "completed",
      tokensIn: 1200,
      tokensOut: 300,
      durationMs: 1234,
      // The review run is posted, not its task runs.
      summaryCommentId: null,
    });
    expect(await reviewRunRow(enqueued.reviewRunId)).toMatchObject({
      status: "completed",
      summaryCommentId: "9000",
    });
    const rows = await db
      .select()
      .from(findings)
      .where(eq(findings.reviewId, reviewId))
      .orderBy(asc(findings.createdAt));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      path: "src/app.ts",
      startLine: 2,
      endLine: 2,
      severity: "high",
      body: PHISHING_BODY,
      scmCommentId: "90000",
    });

    expect(postReview).toHaveBeenCalledTimes(1);
    expect(github.reviews).toHaveLength(1);
    const posted = github.reviews[0]!.body as {
      commit_id: string;
      body: string;
      comments: { path: string; line: number; side: string; body: string }[];
    };
    expect(posted.commit_id).toBe(head1);
    expect(posted.body).toContain("**Profile:** Standard");
    expect(posted.body).toContain("**Tokens:** 1,500 /");
    expect(posted.body).toContain(`https://omniralph.example.com/reviews/${reviewId}`);
    expect(posted.comments).toHaveLength(1);
    const comment = posted.comments[0]!;
    expect(comment).toMatchObject({ path: "src/app.ts", line: 2, side: "RIGHT" });
    // Sanitized: no HTML/images, foreign links as code, foreign mentions neutralized.
    expect(comment.body).toContain("**[high] Token logged**");
    // The footer names the task that reported it.
    expect(comment.body).toContain("_security · confidence 90% · Review a pull request_");
    expect(comment.body).not.toContain("<img");
    expect(comment.body).toContain("GitHub (`https://github-login.evil.example/session`)");
    expect(comment.body).toContain("`@acme/security`");
    expect(comment.body).toContain("Author: @octocat");
    expect(comment.body).toContain("```suggestion\nlogger.info({ user }, `login`);\n```");

    // A duplicate result replay neither posts again nor duplicates findings.
    expect(await submit(jobId, accessToken, output)).toEqual({
      status: 200,
      body: { status: "completed" },
    });
    // ... nor do concurrent replays.
    await Promise.all([submit(jobId, accessToken, output), submit(jobId, accessToken, output)]);
    expect(postReview).toHaveBeenCalledTimes(1);
    expect(github.reviews).toHaveLength(1);
    expect(await db.select().from(findings).where(eq(findings.reviewId, reviewId))).toHaveLength(1);

    // Another harness replaying it is rejected.
    const other = await newAgent();
    expect((await submit(jobId, other.accessToken, output)).status).toBe(409);
    expect(postReview).toHaveBeenCalledTimes(1);

    // The next push is reviewed incrementally, deduped against the open finding.
    const next = await enqueue(prNumber, head2);
    if (next.status !== "enqueued") throw new Error(next.status);
    const nextPayload = reviewTriggerContext((await jobRow(next.jobId)).payload);
    expect(nextPayload.previousReview).toEqual({
      headSha: head1,
      openFindings: [
        expect.objectContaining({
          path: "src/app.ts",
          startLine: 2,
          endLine: 2,
          category: "security",
        }),
      ],
    });
    await startAs(next.jobId, accessToken);
    const nextOutput = await agentRun((await jobRow(next.jobId)).payload);
    expect(nextOutput.scope).toEqual({ mode: "incremental", fromSha: head1, headSha: head2 });
    expect(nextOutput.findings.map((f) => f.path)).toEqual(["src/other.ts"]);
    expect((await submit(next.jobId, accessToken, nextOutput)).body).toEqual({
      status: "completed",
    });
    expect(postReview).toHaveBeenCalledTimes(2);
  });

  it("rejects a malformed review result without completing the job", async () => {
    const enqueued = await enqueue(++prCounter, head1);
    if (enqueued.status !== "enqueued") throw new Error(enqueued.status);
    const { accessToken } = await newAgent();
    await startAs(enqueued.jobId, accessToken);
    const res = await result(
      agentRequest(`jobs/${enqueued.jobId}/result`, accessToken, { result: { findings: "x" } }),
      ctx(enqueued.jobId),
    );
    expect(res.status).toBe(400);
    expect((await jobRow(enqueued.jobId)).status).toBe("running");
    expect(postReview).not.toHaveBeenCalled();
  });

  it("deduplicates an enqueue of the same head while its job is active", async () => {
    const prNumber = ++prCounter;
    const first = await enqueue(prNumber, head1);
    const second = await enqueue(prNumber, head1);
    if (first.status !== "enqueued" || second.status !== "duplicate") throw new Error("status");
    expect(second).toMatchObject({ jobId: first.jobId, reviewId: first.reviewId });
    const prReviews = await db.select().from(reviews).where(eq(reviews.prNumber, prNumber));
    expect(prReviews).toHaveLength(1);
  });

  it("skips a job whose head SHA already has a completed review", async () => {
    const prNumber = ++prCounter;
    const { accessToken } = await newAgent();
    const first = await enqueue(prNumber, head1);
    if (first.status !== "enqueued") throw new Error(first.status);
    const run = await startAs(first.jobId, accessToken);
    if (run?.action !== "run") throw new Error("expected run");
    await submit(first.jobId, accessToken, await agentRun(run.job.payload));
    expect(postReview).toHaveBeenCalledTimes(1);

    // E.g. a redelivered webhook for the same head after the review completed.
    const again = await enqueue(prNumber, head1);
    if (again.status !== "enqueued") throw new Error(again.status);
    expect(await startAs(again.jobId, accessToken)).toBeNull();
    expect(await jobRow(again.jobId)).toMatchObject({ status: "skipped" });
    expect(await reviewRow(again.reviewId)).toMatchObject({ status: "skipped" });
    expect(postReview).toHaveBeenCalledTimes(1);
  });

  it("never uses a budget_exhausted review as the incremental base, but dedupes against its findings", async () => {
    const prNumber = ++prCounter;
    const { accessToken } = await newAgent();
    const first = await enqueue(prNumber, head1);
    if (first.status !== "enqueued") throw new Error(first.status);
    const run = await startAs(first.jobId, accessToken);
    if (run?.action !== "run") throw new Error("expected run");
    const partial = {
      ...(await agentRun(run.job.payload)),
      stopReason: "budget_exhausted" as const,
    };
    await submit(first.jobId, accessToken, partial);
    expect(await reviewRow(first.reviewId)).toMatchObject({ status: "budget_exhausted" });

    // Files the partial review never reached must still be reviewed: full diff, deduped.
    const next = await enqueue(prNumber, head2);
    if (next.status !== "enqueued") throw new Error(next.status);
    const payload = reviewTriggerContext((await jobRow(next.jobId)).payload);
    expect(payload.previousReview).toEqual({
      headSha: null,
      openFindings: [
        expect.objectContaining({
          path: "src/app.ts",
          startLine: 2,
          endLine: 2,
          category: "security",
        }),
      ],
    });
    await startAs(next.jobId, accessToken);
    const output = await agentRun((await jobRow(next.jobId)).payload);
    expect(output.scope).toEqual({ mode: "full", baseSha: base, headSha: head2 });
    // The fake provider re-reports src/app.ts (first file of the full diff): suppressed.
    expect(output.findings).toEqual([]);
    expect(output.discarded.duplicate).toBe(1);
  });

  it("cancels queued and running jobs for older head SHAs of the same PR on a newer push", async () => {
    const prNumber = ++prCounter;
    const { accessToken } = await newAgent();
    const running = await enqueue(prNumber, base);
    if (running.status !== "enqueued") throw new Error(running.status);
    const run = await startAs(running.jobId, accessToken);
    if (run?.action !== "run") throw new Error("expected run");
    const queued = await enqueue(prNumber, head1);
    if (queued.status !== "enqueued") throw new Error(queued.status);
    // A different PR's job is left alone.
    const otherPr = await enqueue(++prCounter, head1);
    if (otherPr.status !== "enqueued") throw new Error(otherPr.status);

    const newest = await enqueue(prNumber, head2);
    if (newest.status !== "enqueued") throw new Error(newest.status);
    expect(newest.canceledJobIds.sort()).toEqual([running.jobId, queued.jobId].sort());
    expect(await jobRow(running.jobId)).toMatchObject({ status: "running", cancelRequested: true });
    expect(await jobRow(queued.jobId)).toMatchObject({ status: "canceled" });
    expect(await jobRow(otherPr.jobId)).toMatchObject({ status: "queued" });
    expect(await jobRow(newest.jobId)).toMatchObject({ status: "queued" });
    expect((await reviewRow(running.reviewId)).status).toBe("skipped");
    expect((await reviewRow(queued.reviewId)).status).toBe("skipped");

    // The canceled queued job is never claimed; the running one's late result isn't posted.
    expect(await startAs(queued.jobId, accessToken)).toBeNull();
    const late = await submit(running.jobId, accessToken, {
      findings: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      skipped: [],
      stopReason: "completed",
      scope: { mode: "full", baseSha: base, headSha: base },
      discarded: { invalid: 0, outsideDiff: 0, duplicate: 0 },
      durationMs: 1,
    });
    expect(late.body).toEqual({ status: "canceled" });
    expect(postReview).not.toHaveBeenCalled();
    expect((await reviewRow(running.reviewId)).status).toBe("skipped");
  });

  it("posts a short failure note once and fails the review on a final failure", async () => {
    const enqueued = await enqueue(++prCounter, head1);
    if (enqueued.status !== "enqueued") throw new Error(enqueued.status);
    const { accessToken } = await newAgent();
    await startAs(enqueued.jobId, accessToken);

    // A retryable failure (rate limit) is redelivered later: no note, review queued again.
    const retry = await fail(
      agentRequest(`jobs/${enqueued.jobId}/fail`, accessToken, {
        retryable: true,
        retryAfterSeconds: 120,
        error: "Claude rate limit",
      }),
      ctx(enqueued.jobId),
    );
    expect(await retry.json()).toEqual({ status: "retry", retryAfterSeconds: 120 });
    expect(await reviewRow(enqueued.reviewId)).toMatchObject({
      status: "queued",
      error: "Claude rate limit",
    });
    expect(postReview).not.toHaveBeenCalled();

    await startAs(enqueued.jobId, accessToken);
    const error = "Claude Code is not logged in <img src=x> cc @acme/oncall";
    const res = await fail(
      agentRequest(`jobs/${enqueued.jobId}/fail`, accessToken, { retryable: false, error }),
      ctx(enqueued.jobId),
    );
    expect(await res.json()).toEqual({ status: "failed" });
    const review = await reviewRow(enqueued.reviewId);
    expect(review).toMatchObject({ status: "failed", error });
    expect(await reviewRunRow(enqueued.reviewRunId)).toMatchObject({
      status: "failed",
      summaryCommentId: "9000",
    });
    expect(postReview).toHaveBeenCalledTimes(1);
    const note = github.reviews[0]!.body as { body: string; comments: unknown[] };
    expect(note.comments).toEqual([]);
    expect(note.body).toContain(`The review of \`${head1.slice(0, 12)}\` failed`);
    expect(note.body).toContain("`@acme/oncall`");
    expect(note.body).not.toContain("<img");

    // A replayed failure doesn't post again.
    const replay = await fail(
      agentRequest(`jobs/${enqueued.jobId}/fail`, accessToken, { retryable: false, error }),
      ctx(enqueued.jobId),
    );
    expect(replay.status).toBe(409);
    expect(postReview).toHaveBeenCalledTimes(1);
  });

  it("fails the review with a note when the job runs out of deliveries", async () => {
    const enqueued = await enqueue(++prCounter, head1);
    if (enqueued.status !== "enqueued") throw new Error(enqueued.status);
    await db.update(jobs).set({ deliveryCount: 3 }).where(eq(jobs.id, enqueued.jobId));
    const { accessToken } = await newAgent();
    expect(await startAs(enqueued.jobId, accessToken)).toBeNull();
    expect(await reviewRow(enqueued.reviewId)).toMatchObject({
      status: "failed",
      error: "Gave up after 3 deliveries",
    });
    expect(postReview).toHaveBeenCalledTimes(1);
  });

  describe("review runs", () => {
    it("fans one PR event out to every enabled review task with the same previous review", async () => {
      const prNumber = ++prCounter;
      const { accessToken } = await newAgent();
      const first = await enqueue(prNumber, head1);
      if (first.status !== "enqueued") throw new Error(first.status);
      expect(first.runs.map((r) => r.taskId)).toEqual(["builtin:review-pr"]);
      await complete(first.jobId, accessToken);
      expect(await reviewRunRow(first.reviewRunId)).toMatchObject({ status: "completed" });

      // Unknown and non-review tasks are skipped with a warning.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await setReviewTasks([
        "builtin:review-pr",
        "builtin:missing",
        SECURITY_TASK_ID,
        "builtin:ask-about-code",
      ]);
      const next = await enqueue(prNumber, head2);
      if (next.status !== "enqueued") throw new Error(next.status);
      expect(warn).toHaveBeenCalledTimes(2);
      warn.mockRestore();

      expect(next.runs.map((r) => r.taskId)).toEqual(["builtin:review-pr", SECURITY_TASK_ID]);
      expect(await reviewRunRow(next.reviewRunId)).toMatchObject({
        organizationId: orgId,
        repositoryId,
        prNumber,
        headSha: head2,
        baseSha: base,
        trigger: "webhook",
        mode: "incremental",
        profileId: "standard",
        status: "queued",
        correlationJobId: null,
      });
      const runReviews = await listReviewRunReviews(db, next.reviewRunId);
      expect(runReviews.map((r) => [r.id, r.taskId, r.status])).toEqual(
        next.runs.map((r) => [r.reviewId, r.taskId, "queued"]),
      );
      const payloads = [];
      for (const run of next.runs) {
        const job = await jobRow(run.jobId);
        expect(job).toMatchObject({
          taskId: run.taskId,
          status: "queued",
          dedupeKey: `review.run:${repositoryId}:${prNumber}:${head2}:${run.taskId}`,
        });
        const payload = reviewTriggerContext(job.payload);
        expect(payload.reviewId).toBe(run.reviewId);
        payloads.push(payload);
      }
      // previousReviewState is read once: both tasks get the same previous head and findings.
      expect(payloads[0]!.previousReview).toEqual({
        headSha: head1,
        openFindings: [expect.objectContaining({ path: "src/app.ts", startLine: 2 })],
      });
      expect(payloads[1]!.previousReview).toEqual(payloads[0]!.previousReview);

      // The run is running once a task job starts, and completed once both ended.
      const [reviewPr, security] = next.runs;
      await complete(security!.jobId, accessToken);
      expect(await reviewRunRow(next.reviewRunId)).toMatchObject({ status: "running" });
      expect(await reviewRow(security!.reviewId)).toMatchObject({ status: "completed" });
      // A task run's completion doesn't post on its own.
      expect(postReview).toHaveBeenCalledTimes(1);
      await startAs(reviewPr!.jobId, accessToken);
      await failFinal(reviewPr!.jobId, accessToken);
      expect(await reviewRunRow(next.reviewRunId)).toMatchObject({ status: "completed" });
      // One review for the run, with the failed task named and the other's finding.
      expect(postReview).toHaveBeenCalledTimes(2);
      const posted = github.reviews.at(-1)!.body as {
        body: string;
        comments: { path: string; body: string }[];
      };
      expect(posted.body).toContain(
        "This review task failed, so its findings are missing: Review a pull request.",
      );
      expect(posted.comments.map((c) => c.path)).toEqual(["src/other.ts"]);
      expect(posted.comments[0]!.body).toContain("· Security review_");
    });

    it("returns the active review run for the same head and creates nothing", async () => {
      const prNumber = ++prCounter;
      await setReviewTasks(["builtin:review-pr", SECURITY_TASK_ID]);
      const first = await enqueue(prNumber, head1);
      if (first.status !== "enqueued") throw new Error(first.status);
      const { accessToken } = await newAgent();
      // One task already finished: the other's job keeps the run active.
      await complete(first.runs[0]!.jobId, accessToken);

      const second = await enqueue(prNumber, head1, "mention");
      if (second.status !== "duplicate") throw new Error(second.status);
      expect(second).toMatchObject({
        reviewRunId: first.reviewRunId,
        runs: [first.runs[1]],
        canceledJobIds: [],
      });
      const prRuns = await db.select().from(reviewRuns).where(eq(reviewRuns.prNumber, prNumber));
      expect(prRuns).toHaveLength(1);
      const prReviews = await db.select().from(reviews).where(eq(reviews.prNumber, prNumber));
      expect(prReviews).toHaveLength(2);
    });

    it("returns no_review_tasks when no enabled task is a review task", async () => {
      const prNumber = ++prCounter;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await setReviewTasks(["builtin:missing", "builtin:ask-about-code"]);
      expect(await enqueue(prNumber, head1)).toEqual({ status: "no_review_tasks" });
      warn.mockRestore();
      expect(
        await db.select().from(reviewRuns).where(eq(reviewRuns.prNumber, prNumber)),
      ).toHaveLength(0);
      expect(await db.select().from(reviews).where(eq(reviews.prNumber, prNumber))).toHaveLength(0);
    });

    it("cancels every task's job of older heads and skips their review runs", async () => {
      const prNumber = ++prCounter;
      await setReviewTasks(["builtin:review-pr", SECURITY_TASK_ID]);
      const { accessToken } = await newAgent();
      const older = await enqueue(prNumber, head1);
      if (older.status !== "enqueued") throw new Error(older.status);
      await startAs(older.runs[1]!.jobId, accessToken);

      const newer = await enqueue(prNumber, head2);
      if (newer.status !== "enqueued") throw new Error(newer.status);
      expect(newer.canceledJobIds.sort()).toEqual(older.runs.map((r) => r.jobId).sort());
      expect(await jobRow(older.runs[0]!.jobId)).toMatchObject({ status: "canceled" });
      expect(await jobRow(older.runs[1]!.jobId)).toMatchObject({ cancelRequested: true });
      for (const run of older.runs) {
        expect(await reviewRow(run.reviewId)).toMatchObject({
          status: "skipped",
          error: `Superseded by a newer push (${head2.slice(0, 12)})`,
        });
      }
      expect(await reviewRunRow(older.reviewRunId)).toMatchObject({ status: "skipped" });
      expect(await reviewRunRow(newer.reviewRunId)).toMatchObject({ status: "queued" });
      expect(newer.runs).toHaveLength(2);
    });

    it("skips a webhook review of a task that already reviewed the head, but never a mention", async () => {
      const prNumber = ++prCounter;
      await setReviewTasks(["builtin:review-pr", SECURITY_TASK_ID]);
      const { accessToken } = await newAgent();
      const first = await enqueue(prNumber, head1);
      if (first.status !== "enqueued") throw new Error(first.status);
      await complete(first.runs[0]!.jobId, accessToken);
      await startAs(first.runs[1]!.jobId, accessToken);
      await failFinal(first.runs[1]!.jobId, accessToken);

      // A redelivered webhook: builtin:review-pr already reviewed the head, the security task didn't.
      const again = await enqueue(prNumber, head1);
      if (again.status !== "enqueued") throw new Error(again.status);
      expect(await startAs(again.runs[0]!.jobId, accessToken)).toBeNull();
      expect(await jobRow(again.runs[0]!.jobId)).toMatchObject({ status: "skipped" });
      expect(await reviewRow(again.runs[0]!.reviewId)).toMatchObject({ status: "skipped" });
      expect(await startAs(again.runs[1]!.jobId, accessToken)).not.toBeNull();
      expect(await reviewRunRow(again.reviewRunId)).toMatchObject({ status: "running" });
      await failFinal(again.runs[1]!.jobId, accessToken);
      expect(await reviewRunRow(again.reviewRunId)).toMatchObject({ status: "failed" });

      // An explicit @bot review reviews it again with every task.
      const mention = await enqueue(prNumber, head1, "mention");
      if (mention.status !== "enqueued") throw new Error(mention.status);
      for (const run of mention.runs) {
        expect(await startAs(run.jobId, accessToken)).not.toBeNull();
      }
    });

    it("fails the review run when every task run failed or was canceled", async () => {
      const prNumber = ++prCounter;
      await setReviewTasks(["builtin:review-pr", SECURITY_TASK_ID]);
      const { accessToken } = await newAgent();
      const enqueued = await enqueue(prNumber, head1);
      if (enqueued.status !== "enqueued") throw new Error(enqueued.status);
      await startAs(enqueued.runs[0]!.jobId, accessToken);
      await failFinal(enqueued.runs[0]!.jobId, accessToken);
      expect(await reviewRunRow(enqueued.reviewRunId)).toMatchObject({ status: "running" });
      await dispatcher().cancel(enqueued.runs[1]!.jobId);
      const { onReviewJobCanceled } = await import("@/lib/review/jobs");
      await onReviewJobCanceled(db, await jobRow(enqueued.runs[1]!.jobId));
      expect(await reviewRunRow(enqueued.reviewRunId)).toMatchObject({ status: "failed" });
      // One failure note for the run.
      expect(postReview).toHaveBeenCalledTimes(1);
      const note = github.reviews[0]!.body as { body: string; comments: unknown[] };
      expect(note.comments).toEqual([]);
      expect(note.body).toContain(
        `The review of \`${head1.slice(0, 12)}\` failed: Review a pull request: boom; Security review: Canceled`,
      );
    });

    it("posts one failure note when every task run failed, also on replay", async () => {
      const prNumber = ++prCounter;
      await setReviewTasks(["builtin:review-pr", SECURITY_TASK_ID]);
      const { accessToken } = await newAgent();
      const enqueued = await enqueue(prNumber, head1);
      if (enqueued.status !== "enqueued") throw new Error(enqueued.status);
      for (const run of enqueued.runs) {
        await startAs(run.jobId, accessToken);
        await failFinal(run.jobId, accessToken);
      }
      expect(await reviewRunRow(enqueued.reviewRunId)).toMatchObject({
        status: "failed",
        summaryCommentId: "9000",
      });
      const { onReviewJobFailed } = await import("@/lib/review/jobs");
      await onReviewJobFailed(db, await jobRow(enqueued.runs[0]!.jobId), "boom");
      expect(postReview).toHaveBeenCalledTimes(1);
      const note = github.reviews[0]!.body as { body: string };
      expect(note.body).toContain("Review a pull request: boom; Security review: boom");
    });
  });
  describe("sticky comments", () => {
    const SUMMARY_TASK_ID = "builtin:summarize-pr";

    /** Starts and completes a task's job with the review output plus `summary` (findings included). */
    async function completeWith(jobId: string, accessToken: string, summary: string) {
      const started = await startAs(jobId, accessToken);
      if (started?.action !== "run") throw new Error("expected run");
      const output = { ...(await agentRun(started.job.payload)), summary };
      expect((await submit(jobId, accessToken, output)).body).toEqual({ status: "completed" });
      return output;
    }

    async function stickyRows(prNumber: number) {
      return db
        .select()
        .from(stickyComments)
        .where(
          and(eq(stickyComments.repositoryId, repositoryId), eq(stickyComments.prNumber, prNumber)),
        );
    }

    function postsTo(prNumber: number): number {
      return postReview.mock.calls.filter((call) => call[1] === prNumber).length;
    }

    it("posts one review per head and keeps one summary comment, edited in place on the next push", async () => {
      const prNumber = ++prCounter;
      await setReviewTasks(["builtin:review-pr", SUMMARY_TASK_ID]);
      const { accessToken } = await newAgent();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      // First push: the summary task finishes first; the review still waits for builtin:review-pr.
      const first = await enqueue(prNumber, head1);
      if (first.status !== "enqueued") throw new Error(first.status);
      expect(first.runs.map((r) => r.taskId)).toEqual(["builtin:review-pr", SUMMARY_TASK_ID]);
      const [review1, summary1] = first.runs;
      expect(await reviewRow(summary1!.reviewId)).toMatchObject({ summaryOnly: true });
      expect(await reviewRow(review1!.reviewId)).toMatchObject({ summaryOnly: false });
      await completeWith(summary1!.jobId, accessToken, "Adds **login** logging. <img src=x>");
      // Its findings are dropped (and logged); its summary is on the PR in one comment.
      expect(warn).toHaveBeenCalledWith(
        "dropping the findings of a summary-only review task",
        expect.objectContaining({ reviewId: summary1!.reviewId, findings: 1 }),
      );
      expect(
        await db.select().from(findings).where(eq(findings.reviewId, summary1!.reviewId)),
      ).toHaveLength(0);
      expect(await reviewRow(summary1!.reviewId)).toMatchObject({ status: "completed" });
      expect(github.commentRequests).toEqual([{ kind: "create", id: 7000 }]);
      const comment = github.comments.get(7000)!;
      expect(comment.issue).toBe(prNumber);
      expect(comment.body).toMatch(/^## Summarize a pull request\n\nAdds \*\*login\*\* logging\./);
      expect(comment.body).not.toContain("<img");
      expect(comment.body).toContain(`Updated for \`${head1.slice(0, 12)}\``);
      expect(await stickyRows(prNumber)).toEqual([
        expect.objectContaining({ taskId: SUMMARY_TASK_ID, commentId: "7000" }),
      ]);
      expect(await reviewRunRow(first.reviewRunId)).toMatchObject({ status: "running" });
      expect(postsTo(prNumber)).toBe(0);

      await complete(review1!.jobId, accessToken);
      // One review, without correlation, of builtin:review-pr's findings only.
      expect(await reviewRunRow(first.reviewRunId)).toMatchObject({
        status: "completed",
        correlationJobId: null,
      });
      expect(postsTo(prNumber)).toBe(1);
      const posted1 = github.reviews.at(-1)!.body as { body: string; comments: { body: string }[] };
      expect(posted1.comments).toHaveLength(1);
      expect(posted1.comments[0]!.body).toContain("· Review a pull request_");
      expect(posted1.body).not.toContain("Summarize a pull request");
      expect(posted1.body).not.toContain("CAUTION");

      // Second push: builtin:review-pr finishes first and posts without waiting for the summary.
      const second = await enqueue(prNumber, head2);
      if (second.status !== "enqueued") throw new Error(second.status);
      const [review2, summary2] = second.runs;
      await complete(review2!.jobId, accessToken);
      expect(await reviewRunRow(second.reviewRunId)).toMatchObject({ status: "completed" });
      expect(postsTo(prNumber)).toBe(2);
      const summaryOutput = await completeWith(summary2!.jobId, accessToken, "Adds another file.");
      expect(postsTo(prNumber)).toBe(2);
      // The same comment is edited in place.
      expect(github.commentRequests).toEqual([
        { kind: "create", id: 7000 },
        { kind: "edit", id: 7000 },
      ]);
      expect(github.comments.size).toBe(1);
      expect(github.comments.get(7000)!.body).toContain("Adds another file.");
      expect(github.comments.get(7000)!.body).toContain(`Updated for \`${head2.slice(0, 12)}\``);

      // A replayed result edits the same comment again and creates none.
      expect((await submit(summary2!.jobId, accessToken, summaryOutput)).body).toEqual({
        status: "completed",
      });
      expect(github.commentRequests.filter((r) => r.kind === "create")).toHaveLength(1);
      expect(await stickyRows(prNumber)).toHaveLength(1);
      expect(postsTo(prNumber)).toBe(2);
      warn.mockRestore();
    });

    it("posts a new comment when the stored one was deleted", async () => {
      const prNumber = ++prCounter;
      await setReviewTasks([SUMMARY_TASK_ID]);
      const { accessToken } = await newAgent();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const first = await enqueue(prNumber, head1);
      if (first.status !== "enqueued") throw new Error(first.status);
      await completeWith(first.jobId, accessToken, "First.");
      github.comments.clear();

      const second = await enqueue(prNumber, head2);
      if (second.status !== "enqueued") throw new Error(second.status);
      await completeWith(second.jobId, accessToken, "Second.");
      warn.mockRestore();
      expect(github.commentRequests.map((r) => r.kind)).toEqual(["create", "create"]);
      const [row] = await stickyRows(prNumber);
      expect(row!.commentId).toBe(String(github.commentRequests[1]!.id));
    });

    it("posts no review for a review run of only summary-only tasks", async () => {
      const prNumber = ++prCounter;
      await setReviewTasks([SUMMARY_TASK_ID]);
      const { accessToken } = await newAgent();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const enqueued = await enqueue(prNumber, head1);
      if (enqueued.status !== "enqueued") throw new Error(enqueued.status);
      await completeWith(enqueued.jobId, accessToken, "Adds login logging.");
      warn.mockRestore();
      expect(await reviewRunRow(enqueued.reviewRunId)).toMatchObject({
        status: "completed",
        correlationJobId: null,
        summaryCommentId: null,
      });
      expect(postsTo(prNumber)).toBe(0);
      expect(github.commentRequests).toHaveLength(1);
    });
  });
  describe("correlation", () => {
    const queryResult = (structured: unknown) => ({
      outcome: "answered",
      answer: null,
      structured,
      references: [],
      usage: { inputTokens: 100, outputTokens: 50 },
      durationMs: 10,
    });

    async function submitQuery(jobId: string, accessToken: string, body: unknown) {
      const res = await result(
        agentRequest(`jobs/${jobId}/result`, accessToken, { result: body }),
        ctx(jobId),
      );
      return { status: res.status, body: (await res.json()) as JobOutcomeResponse };
    }

    async function correlationJobs(reviewRunId: string) {
      return db
        .select()
        .from(jobs)
        .where(eq(jobs.dedupeKey, `${CORRELATION_JOB_TYPE}:${reviewRunId}`));
    }

    async function runFindings(reviewRunId: string) {
      const rows = await db
        .select({ finding: findings, taskId: reviews.taskId })
        .from(findings)
        .innerJoin(reviews, eq(reviews.id, findings.reviewId))
        .where(eq(reviews.reviewRunId, reviewRunId))
        .orderBy(asc(findings.createdAt), asc(findings.id));
      return rows;
    }

    /**
     * A review run of two tasks on a new PR whose task runs both completed at
     * once, each with one finding on the same line: it is correlating.
     */
    async function correlatingRun() {
      const prNumber = ++prCounter;
      await setReviewTasks(["builtin:review-pr", SECURITY_TASK_ID]);
      const { accessToken } = await newAgent();
      const enqueued = await enqueue(prNumber, head1);
      if (enqueued.status !== "enqueued") throw new Error(enqueued.status);
      const outputs: (ReviewJobResult & { summary?: string })[] = [];
      for (const run of enqueued.runs) {
        const started = await startAs(run.jobId, accessToken);
        if (started?.action !== "run") throw new Error("expected run");
        const output = await agentRun(started.job.payload);
        // The first task's run writes a summary (the correlation reads it).
        outputs.push(outputs.length === 0 ? { ...output, summary: "Adds login logging." } : output);
      }
      // Both task runs complete at once: exactly one of them starts the correlation.
      const submitted = await Promise.all(
        enqueued.runs.map((run, i) => submit(run.jobId, accessToken, outputs[i]!)),
      );
      expect(submitted.map((s) => s.body)).toEqual([
        { status: "completed" },
        { status: "completed" },
      ]);
      const correlation = await correlationJobs(enqueued.reviewRunId);
      expect(correlation).toHaveLength(1);
      // Nothing is posted until the correlation ends.
      expect(postsTo(prNumber)).toBe(0);
      return { prNumber, enqueued, accessToken, outputs, correlationJob: correlation[0]! };
    }

    /** How many reviews were posted to PR `prNumber`. */
    function postsTo(prNumber: number): number {
      return postReview.mock.calls.filter((call) => call[1] === prNumber).length;
    }

    /** A run's findings without what posting sets. */
    async function unposted(reviewRunId: string) {
      return (await runFindings(reviewRunId)).map(
        ({ finding: { scmCommentId: _, updatedAt: __, ...rest }, taskId }) => ({ rest, taskId }),
      );
    }

    it("starts one correlation job when the last of two finished task runs ends", async () => {
      const { prNumber, enqueued, correlationJob } = await correlatingRun();
      expect(await reviewRunRow(enqueued.reviewRunId)).toMatchObject({
        status: "correlating",
        correlationJobId: correlationJob.id,
      });
      expect(correlationJob).toMatchObject({
        type: CORRELATION_JOB_TYPE,
        taskId: "builtin:correlate-findings",
        taskType: "query",
        pool: "short",
        status: "queued",
        repositoryId,
      });
      const payload = RunSpecJobPayload.parse(correlationJob.payload);
      expect(payload.trigger.kind).toBe("run.invoked");
      const context = CorrelationTriggerContext.parse(payload.trigger.context);
      const rows = await runFindings(enqueued.reviewRunId);
      expect(rows).toHaveLength(2);
      // Each finding records the task that reported it.
      for (const row of rows) expect(row.finding.sourceTaskIds).toEqual([row.taskId]);
      expect(context).toMatchObject({
        invoker: { kind: "review-run", id: enqueued.reviewRunId },
        repository: "acme/app",
        pr: { number: prNumber },
      });
      expect(context.reviewRun.tasks.items.map((t) => [t.taskId, t.name])).toEqual([
        ["builtin:review-pr", "Review a pull request"],
        [SECURITY_TASK_ID, "Security review"],
      ]);
      expect(context.reviewRun.tasks.items.map((t) => t.summary)).toEqual([
        "Adds login logging.",
        null,
      ]);
      expect((await reviewRow(enqueued.runs[0]!.reviewId)).summary).toBe("Adds login logging.");
      for (const item of context.reviewRun.tasks.items) {
        const row = rows.find((r) => r.taskId === item.taskId)!;
        expect(item.findings).toEqual([
          expect.objectContaining({ id: row.finding.id, path: "src/app.ts", startLine: 2 }),
        ]);
      }
    });

    it("skips correlation when only one task run finished", async () => {
      const prNumber = ++prCounter;
      await setReviewTasks(["builtin:review-pr", SECURITY_TASK_ID]);
      const { accessToken } = await newAgent();
      const enqueued = await enqueue(prNumber, head1);
      if (enqueued.status !== "enqueued") throw new Error(enqueued.status);
      await complete(enqueued.runs[0]!.jobId, accessToken);
      await startAs(enqueued.runs[1]!.jobId, accessToken);
      await failFinal(enqueued.runs[1]!.jobId, accessToken);
      expect(await reviewRunRow(enqueued.reviewRunId)).toMatchObject({
        status: "completed",
        correlationJobId: null,
      });
      expect(await correlationJobs(enqueued.reviewRunId)).toHaveLength(0);
    });

    it("merges the findings a canned correlation result names, once", async () => {
      const { prNumber, enqueued, accessToken, outputs, correlationJob } = await correlatingRun();
      const [first, second] = await runFindings(enqueued.reviewRunId);
      // A finding the output leaves out, and one of another PR the output names.
      const [leftOut] = await db
        .insert(findings)
        .values({
          ...first!.finding,
          id: undefined,
          title: "Unrelated",
          createdAt: new Date(first!.finding.createdAt.getTime() + 5000),
        })
        .returning();
      const other = await enqueue(++prCounter, head1);
      if (other.status !== "enqueued") throw new Error(other.status);
      await complete(other.runs[0]!.jobId, accessToken);
      const [outside] = await db
        .select()
        .from(findings)
        .where(eq(findings.reviewId, other.runs[0]!.reviewId));

      const claimed = await startAs(correlationJob.id, accessToken);
      expect(claimed?.action).toBe("run");
      const output = {
        findings: [
          {
            sourceFindingIds: [second!.finding.id, first!.finding.id, outside!.id],
            sourceTaskIds: [SECURITY_TASK_ID, "builtin:not-in-run"],
            path: "src/app.ts",
            startLine: 2,
            endLine: 2,
            severity: "critical",
            category: "security",
            title: "Token logged (merged)",
            body: "Both tasks found the token in the log.",
            suggestion: "logger.info({ user }, `login`);",
            confidence: 0.97,
          },
        ],
        summary: "  Adds login logging; the token leaks.  ",
      };
      expect((await submitQuery(correlationJob.id, accessToken, queryResult(output))).body).toEqual(
        { status: "completed" },
      );

      const after = await runFindings(enqueued.reviewRunId);
      const target = after.find((r) => r.finding.id === first!.finding.id)!.finding;
      expect(target).toMatchObject({
        status: "open",
        severity: "critical",
        title: "Token logged (merged)",
        body: "Both tasks found the token in the log.",
        suggestion: "logger.info({ user }, `login`);",
        path: "src/app.ts",
        mergedIntoFindingId: null,
      });
      expect(target.confidence).toBeCloseTo(0.97);
      expect([...target.sourceTaskIds].sort()).toEqual(["builtin:review-pr", SECURITY_TASK_ID]);
      expect(after.find((r) => r.finding.id === second!.finding.id)!.finding).toMatchObject({
        status: "merged",
        mergedIntoFindingId: first!.finding.id,
        title: second!.finding.title,
      });
      expect(after.find((r) => r.finding.id === leftOut!.id)!.finding).toMatchObject({
        status: "open",
        title: "Unrelated",
        severity: leftOut!.severity,
      });
      const [outsideAfter] = await db.select().from(findings).where(eq(findings.id, outside!.id));
      expect(outsideAfter).toMatchObject({ status: "open", title: outside!.title });
      expect(await reviewRunRow(enqueued.reviewRunId)).toMatchObject({
        status: "completed",
        summary: "Adds login logging; the token leaks.",
        error: null,
      });

      // One review is posted for the run: the merged finding once, naming both tasks.
      expect(postsTo(prNumber)).toBe(1);
      const posted = postReview.mock.calls.find((call) => call[1] === prNumber)![2];
      expect(posted.summary).toContain("Adds login logging; the token leaks.");
      expect(posted.summary).toContain("**Findings:** 2");
      expect(posted.summary).toContain("**Tokens:** 3,000 /");
      expect(posted.inlineComments.map((c) => c.body.split("\n")[0])).toEqual([
        "**[critical] Token logged (merged)**",
        "**[high] Unrelated**",
      ]);
      expect(posted.inlineComments[0]!.body).toContain(
        "_security · confidence 97% · Review a pull request, Security review_",
      );
      expect((await reviewRunRow(enqueued.reviewRunId)).summaryCommentId).not.toBeNull();
      const postedRows = (await listReviewRunFindings(db, enqueued.reviewRunId)).filter(
        (f) => f.scmCommentId !== null,
      );
      expect(postedRows.map((f) => f.id).sort()).toEqual([first!.finding.id, leftOut!.id].sort());

      // A replayed result changes nothing more.
      const strip = (rows: Awaited<ReturnType<typeof runFindings>>) =>
        rows.map(({ finding: { updatedAt: _, ...rest } }) => rest);
      expect((await submitQuery(correlationJob.id, accessToken, queryResult(output))).body).toEqual(
        { status: "completed" },
      );
      expect(strip(await runFindings(enqueued.reviewRunId))).toEqual(strip(after));
      // ... nor do replays of the task runs' results: still one review for the run.
      for (const [i, run] of enqueued.runs.entries()) {
        expect((await submit(run.jobId, accessToken, outputs[i]!)).body).toEqual({
          status: "completed",
        });
      }
      expect(postsTo(prNumber)).toBe(1);

      // A merged finding isn't open: the next review doesn't get it.
      const previous = await previousReviewState(db, { repositoryId, prNumber, headSha: head2 });
      const openIds = previous!.openFindings.map((f) => f.id);
      expect(openIds).toContain(first!.finding.id);
      expect(openIds).not.toContain(second!.finding.id);
    });

    it("leaves every finding unmerged when the correlation fails for good", async () => {
      const { prNumber, enqueued, accessToken, correlationJob } = await correlatingRun();
      const before = await unposted(enqueued.reviewRunId);
      await startAs(correlationJob.id, accessToken);
      await failFinal(correlationJob.id, accessToken);
      expect(await reviewRunRow(enqueued.reviewRunId)).toMatchObject({
        status: "completed",
        summary: null,
        error: "Correlation failed: boom",
      });
      expect(await unposted(enqueued.reviewRunId)).toEqual(before);
      // Posted unmerged: one review with both findings.
      expect(postsTo(prNumber)).toBe(1);
      const posted = postReview.mock.calls.find((call) => call[1] === prNumber)![2];
      expect(posted.inlineComments).toHaveLength(2);
    });

    it("leaves every finding unmerged when the correlation's output doesn't match its schema", async () => {
      const { prNumber, enqueued, accessToken, correlationJob } = await correlatingRun();
      const before = await unposted(enqueued.reviewRunId);
      await startAs(correlationJob.id, accessToken);
      const invalid = {
        findings: [{ sourceFindingIds: before.map((r) => r.rest.id), severity: "urgent" }],
        summary: "Merged",
      };
      expect(
        (await submitQuery(correlationJob.id, accessToken, queryResult(invalid))).body,
      ).toEqual({ status: "completed" });
      const run = await reviewRunRow(enqueued.reviewRunId);
      expect(run).toMatchObject({ status: "completed", summary: null });
      expect(run.error).toMatch(/^Correlation output is invalid/);
      expect(await unposted(enqueued.reviewRunId)).toEqual(before);
      expect(postsTo(prNumber)).toBe(1);
    });

    it("cancels the correlation of an older head on a newer push", async () => {
      const { prNumber, enqueued, correlationJob } = await correlatingRun();
      const newer = await enqueue(prNumber, head2);
      if (newer.status !== "enqueued") throw new Error(newer.status);
      expect(newer.canceledJobIds).toEqual([correlationJob.id]);
      expect(await jobRow(correlationJob.id)).toMatchObject({ status: "canceled" });
      expect(await reviewRunRow(enqueued.reviewRunId)).toMatchObject({ status: "skipped" });
      // A superseded run is never posted.
      expect(postsTo(prNumber)).toBe(0);
    });
  });
});
