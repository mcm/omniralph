import { describe, expect, it } from "vitest";
import { MAX_REPLY_ANSWER_LENGTH, replyTokenCap, ReviewReplyJobResult } from "./reply.js";

const result = {
  answer: "The value is checked in `load()`.",
  outcome: "answered",
  usage: { inputTokens: 1000, outputTokens: 30 },
  durationMs: 10,
};

describe("ReviewReplyJobResult", () => {
  it("accepts an answer up to the length limit, or none when the budget ran out", () => {
    expect(ReviewReplyJobResult.safeParse(result).success).toBe(true);
    expect(
      ReviewReplyJobResult.safeParse({ ...result, answer: "x".repeat(MAX_REPLY_ANSWER_LENGTH) })
        .success,
    ).toBe(true);
    expect(
      ReviewReplyJobResult.safeParse({ ...result, answer: null, outcome: "budget_exhausted" })
        .success,
    ).toBe(true);
  });

  it("rejects a too-long answer and an answer that doesn't match the outcome", () => {
    expect(
      ReviewReplyJobResult.safeParse({ ...result, answer: "x".repeat(MAX_REPLY_ANSWER_LENGTH + 1) })
        .success,
    ).toBe(false);
    expect(ReviewReplyJobResult.safeParse({ ...result, answer: null }).success).toBe(false);
    expect(ReviewReplyJobResult.safeParse({ ...result, answer: "  " }).success).toBe(false);
    expect(ReviewReplyJobResult.safeParse({ ...result, outcome: "budget_exhausted" }).success).toBe(
      false,
    );
  });
});

describe("replyTokenCap", () => {
  it("is 10% of the profile budget", () => {
    expect(replyTokenCap(200_000)).toBe(20_000);
    expect(replyTokenCap(60_005)).toBe(6_000);
    expect(replyTokenCap(5)).toBe(1);
  });
});
