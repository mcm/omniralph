import { describe, expect, it } from "vitest";
import { QueryRunResult } from "./run-result.js";

const base = {
  references: [],
  usage: { inputTokens: 10, outputTokens: 2 },
  durationMs: 5,
};

describe("QueryRunResult", () => {
  it("accepts an answer or a structured result for an answered run", () => {
    expect(
      QueryRunResult.safeParse({ ...base, outcome: "answered", answer: "Yes.", structured: null })
        .success,
    ).toBe(true);
    expect(
      QueryRunResult.safeParse({
        ...base,
        outcome: "answered",
        answer: null,
        structured: { rule: "x" },
      }).success,
    ).toBe(true);
  });

  it("rejects an answered run with neither or both", () => {
    for (const output of [
      { answer: null, structured: null },
      { answer: "Yes.", structured: { rule: "x" } },
    ]) {
      expect(QueryRunResult.safeParse({ ...base, outcome: "answered", ...output }).success).toBe(
        false,
      );
    }
  });

  it("carries no output for budget_exhausted and no_checkout", () => {
    for (const outcome of ["budget_exhausted", "no_checkout"]) {
      expect(
        QueryRunResult.safeParse({ ...base, outcome, answer: null, structured: null }).success,
      ).toBe(true);
      expect(
        QueryRunResult.safeParse({ ...base, outcome, answer: "partial", structured: null }).success,
      ).toBe(false);
    }
  });
});
