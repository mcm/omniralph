import { describe, expect, it } from "vitest";
import { Finding, FindingList } from "./index.js";

const valid = {
  path: "src/a.ts",
  startLine: 3,
  endLine: 4,
  severity: "high",
  category: "correctness",
  title: "Off by one",
  body: "The loop skips the last element.",
  confidence: 0.8,
};

describe("Finding", () => {
  it("accepts a valid finding with an optional suggestion", () => {
    expect(Finding.parse(valid)).toEqual(valid);
    expect(Finding.parse({ ...valid, suggestion: "x" }).suggestion).toBe("x");
  });

  it("rejects bad severities, confidence and line ranges", () => {
    expect(Finding.safeParse({ ...valid, severity: "blocker" }).success).toBe(false);
    expect(Finding.safeParse({ ...valid, confidence: 1.5 }).success).toBe(false);
    expect(Finding.safeParse({ ...valid, startLine: 0 }).success).toBe(false);
    expect(Finding.safeParse({ ...valid, startLine: 1.5 }).success).toBe(false);
    expect(Finding.safeParse({ ...valid, startLine: 5, endLine: 4 }).success).toBe(false);
  });

  it("validates lists", () => {
    expect(FindingList.safeParse([valid, valid]).success).toBe(true);
    expect(FindingList.safeParse([valid, { ...valid, title: "" }]).success).toBe(false);
  });
});
