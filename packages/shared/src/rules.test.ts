import { describe, expect, it } from "vitest";
import { LearnRuleJobResult, MAX_LEARNED_RULE_LENGTH, RuleInput } from "./rules.js";

const result = {
  rule: "Do not flag X.",
  outcome: "rule",
  usage: { inputTokens: 1000, outputTokens: 30 },
  durationMs: 10,
};

describe("LearnRuleJobResult", () => {
  it("accepts a rule up to the length limit, or none", () => {
    expect(LearnRuleJobResult.safeParse(result).success).toBe(true);
    expect(
      LearnRuleJobResult.safeParse({ ...result, rule: "x".repeat(MAX_LEARNED_RULE_LENGTH) })
        .success,
    ).toBe(true);
    for (const outcome of ["none", "rejected", "budget_exhausted"]) {
      expect(LearnRuleJobResult.safeParse({ ...result, rule: null, outcome }).success).toBe(true);
    }
  });

  it("rejects a too-long rule and a rule that doesn't match the outcome", () => {
    expect(
      LearnRuleJobResult.safeParse({ ...result, rule: "x".repeat(MAX_LEARNED_RULE_LENGTH + 1) })
        .success,
    ).toBe(false);
    expect(LearnRuleJobResult.safeParse({ ...result, outcome: "none" }).success).toBe(false);
    expect(LearnRuleJobResult.safeParse({ ...result, rule: null }).success).toBe(false);
  });
});

describe("RuleInput", () => {
  it("trims and bounds the text", () => {
    expect(RuleInput.parse({ text: "  Flag TODOs. " })).toEqual({ text: "Flag TODOs." });
    expect(RuleInput.safeParse({ text: "  " }).success).toBe(false);
    expect(RuleInput.safeParse({ text: "x".repeat(1001) }).success).toBe(false);
  });
});
