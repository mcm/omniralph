import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  agents,
  connectRepository,
  createDb,
  findings,
  jobs,
  reviews,
  rules,
  runMigrations,
  upsertScmConnection,
  type Database,
} from "@omniralph/db";
import { runReview, type ReviewProvider } from "@omniralph/engine";
import { GitHubAdapter } from "@omniralph/scm";
import {
  ReviewJobPayload,
  type Finding,
  type JobOutcomeResponse,
  type JobStartResponse,
  type ReviewJobResult,
} from "@omniralph/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { asc, eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  sends: [] as { topic: string; payload: unknown; options: unknown }[],
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@vercel/queue", () => ({
  QueueClient: class {
    async send(topic: string, payload: unknown, options: unknown) {
      state.sends.push({ topic, payload, options });
      return { messageId: `msg-${state.sends.length}` };
    }
  },
}));

const signingKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const appKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
delete process.env.KMS_AGENT_ISSUER_ID;
delete process.env.GITHUB_APP_KMS_ISSUER_ID;
process.env.LOCAL_AGENT_SIGNING_KEY = signingKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.QUEUE_REGIONS = "iad1";
process.env.GITHUB_APP_ID = "12345";
process.env.GITHUB_APP_PRIVATE_KEY = appKey.export({ type: "pkcs8", format: "pem" }).toString();
process.env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
process.env.APP_URL = "https://omniralph.example.com";

const { getTokenSigner } = await import("@/lib/agent-auth/signer");
const { VercelQueuesDispatcher } = await import("@/lib/dispatch");
const { enqueueReview } = await import("@/lib/review/enqueue");
const { POST: start } = await import("./jobs/[id]/start/route");
const { POST: result } = await import("./jobs/[id]/result/route");
const { POST: fail } = await import("./jobs/[id]/fail/route");

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

/** A deterministic git repo standing in for the agent's worktree. */
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
  return new Request(`http://localhost/api/agent/${path}`, {
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
    state.db = db;
    server.listen({ onUnhandledFrame: "error" });

    const connection = await upsertScmConnection(db, {
      provider: "github",
      name: "acme",
      baseUrl: "https://api.github.com",
      externalId: "4242",
      credentials: {},
    });
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
    await db?.$client.end();
    await container?.stop();
    rmSync(repo.dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    state.sends.length = 0;
    github.reviews.length = 0;
    postReview.mockClear();
  });

  function dispatcher() {
    return new VercelQueuesDispatcher({ db });
  }

  async function newAgent() {
    const [agent] = await db.insert(agents).values({ name: "coder-1" }).returning();
    return { agentId: agent!.id, accessToken: await getTokenSigner().signAccessToken(agent!.id) };
  }

  function enqueue(prNumber: number, headSha: string) {
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
      trigger: "webhook",
    });
  }

  async function startAs(jobId: string, accessToken: string): Promise<JobStartResponse> {
    const res = await start(agentRequest(`jobs/${jobId}/start`, accessToken), ctx(jobId));
    expect(res.status).toBe(200);
    return (await res.json()) as JobStartResponse;
  }

  async function submit(jobId: string, accessToken: string, body: ReviewJobResult) {
    const res = await result(
      agentRequest(`jobs/${jobId}/result`, accessToken, { result: body }),
      ctx(jobId),
    );
    return { status: res.status, body: (await res.json()) as JobOutcomeResponse };
  }

  /** What the agent's review capability does in the worktree, with the provider mocked. */
  async function agentRun(payload: unknown): Promise<ReviewJobResult> {
    const job = ReviewJobPayload.parse(payload);
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

  it("goes from a created job to persisted findings and exactly one postReview, also on replay", async () => {
    const prNumber = ++prCounter;
    const enqueued = await enqueue(prNumber, head1);
    if (enqueued.status !== "enqueued") throw new Error(enqueued.status);
    const { jobId, reviewId } = enqueued;

    // The job carries the resolved config and no credentials.
    const job = await jobRow(jobId);
    expect(state.sends).toEqual([
      expect.objectContaining({ topic: "review-jobs", payload: { jobId } }),
    ]);
    const payload = ReviewJobPayload.parse(job.payload);
    expect(payload).toMatchObject({
      reviewId,
      repositoryId,
      repository: {
        provider: "github",
        fullPath: "acme/app",
        cloneUrl: "https://github.com/acme/app.git",
      },
      prNumber,
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
    expect((await reviewRow(reviewId)).status).toBe("queued");

    // Agent start → run.
    const { agentId, accessToken } = await newAgent();
    const started = await startAs(jobId, accessToken);
    expect(started).toMatchObject({ action: "run", job: { id: jobId, payload: job.payload } });
    expect(await reviewRow(reviewId)).toMatchObject({ status: "running", agentId });

    // Agent runs the review and reports the result.
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

    // Another agent replaying it is rejected.
    const other = await newAgent();
    expect((await submit(jobId, other.accessToken, output)).status).toBe(409);
    expect(postReview).toHaveBeenCalledTimes(1);

    // The next push is reviewed incrementally, deduped against the open finding.
    const next = await enqueue(prNumber, head2);
    if (next.status !== "enqueued") throw new Error(next.status);
    const nextPayload = ReviewJobPayload.parse((await jobRow(next.jobId)).payload);
    expect(nextPayload.previousReview).toEqual({
      headSha: head1,
      openFindings: [{ path: "src/app.ts", startLine: 2, endLine: 2, category: "security" }],
    });
    await startAs(next.jobId, accessToken);
    const nextOutput = await agentRun(nextPayload);
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
    if (run.action !== "run") throw new Error("expected run");
    await submit(first.jobId, accessToken, await agentRun(run.job.payload));
    expect(postReview).toHaveBeenCalledTimes(1);

    // E.g. a redelivered webhook for the same head after the review completed.
    const again = await enqueue(prNumber, head1);
    if (again.status !== "enqueued") throw new Error(again.status);
    expect(await startAs(again.jobId, accessToken)).toEqual({
      action: "skip",
      reason: "already_reviewed",
    });
    expect(await jobRow(again.jobId)).toMatchObject({ status: "skipped" });
    expect(await reviewRow(again.reviewId)).toMatchObject({ status: "skipped" });
    expect(postReview).toHaveBeenCalledTimes(1);
  });

  it("cancels queued and running jobs for older head SHAs of the same PR on a newer push", async () => {
    const prNumber = ++prCounter;
    const { accessToken } = await newAgent();
    const running = await enqueue(prNumber, base);
    if (running.status !== "enqueued") throw new Error(running.status);
    const run = await startAs(running.jobId, accessToken);
    if (run.action !== "run") throw new Error("expected run");
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

    // The canceled queued job is skipped at start; the running one's late result isn't posted.
    expect(await startAs(queued.jobId, accessToken)).toEqual({
      action: "skip",
      reason: "canceled",
    });
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
    expect(review).toMatchObject({ status: "failed", error, summaryCommentId: "9000" });
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
    expect(await startAs(enqueued.jobId, accessToken)).toEqual({
      action: "skip",
      reason: "max_deliveries",
    });
    expect(await reviewRow(enqueued.reviewId)).toMatchObject({
      status: "failed",
      error: "Gave up after 3 deliveries",
    });
    expect(postReview).toHaveBeenCalledTimes(1);
  });
});
