import type { Database, Job } from "@omniralph/db";
import type { ReviewJobPayload } from "@omniralph/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("server-only", () => ({}));
const review = vi.hoisted(() => ({
  onReviewJobStarted: vi.fn(),
  onReviewJobCompleted: vi.fn(),
  onReviewJobFailed: vi.fn(),
  onReviewJobRetry: vi.fn(),
  onReviewJobCanceled: vi.fn(),
  parseReviewResult: vi.fn((result: unknown) => (result === "ok" ? {} : null)),
}));
vi.mock("@/lib/review/jobs", () => review);
vi.mock("@/lib/mentions/reply", () => ({
  onReplyJobCompleted: vi.fn(),
  onReplyJobFailed: vi.fn(),
  parseReplyResult: vi.fn(),
}));
const chatAsk = vi.hoisted(() => ({
  onChatAskJobCompleted: vi.fn(),
  onChatAskJobFailed: vi.fn(),
  parseChatAskResult: vi.fn((result: unknown) => (result === "ok" ? {} : null)),
}));
vi.mock("@/lib/chat/ask", () => chatAsk);

const { jobOutcomeHandler, registerJobOutcomeHandler } = await import("./handlers");

const sha = "a".repeat(40);
const reviewPayload: ReviewJobPayload = {
  reviewId: "00000000-0000-4000-8000-000000000001",
  repositoryId: "00000000-0000-4000-8000-000000000002",
  repository: {
    provider: "github",
    fullPath: "acme/widgets",
    cloneUrl: "https://github.com/acme/widgets.git",
  },
  prNumber: 1,
  baseSha: sha,
  headSha: sha,
  changeRequest: { title: "t", description: null, author: null },
  reviewConfig: {
    profile: {
      id: "p",
      name: "Default",
      model: null,
      maxTokensPerReview: 1000,
      maxFiles: 10,
      allowRepoExploration: true,
    },
    customInstructions: null,
    rules: [],
    pathExcludes: [],
  },
  previousReview: null,
};

function job(overrides: Partial<Job>): Job {
  return {
    id: "00000000-0000-4000-8000-000000000009",
    type: "review.run",
    taskType: "review",
    pool: "short",
    payload: reviewPayload,
    ...overrides,
  } as Job;
}

describe("job outcome handlers", () => {
  it("routes review and reply jobs to their handlers by type", () => {
    expect(jobOutcomeHandler(job({}))?.onStarted).toBeDefined();
    // Registered, but the payload is a review's: generic lifecycle only.
    expect(jobOutcomeHandler(job({ type: "review.reply" }))).toBeUndefined();
  });

  it("ignores jobs whose type or payload don't match", () => {
    expect(jobOutcomeHandler(job({ type: "review.other" }))).toBeUndefined();
    expect(jobOutcomeHandler(job({ payload: { reviewId: "x" } }))).toBeUndefined();
    expect(
      jobOutcomeHandler(job({ type: "repo.sync", taskType: "system", pool: null })),
    ).toBeUndefined();
  });

  it("validates results and keeps the review failure default", async () => {
    const handler = jobOutcomeHandler(job({}))!;
    expect(handler.isValidResult!("ok")).toBe(true);
    expect(handler.isValidResult!("bad")).toBe(false);
    const db = {} as Database;
    await handler.onFailed!(db, job({}), null);
    expect(review.onReviewJobFailed).toHaveBeenLastCalledWith(db, job({}), "Review failed");
    await handler.onFailed!(db, job({}), "boom");
    expect(review.onReviewJobFailed).toHaveBeenLastCalledWith(db, job({}), "boom");
  });

  it("routes triage jobs and accepts well-formed results only", () => {
    const triage = job({
      type: "triage.run",
      taskType: "query",
      pool: "short",
      payload: {
        triageRunId: "00000000-0000-4000-8000-000000000003",
        issue: {
          id: "issue-1",
          identifier: "ENG-1",
          title: "t",
          description: "",
          stateType: "backlog",
          creator: null,
        },
      },
    });
    const handler = jobOutcomeHandler(triage)!;
    expect(handler.onStarted).toBeDefined();
    expect(handler.isValidResult!({ summary: "x" })).toBe(false);
    expect(
      handler.isValidResult!({
        summary: "failed",
        error: "boom",
        outcome: null,
        usage: { inputTokens: 0, outputTokens: 0 },
        durationMs: 0,
      }),
    ).toBe(true);
  });

  it("routes chat.ask jobs to the code question hooks", async () => {
    const ask = job({
      type: "chat.ask",
      payload: {
        repositoryId: reviewPayload.repositoryId,
        repository: reviewPayload.repository,
        defaultBranch: "main",
        question: "Where is auth?",
        context: null,
        chatThreadId: "00000000-0000-4000-8000-000000000004",
        model: null,
        maxTokens: 1000,
      },
    });
    const handler = jobOutcomeHandler(ask)!;
    expect(handler.isValidResult!("ok")).toBe(true);
    expect(handler.isValidResult!("bad")).toBe(false);
    const db = {} as Database;
    await handler.onCompleted!(db, ask);
    expect(chatAsk.onChatAskJobCompleted).toHaveBeenLastCalledWith(db, ask);
    await handler.onFailed!(db, ask, "boom");
    expect(chatAsk.onChatAskJobFailed).toHaveBeenLastCalledWith(db, ask);
    // A review payload isn't a code question's.
    expect(jobOutcomeHandler(job({ type: "chat.ask" }))).toBeUndefined();
  });

  it("registers new job types, once each", () => {
    const onCompleted = vi.fn();
    registerJobOutcomeHandler("test.thing", {
      payload: z.object({ runId: z.string() }),
      onCompleted,
    });
    const thing = job({ type: "test.thing", payload: { runId: "r" } });
    expect(jobOutcomeHandler(thing)?.onCompleted).toBe(onCompleted);
    expect(() => registerJobOutcomeHandler("test.thing", { payload: z.object({}) })).toThrow(
      /twice/,
    );
    expect(() => registerJobOutcomeHandler("review.run", { payload: z.object({}) })).toThrow(
      /twice/,
    );
  });
});
