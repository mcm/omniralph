import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  LearnRuleOutcome,
  LearnRuleRequest,
  QuestionAnswerer,
  ReplyOutcome,
  ReplyRequest,
  ReviewProvider,
  ReviewRequest,
  RuleLearner,
  TaskReviewResult,
} from "@omniralph/engine";
import {
  LearnRuleJobResult,
  ReviewJobResult,
  ReviewReplyJobResult,
  type ReviewReplyJobPayload,
  type LearnRuleJobPayload,
  type Finding,
  type JobPayload,
  type JobRepository,
  type ReviewJobPayload,
} from "@omniralph/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../logger.js";
import { ENV, Remote } from "../test/git-remote.js";
import { RepoCache } from "../workspace/repoCache.js";
import { RetryableJobError, type JobContext } from "./index.js";
import { capFindings, createReviewCapability, REVIEW_TOOL_POLICY } from "./review.js";

const PROFILE = {
  id: "standard",
  name: "Standard",
  model: null,
  maxTokensPerReview: 100_000,
  maxFiles: 50,
  allowRepoExploration: true,
};

/** A fake provider recording its requests and the files it saw in the worktree. */
function fakeProvider(result: Partial<TaskReviewResult> = {}) {
  const requests: (ReviewRequest & { worktreeFiles: string[] })[] = [];
  const provider: ReviewProvider = {
    async review(request) {
      requests.push({ ...request, worktreeFiles: (await readdir(request.cwd)).sort() });
      const file = request.task.files[0]!;
      const line = file.hunks[0]!.lines.find((l) => l.type === "add")!.newLine!;
      return {
        findings: [
          {
            path: file.path,
            startLine: line,
            endLine: line,
            severity: "medium",
            category: "correctness",
            title: "Off by one",
            body: "The loop skips the last item.",
            confidence: 0.8,
          },
        ],
        usage: { inputTokens: 500, outputTokens: 100 },
        stopReason: "completed",
        discarded: { invalid: 0, outsideDiff: 0 },
        ...result,
      };
    },
  };
  return { provider, requests };
}

describe("review capability", () => {
  let root: string;
  let workspaceRoot: string;
  let remote: Remote;
  let repository: JobRepository;
  let repos: RepoCache;
  let controller: AbortController;
  let base: string;
  let head: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "omniralph-review-cap-"));
    workspaceRoot = path.join(root, "workspace");
    remote = new Remote(root);
    remote.init();
    repository = {
      provider: "github",
      fullPath: "acme/app",
      cloneUrl: pathToFileURL(remote.bare).href,
    };
    repos = new RepoCache({ workspaceRoot, credentialHelper: "!true", lockRetryMs: 20 });
    controller = new AbortController();
    base = await remote.commit({
      "src/list.ts": "export function last(xs: number[]) {\n  return xs[xs.length];\n}\n",
      "CLAUDE.md": "Base conventions: prefer early returns.\n",
    });
    // The PR head is only reachable from refs/pull/1/head, like on GitHub.
    head = await remote.commit(
      { "src/list.ts": "export function last(xs: number[]) {\n  return xs[xs.length + 1];\n}\n" },
      "pr-branch",
    );
    remote.hideBranch("pr-branch", "refs/pull/1/head");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function context(): JobContext {
    return {
      signal: controller.signal,
      jobToken: () => "job-token",
      env: (extra) => ({ ...ENV, OMNIRALPH_JOB_TOKEN: "job-token", ...extra }),
      spawn: () => {
        throw new Error("the review capability must not spawn processes");
      },
      server: "https://omniralph.example.com",
      workspaceRoot,
      repos,
      logger: silentLogger(),
    };
  }

  function job(overrides: Partial<ReviewJobPayload> = {}): JobPayload {
    const payload: ReviewJobPayload = {
      reviewId: randomUUID(),
      repositoryId: randomUUID(),
      repository,
      prNumber: 1,
      baseSha: base,
      headSha: head,
      changeRequest: { title: "Fix last()", description: null, author: "octocat" },
      reviewConfig: { profile: PROFILE, customInstructions: null, rules: [], pathExcludes: [] },
      previousReview: null,
      ...overrides,
    };
    return {
      id: randomUUID(),
      capability: "review",
      type: "review.run",
      repositoryId: payload.repositoryId,
      payload,
      deliveryCount: 1,
    };
  }

  it("is read-only and runs review.run and review.learn-rule jobs", () => {
    const capability = createReviewCapability();
    expect(capability.jobTypes).toEqual(["review.run", "review.learn-rule", "review.reply"]);
    expect(capability.toolPolicy).toBe(REVIEW_TOOL_POLICY);
    expect(REVIEW_TOOL_POLICY.allowedTools).toEqual(["Read", "Grep", "Glob"]);
    expect(REVIEW_TOOL_POLICY.disallowedTools).toEqual(
      expect.arrayContaining(["Bash", "Write", "Edit", "WebFetch", "WebSearch"]),
    );
    expect(REVIEW_TOOL_POLICY.permissionMode).not.toBe("bypassPermissions");
    expect(REVIEW_TOOL_POLICY.settingSources).toEqual([]);
    expect(REVIEW_TOOL_POLICY.writable).toBe(false);
  });

  it("clones, runs runReview in a worktree at head and reports the ReviewResult", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { provider, requests } = fakeProvider();
    const reviewJob = job();
    const output = await createReviewCapability({ provider }).run(reviewJob, context());

    const result = ReviewJobResult.parse(output);
    expect(result).toMatchObject({
      findings: [{ path: "src/list.ts", startLine: 2, endLine: 2, title: "Off by one" }],
      usage: { inputTokens: 500, outputTokens: 100 },
      skipped: [],
      stopReason: "completed",
      scope: { mode: "full", baseSha: base, headSha: head },
      discarded: { invalid: 0, outsideDiff: 0, duplicate: 0 },
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request!.cwd).toBe(path.join(workspaceRoot, ".worktrees", reviewJob.id));
    expect(request!.worktreeFiles).toEqual([".git", "CLAUDE.md", "src"]);
    expect(request!.allowExploration).toBe(true);
    expect(request!.prompt).toContain("Base conventions: prefer early returns.");
    expect(request!.prompt).toContain("+  return xs[xs.length + 1];");
    // The worktree is gone afterwards; the cache stays.
    expect(await readdir(path.join(workspaceRoot, ".worktrees"))).toEqual([]);
    expect(await readdir(path.join(workspaceRoot, "github", "file", "acme", "app"))).toContain(
      "HEAD",
    );
    // No code-host (or any other HTTP) calls.
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("reviews only the commits since the previous review's head", async () => {
    const next = await remote.commit(
      { "src/extra.ts": "export const extra = 1;\n" },
      "pr-branch-2",
    );
    remote.hideBranch("pr-branch-2", "refs/pull/1/head");
    const { provider, requests } = fakeProvider();
    const output = await createReviewCapability({ provider }).run(
      job({
        headSha: next,
        previousReview: {
          headSha: head,
          openFindings: [
            { path: "src/list.ts", startLine: 2, endLine: 2, category: "correctness" },
          ],
        },
      }),
      context(),
    );
    const result = ReviewJobResult.parse(output);
    expect(result.scope).toEqual({ mode: "incremental", fromSha: head, headSha: next });
    expect(requests[0]!.task.files.map((f) => f.path)).toEqual(["src/extra.ts"]);
  });

  it("falls back to the full diff when the previous head no longer exists (force-push)", async () => {
    const gone = "0123456789abcdef0123456789abcdef01234567";
    const { provider } = fakeProvider();
    const output = await createReviewCapability({ provider }).run(
      job({ previousReview: { headSha: gone, openFindings: [] } }),
      context(),
    );
    expect(ReviewJobResult.parse(output).scope).toEqual({
      mode: "full",
      baseSha: base,
      headSha: head,
      fallbackFrom: gone,
    });
  });

  it("turns a Claude rate limit into a retryable failure with the reset delay", async () => {
    const { provider } = fakeProvider({
      findings: [],
      stopReason: "rate_limited",
      error: "Claude usage limit reached",
      retryAfterMs: 90_500,
    });
    const error = await createReviewCapability({ provider })
      .run(job(), context())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RetryableJobError);
    expect(error).toMatchObject({ message: "Claude usage limit reached", retryAfterSeconds: 91 });
    expect(await readdir(path.join(workspaceRoot, ".worktrees"))).toEqual([]);
  });

  it("fails on a provider error and on an invalid payload", async () => {
    const { provider } = fakeProvider({ findings: [], stopReason: "error", error: "auth failed" });
    const capability = createReviewCapability({ provider });
    await expect(capability.run(job(), context())).rejects.toThrow("auth failed");
    await expect(capability.run({ ...job(), payload: { prNumber: 1 } }, context())).rejects.toThrow(
      "invalid review.run payload",
    );
  });

  it("returns partial findings when the budget runs out", async () => {
    const { provider } = fakeProvider({ stopReason: "budget_exhausted" });
    const output = await createReviewCapability({ provider }).run(job(), context());
    expect(ReviewJobResult.parse(output)).toMatchObject({
      stopReason: "budget_exhausted",
      findings: [{ title: "Off by one" }],
    });
  });

  describe("review.learn-rule", () => {
    function fakeLearner(outcome: Partial<LearnRuleOutcome> = {}) {
      const requests: LearnRuleRequest[] = [];
      const learner: RuleLearner = {
        async learnRule(request) {
          requests.push(request);
          return {
            status: "rule",
            rule: "Do not flag out-of-range reads in last(); callers check the length.",
            usage: { inputTokens: 1200, outputTokens: 40 },
            ...outcome,
          };
        },
      };
      return { learner, requests };
    }

    function learnJob(overrides: Partial<LearnRuleJobPayload> = {}): JobPayload {
      const payload: LearnRuleJobPayload = {
        feedbackId: randomUUID(),
        findingId: randomUUID(),
        repositoryId: randomUUID(),
        repository,
        baseSha: base,
        headSha: head,
        model: "claude-haiku-4-5",
        maxTokens: 5000,
        finding: {
          path: "src/list.ts",
          startLine: 2,
          endLine: 2,
          severity: "high",
          category: "correctness",
          title: "Out-of-range read",
          body: "xs[xs.length + 1] is always undefined.",
        },
        note: "Callers always check the length first.",
        ...overrides,
      };
      return {
        id: randomUUID(),
        capability: "review",
        type: "review.learn-rule",
        repositoryId: payload.repositoryId,
        payload,
        deliveryCount: 1,
      };
    }

    it("sends the finding, its diff hunk and the note, with the token cap, and returns the rule", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const { learner, requests } = fakeLearner();
      const output = await createReviewCapability({ learner }).run(learnJob(), context());
      expect(LearnRuleJobResult.parse(output)).toMatchObject({
        outcome: "rule",
        rule: "Do not flag out-of-range reads in last(); callers check the length.",
        usage: { inputTokens: 1200, outputTokens: 40 },
      });
      expect(requests).toHaveLength(1);
      const [request] = requests;
      expect(request!.maxTokens).toBe(5000);
      expect(request!.model).toBe("claude-haiku-4-5");
      expect(request!.prompt).toContain("Out-of-range read");
      expect(request!.prompt).toContain("-  return xs[xs.length];");
      expect(request!.prompt).toContain("+  return xs[xs.length + 1];");
      expect(request!.prompt).toContain("Callers always check the length first.");
      // No worktree is created for it.
      expect(await readdir(path.join(workspaceRoot, ".worktrees")).catch(() => [])).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("generates without the hunk when the commits can't be fetched", async () => {
      const { learner, requests } = fakeLearner({ status: "none", rule: null });
      const output = await createReviewCapability({ learner }).run(
        learnJob({ headSha: "f".repeat(40) }),
        context(),
      );
      expect(LearnRuleJobResult.parse(output)).toMatchObject({ outcome: "none", rule: null });
      expect(requests[0]!.prompt).toContain("(not available)");
    });

    it("reports rejected and budget-exhausted generations as results without a rule", async () => {
      for (const status of ["rejected", "budget_exhausted"] as const) {
        const { learner } = fakeLearner({ status, rule: null, error: "too long" });
        const output = await createReviewCapability({ learner }).run(learnJob(), context());
        expect(LearnRuleJobResult.parse(output)).toMatchObject({ outcome: status, rule: null });
      }
    });

    it("retries rate limits and fails on errors", async () => {
      const limited = fakeLearner({ status: "rate_limited", rule: null, retryAfterMs: 30_000 });
      const error = await createReviewCapability({ learner: limited.learner })
        .run(learnJob(), context())
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RetryableJobError);
      expect((error as RetryableJobError).retryAfterSeconds).toBe(30);

      const failing = fakeLearner({ status: "error", rule: null, error: "auth failed" });
      await expect(
        createReviewCapability({ learner: failing.learner }).run(learnJob(), context()),
      ).rejects.toThrow("auth failed");
    });

    it("rejects an invalid payload", async () => {
      const job = learnJob();
      await expect(
        createReviewCapability({ learner: fakeLearner().learner }).run(
          { ...job, payload: { findingId: "x" } },
          context(),
        ),
      ).rejects.toThrow("invalid review.learn-rule payload");
    });
  });

  describe("review.reply", () => {
    function fakeAnswerer(outcome: Partial<ReplyOutcome> = {}) {
      const requests: (ReplyRequest & { worktreeFiles: string[] })[] = [];
      const answerer: QuestionAnswerer = {
        async answer(request) {
          requests.push({ ...request, worktreeFiles: (await readdir(request.cwd)).sort() });
          return {
            status: "answered",
            answer: "Yes: `xs.length + 1` is always out of range.",
            usage: { inputTokens: 3000, outputTokens: 80 },
            ...outcome,
          };
        },
      };
      return { answerer, requests };
    }

    function replyJob(overrides: Partial<ReviewReplyJobPayload> = {}): JobPayload {
      const payload: ReviewReplyJobPayload = {
        findingId: randomUUID(),
        reviewId: randomUUID(),
        repositoryId: randomUUID(),
        repository,
        prNumber: 1,
        baseSha: base,
        headSha: head,
        model: "claude-sonnet-5-5",
        maxTokens: 10_000,
        finding: {
          path: "src/list.ts",
          startLine: 2,
          endLine: 2,
          severity: "high",
          category: "correctness",
          title: "Out-of-range read",
          body: "xs[xs.length + 1] is always undefined.",
        },
        question: "Are you sure? Callers check the length.",
        askedBy: "octocat",
        threadCommentId: "555",
        ...overrides,
      };
      return {
        id: randomUUID(),
        capability: "review",
        type: "review.reply",
        repositoryId: payload.repositoryId,
        payload,
        deliveryCount: 1,
      };
    }

    it("answers in a worktree at head with the finding, hunk and question, under the token cap", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const { answerer, requests } = fakeAnswerer();
      const output = await createReviewCapability({ answerer }).run(replyJob(), context());
      expect(ReviewReplyJobResult.parse(output)).toMatchObject({
        outcome: "answered",
        answer: "Yes: `xs.length + 1` is always out of range.",
        usage: { inputTokens: 3000, outputTokens: 80 },
      });
      const [request] = requests;
      expect(request!.allowExploration).toBe(true);
      expect(request!.maxTokens).toBe(10_000);
      expect(request!.model).toBe("claude-sonnet-5-5");
      expect(request!.worktreeFiles).toEqual([".git", "CLAUDE.md", "src"]);
      expect(request!.prompt).toContain("Out-of-range read");
      expect(request!.prompt).toContain("+  return xs[xs.length + 1];");
      expect(request!.prompt).toContain("Are you sure? Callers check the length.");
      // The worktree is removed afterwards.
      expect(await readdir(path.join(workspaceRoot, ".worktrees")).catch(() => [])).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("answers without tools or hunk when the commits can't be fetched", async () => {
      const { answerer, requests } = fakeAnswerer();
      await createReviewCapability({ answerer }).run(
        replyJob({ headSha: "f".repeat(40) }),
        context(),
      );
      expect(requests[0]!.allowExploration).toBe(false);
      expect(requests[0]!.worktreeFiles).toEqual([]);
      expect(requests[0]!.prompt).toContain("(not available)");
    });

    it("reports a budget-exhausted answer, retries rate limits and fails on errors", async () => {
      const capped = fakeAnswerer({ status: "budget_exhausted", answer: null });
      expect(
        ReviewReplyJobResult.parse(
          await createReviewCapability({ answerer: capped.answerer }).run(replyJob(), context()),
        ),
      ).toMatchObject({ outcome: "budget_exhausted", answer: null });

      const limited = fakeAnswerer({ status: "rate_limited", answer: null, retryAfterMs: 5000 });
      const error = await createReviewCapability({ answerer: limited.answerer })
        .run(replyJob(), context())
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RetryableJobError);
      expect((error as RetryableJobError).retryAfterSeconds).toBe(5);

      const failing = fakeAnswerer({ status: "error", answer: null, error: "auth failed" });
      await expect(
        createReviewCapability({ answerer: failing.answerer }).run(replyJob(), context()),
      ).rejects.toThrow("auth failed");
      await expect(
        createReviewCapability({ answerer: failing.answerer }).run(
          { ...replyJob(), payload: { findingId: "x" } },
          context(),
        ),
      ).rejects.toThrow("invalid review.reply payload");
    });
  });
});

describe("capFindings", () => {
  const f = (title: string, severity: Finding["severity"], confidence = 0.5): Finding => ({
    path: "a.ts",
    startLine: 1,
    endLine: 1,
    severity,
    category: "correctness",
    title,
    body: "b",
    confidence,
  });

  it("keeps the most severe, then most confident, findings in their original order", () => {
    const findings = [
      f("low", "low"),
      f("high-unsure", "high", 0.4),
      f("info", "info"),
      f("critical", "critical"),
      f("high-sure", "high", 0.9),
    ];
    expect(capFindings(findings, 3).map((x) => x.title)).toEqual([
      "high-unsure",
      "critical",
      "high-sure",
    ]);
    expect(capFindings(findings, 2).map((x) => x.title)).toEqual(["critical", "high-sure"]);
    expect(capFindings(findings)).toEqual(findings);
  });

  it("fits ReviewJobResult however many findings the engine returns", () => {
    const many = Array.from({ length: 600 }, (_, i) => f(`f${i}`, i < 10 ? "critical" : "low"));
    const kept = capFindings(many);
    expect(kept).toHaveLength(500);
    expect(kept.filter((x) => x.severity === "critical")).toHaveLength(10);
  });
});
