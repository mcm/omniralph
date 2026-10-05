import { describe, expect, it } from "vitest";
import { findDuplicateRule, normalizeRuleText, ruleSimilarity } from "./ruleDedupe.js";

describe("rule dedupe", () => {
  it("normalizes case, punctuation and whitespace", () => {
    expect(normalizeRuleText("  Do NOT flag `eval()`  in\n tests!  ")).toBe(
      "do not flag eval in tests",
    );
  });

  it("scores identical rules (after normalization) as 1", () => {
    expect(ruleSimilarity("Do not flag eval() in tests.", "do not flag EVAL in tests")).toBe(1);
  });

  it("treats a one-word variation of a long rule as a near-duplicate", () => {
    const existing = [
      {
        id: "a",
        text: "Do not flag missing null checks on values returned by config.get(); it throws on missing keys.",
      },
    ];
    const similar =
      "Do not flag missing null checks on values returned from config.get(); it throws on missing keys.";
    expect(ruleSimilarity(similar, existing[0]!.text)).toBeGreaterThanOrEqual(0.9);
    expect(findDuplicateRule(similar, existing)).toBe(existing[0]);
  });

  it("keeps different rules apart", () => {
    const existing = [{ text: "Do not flag missing null checks on config.get() results." }];
    const other = "Do not flag SQL built with the sql`` tagged template; it is parameterized.";
    expect(ruleSimilarity(other, existing[0]!.text)).toBeLessThan(0.9);
    expect(findDuplicateRule(other, existing)).toBeUndefined();
  });

  it("uses the 0.9 threshold inclusively and honors a custom one", () => {
    // 10 characters, one substitution: similarity exactly 0.9.
    expect(ruleSimilarity("abcdefghij", "abcdefghix")).toBeCloseTo(0.9);
    expect(findDuplicateRule("abcdefghij", [{ text: "abcdefghix" }])).toBeDefined();
    expect(findDuplicateRule("abcdefghij", [{ text: "abcdefghix" }], 0.95)).toBeUndefined();
  });

  it("finds nothing among no rules", () => {
    expect(findDuplicateRule("Do not flag anything.", [])).toBeUndefined();
  });
});
