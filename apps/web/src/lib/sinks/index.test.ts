import type { Database, Job } from "@omniralph/db";
import { getBuiltinTask } from "@omniralph/tasks";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("server-only", () => ({}));

const { jobHooks, parseSinkResult, sinkFor, taskSink } = await import("./index");
const { registerJobOutcomeHandler } = await import("@/lib/jobs/handlers");
const { learnedRuleSink } = await import("./learned-rule");
const { findingThreadSink } = await import("./finding-thread");
const { chatThreadSink } = await import("./chat-thread");
const { triageSink } = await import("./triage");
const { reviewSink } = await import("./review");
const { runResultSink } = await import("./run-result");
const { stickyCommentSink } = await import("./sticky-comment");
const { ralphRunSink } = await import("./ralph-run");

const legacyCompleted = vi.fn();
registerJobOutcomeHandler("sinks.legacy", {
  payload: z.object({}),
  isValidResult: () => true,
  onCompleted: legacyCompleted,
});

const DEFINITIONS = {
  getTask: (id: string) =>
    ({
      "builtin:learn-rule": getBuiltinTask("builtin:learn-rule"),
      "builtin:reply-to-finding": getBuiltinTask("builtin:reply-to-finding"),
      "builtin:ask-about-code": getBuiltinTask("builtin:ask-about-code"),
      "builtin:triage": getBuiltinTask("builtin:triage"),
      "builtin:review-pr": getBuiltinTask("builtin:review-pr"),
      "builtin:summarize-pr": getBuiltinTask("builtin:summarize-pr"),
      "builtin:implement-story": getBuiltinTask("builtin:implement-story"),
      "builtin:handle-request": getBuiltinTask("builtin:handle-request"),
    })[id] ?? null,
  getAgent: () => null,
};

const answered = (structured: unknown, answer: string | null = null) => ({
  outcome: "answered",
  answer,
  structured,
  references: [],
  usage: { inputTokens: 1, outputTokens: 1 },
  durationMs: 1,
});

describe("sinkFor", () => {
  it("finds every sink by kind", () => {
    expect(sinkFor("learned-rule")).toBe(learnedRuleSink);
    expect(sinkFor("finding-thread")).toBe(findingThreadSink);
    expect(sinkFor("chat-thread")).toBe(chatThreadSink);
    expect(sinkFor("triage")).toBe(triageSink);
    expect(sinkFor("review")).toBe(reviewSink);
    expect(sinkFor("run-result")).toBe(runResultSink);
    expect(sinkFor("sticky-comment")).toBe(stickyCommentSink);
    expect(sinkFor("ralph-run")).toBe(ralphRunSink);
  });
});

describe("taskSink", () => {
  it("is the sink of the job's task", () => {
    expect(taskSink({ taskId: "builtin:learn-rule" }, DEFINITIONS)).toBe(learnedRuleSink);
    expect(taskSink({ taskId: "builtin:reply-to-finding" }, DEFINITIONS)).toBe(findingThreadSink);
    expect(taskSink({ taskId: "builtin:ask-about-code" }, DEFINITIONS)).toBe(chatThreadSink);
    expect(taskSink({ taskId: "builtin:triage" }, DEFINITIONS)).toBe(triageSink);
    expect(taskSink({ taskId: "builtin:review-pr" }, DEFINITIONS)).toBe(reviewSink);
    expect(taskSink({ taskId: "builtin:summarize-pr" }, DEFINITIONS)).toBe(stickyCommentSink);
    expect(taskSink({ taskId: "builtin:implement-story" }, DEFINITIONS)).toBe(ralphRunSink);
    expect(taskSink({ taskId: "builtin:handle-request" }, DEFINITIONS)).toBe(ralphRunSink);
    expect(taskSink({ taskId: "builtin:gone" }, DEFINITIONS)).toBeUndefined();
    expect(taskSink({ taskId: null }, DEFINITIONS)).toBeUndefined();
  });
});

describe("jobHooks", () => {
  it("uses the task's sink for a run-spec job, never its type's outcome handler", async () => {
    const hooks = jobHooks({ type: "sinks.legacy", payload: {}, taskId: "builtin:learn-rule" })!;
    expect(hooks.isValidResult!(answered({ rule: null }))).toBe(true);
    expect(hooks.isValidResult!({})).toBe(false);
    expect(hooks.onStarted).toBeUndefined();
    expect(hooks.onFailed).toBeUndefined();
    // A null rule is applied without touching the database.
    const job = { id: "j", payload: {}, repositoryId: null, result: answered({ rule: null }) };
    expect(await hooks.onCompleted!({} as Database, job as unknown as Job)).toEqual({
      status: "no_rule",
    });
    expect(legacyCompleted).not.toHaveBeenCalled();
  });

  it("validates a review run's result with the review sink, with every review hook", () => {
    const hooks = jobHooks({ type: "review.task", payload: {}, taskId: "builtin:review-pr" })!;
    const result = {
      findings: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      skipped: [],
      stopReason: "completed",
      scope: { mode: "full", baseSha: "a".repeat(40), headSha: "b".repeat(40) },
      discarded: { invalid: 0, outsideDiff: 0, duplicate: 0 },
      summary: "Looks fine.",
      durationMs: 1,
    };
    expect(hooks.isValidResult!(result)).toBe(true);
    expect(hooks.isValidResult!({ ...result, findings: "x" })).toBe(false);
    expect(hooks.isValidResult!(answered(null, "text"))).toBe(false);
    for (const hook of ["onStarted", "onCompleted", "onFailed", "onRetry", "onCanceled"] as const) {
      expect(hooks[hook]).toBeTypeOf("function");
    }
  });

  it("hands a coding run's story or request result to its ralph run, with the ralph hooks", () => {
    const hooks = jobHooks({
      type: "ralph.story",
      payload: {},
      taskId: "builtin:implement-story",
    })!;
    const story = {
      status: "complete",
      summary: "Did it.",
      followUps: [],
      feedback: null,
      usage: { inputTokens: 1, outputTokens: 1 },
      durationMs: 1,
    };
    expect(hooks.isValidResult!(story)).toBe(true);
    const request = {
      summary: "Done.",
      sessionId: null,
      usage: { inputTokens: 1, outputTokens: 1 },
      durationMs: 1,
    };
    expect(hooks.isValidResult!(request)).toBe(true);
    expect(hooks.isValidResult!(answered(null, "text"))).toBe(false);
    for (const hook of ["onStarted", "onCompleted", "onFailed", "onCanceled"] as const) {
      expect(hooks[hook]).toBeTypeOf("function");
    }
    // A retried delivery isn't an attempt: nothing to apply until it ends.
    expect(hooks.onRetry).toBeUndefined();
  });

  it("has no hooks for a run-spec job without an implemented sink", () => {
    expect(jobHooks({ type: "sinks.legacy", payload: {}, taskId: "builtin:gone" })).toBeUndefined();
  });

  it("uses the type's outcome handler for a legacy job", async () => {
    const hooks = jobHooks({ type: "sinks.legacy", payload: {}, taskId: null })!;
    await hooks.onCompleted!({} as Database, {} as Job);
    expect(legacyCompleted).toHaveBeenCalledOnce();
  });
});

describe("parseSinkResult", () => {
  const textSink = { ...learnedRuleSink, kind: "chat-thread" as const, outputSchema: null };

  it("parses the structured output with the sink's output schema", () => {
    expect(parseSinkResult(learnedRuleSink, answered({ rule: "Do not flag X." }))).toMatchObject({
      structured: { rule: "Do not flag X." },
    });
    expect(parseSinkResult(learnedRuleSink, answered({ rule: 1 }))).toBeNull();
    expect(parseSinkResult(learnedRuleSink, answered(null, "text"))).toBeNull();
  });

  it("takes the Markdown answer for a sink without an output schema", () => {
    expect(parseSinkResult(textSink, answered(null, "The answer."))).toMatchObject({
      answer: "The answer.",
      structured: null,
    });
    expect(parseSinkResult(textSink, answered({ rule: "x" }))).toBeNull();
  });

  it("accepts runs that ended without output", () => {
    const exhausted = { ...answered(null), outcome: "budget_exhausted" };
    expect(parseSinkResult(learnedRuleSink, exhausted)).toMatchObject({ structured: null });
    expect(parseSinkResult(textSink, exhausted)).toMatchObject({ answer: null });
  });
});
