import { describe, expect, it } from "vitest";
import { RuleInput } from "./rules.js";

describe("RuleInput", () => {
  it("trims and bounds the text", () => {
    expect(RuleInput.parse({ text: "  Flag TODOs. " })).toEqual({ text: "Flag TODOs." });
    expect(RuleInput.safeParse({ text: "  " }).success).toBe(false);
    expect(RuleInput.safeParse({ text: "x".repeat(1001) }).success).toBe(false);
  });
});
