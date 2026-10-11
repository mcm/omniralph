import type { Database, Job } from "@omniralph/db";
import { getBuiltinTask, TaskDefinition, type TaskDefinitionInput } from "@omniralph/tasks";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("server-only", () => ({}));

const { jobHooks, parseSinkResult, sinkFor, taskSink } = await import("./index");
const { registerJobOutcomeHandler } = await import("@/lib/jobs/handlers");
const { learnedRuleSink } = await import("./learned-rule");
const { findingThreadSink } = await import("./finding-thread");
const { chatThreadSink } = await import("./chat-thread");
const { triageSink } = await import("./triage");

const legacyCompleted = vi.fn();
registerJobOutcomeHandler("sinks.legacy", {
  payload: z.object({}),
  isValidResult: () => true,
  onCompleted: legacyCompleted,
});

function task(id: string, sink: TaskDefinitionInput["sink"]) {
  return TaskDefinition.parse({
    id,
    name: id,
    taskType: "query",
    agentId: "builtin:rule-writer",
    triggers: ["finding.dismissed"],
    promptTemplate: "{{finding.title}}",
    sink,
    pool: "short",
  });
}

const DEFINITIONS = {
  getTask: (id: string) =>
    ({
      "builtin:learn-rule": getBuiltinTask("builtin:learn-rule"),
      "builtin:reply": getBuiltinTask("builtin:reply"),
      "builtin:ask-about-code": getBuiltinTask("builtin:ask-about-code"),
      "builtin:triage": getBuiltinTask("builtin:triage"),
      "test:result": task("builtin:test-result", "run-result"),
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
  it("finds the implemented sinks by kind, and nothing for sinks not implemented yet", () => {
    expect(sinkFor("learned-rule")).toBe(learnedRuleSink);
    expect(sinkFor("finding-thread")).toBe(findingThreadSink);
    expect(sinkFor("chat-thread")).toBe(chatThreadSink);
    expect(sinkFor("triage")).toBe(triageSink);
    expect(sinkFor("run-result")).toBeUndefined();
  });
});

describe("taskSink", () => {
  it("is the sink of the job's task", () => {
    expect(taskSink({ taskId: "builtin:learn-rule" }, DEFINITIONS)).toBe(learnedRuleSink);
    expect(taskSink({ taskId: "builtin:reply" }, DEFINITIONS)).toBe(findingThreadSink);
    expect(taskSink({ taskId: "builtin:ask-about-code" }, DEFINITIONS)).toBe(chatThreadSink);
    expect(taskSink({ taskId: "builtin:triage" }, DEFINITIONS)).toBe(triageSink);
    expect(taskSink({ taskId: "test:result" }, DEFINITIONS)).toBeUndefined();
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
