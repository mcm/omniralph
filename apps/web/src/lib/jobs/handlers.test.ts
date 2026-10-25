import type { Job } from "@omniralph/db";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("server-only", () => ({}));

const { jobOutcomeHandler, registerJobOutcomeHandler } = await import("./handlers");

function job(overrides: Partial<Job>): Job {
  return {
    id: "00000000-0000-4000-8000-000000000009",
    type: "review.task",
    taskType: "review",
    payload: { reviewId: "00000000-0000-4000-8000-000000000001" },
    ...overrides,
  } as Job;
}

describe("job outcome handlers", () => {
  it("has no review handler: review task runs use the review sink, and review.run is gone", () => {
    for (const type of ["review.run", "review.task"]) {
      expect(jobOutcomeHandler(job({ type }))).toBeUndefined();
    }
    // Built-in query tasks now (`builtin:learn-rule`, `builtin:reply-to-finding`, `builtin:ask-about-code`): their sinks handle them.
    for (const type of ["review.learn-rule", "review.reply", "chat.ask"]) {
      expect(jobOutcomeHandler(job({ type }))).toBeUndefined();
    }
  });

  it("ignores jobs whose type or payload don't match", () => {
    expect(jobOutcomeHandler(job({ type: "review.other" }))).toBeUndefined();
    expect(jobOutcomeHandler(job({ type: "ralph.story", payload: { x: 1 } }))).toBeUndefined();
    expect(
      jobOutcomeHandler(job({ type: "repo.sync", taskType: "system" })),
    ).toBeUndefined();
  });

  it("has no story, request or describe handler: those coding and query runs use their sinks", () => {
    // Registering one doesn't throw: none is registered yet.
    for (const type of ["ralph.story", "ralph.request", "ralph.describe-pr"]) {
      expect(() => registerJobOutcomeHandler(type, { payload: z.never() })).not.toThrow();
    }
  });

  it("has no triage handler: triage runs are builtin:triage runs with the triage sink", () => {
    expect(jobOutcomeHandler(job({ type: "triage.run", taskType: "query" }))).toBe(
      undefined,
    );
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
    expect(() => registerJobOutcomeHandler("worktree.exec", { payload: z.object({}) })).toThrow(
      /twice/,
    );
  });
});
