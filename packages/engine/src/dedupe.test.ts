import type { Finding } from "@omniralph/shared";
import { describe, expect, it } from "vitest";
import { dedupeFindings, sameIssue } from "./dedupe.js";

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  path: "src/a.ts",
  startLine: 10,
  endLine: 12,
  severity: "high",
  category: "correctness",
  title: "Bug",
  body: "Fails for empty input.",
  confidence: 0.9,
  ...overrides,
});

describe("sameIssue", () => {
  it("needs the same path, the same category and overlapping lines", () => {
    const a = finding();
    expect(sameIssue(a, finding({ startLine: 12, endLine: 20 }))).toBe(true);
    expect(sameIssue(a, finding({ startLine: 5, endLine: 10 }))).toBe(true);
    expect(sameIssue(a, finding({ startLine: 11, endLine: 11 }))).toBe(true);
    expect(sameIssue(a, finding({ startLine: 13, endLine: 20 }))).toBe(false);
    expect(sameIssue(a, finding({ startLine: 1, endLine: 9 }))).toBe(false);
    expect(sameIssue(a, finding({ path: "src/b.ts" }))).toBe(false);
    expect(sameIssue(a, finding({ category: "security" }))).toBe(false);
  });
});

describe("dedupeFindings", () => {
  it("suppresses new findings that match an open prior finding", () => {
    const prior = [finding({ title: "Old" })];
    const repeat = finding({ startLine: 11, endLine: 14, title: "Same bug, reworded" });
    const otherCategory = finding({ category: "performance" });
    const otherLines = finding({ startLine: 30, endLine: 31 });
    const result = dedupeFindings([repeat, otherCategory, otherLines], prior);
    expect(result.findings).toEqual([otherCategory, otherLines]);
    expect(result.suppressed).toEqual([repeat]);
  });

  it("drops repeats among the new findings, keeping the first", () => {
    const first = finding();
    const second = finding({ startLine: 12, endLine: 12, title: "Dup" });
    expect(dedupeFindings([first, second])).toEqual({ findings: [first], suppressed: [second] });
  });

  it("keeps everything when there is nothing to match", () => {
    const all = [finding(), finding({ path: "b.ts" })];
    expect(dedupeFindings(all, [])).toEqual({ findings: all, suppressed: [] });
  });
});
