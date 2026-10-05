import type { Finding } from "@omniralph/shared";
import { describe, expect, it } from "vitest";
import type { ExpectedFinding } from "./case.js";
import { LINE_TOLERANCE, scoreCase } from "./score.js";

const expected: ExpectedFinding = {
  path: "src/users/repository.ts",
  startLine: 17,
  endLine: 20,
  category: "security",
  minSeverity: "high",
};

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    path: "src/users/repository.ts",
    startLine: 17,
    endLine: 20,
    severity: "critical",
    category: "security",
    title: "SQL injection in searchUsers",
    body: "The search term is concatenated into the SQL text.",
    confidence: 0.9,
    ...overrides,
  };
}

const counts = (score: ReturnType<typeof scoreCase>) => ({
  tp: score.truePositives.length,
  fp: score.falsePositives.length,
  fn: score.falseNegatives.length,
});

describe("scoreCase", () => {
  it("matches a finding with the same path, lines and category", () => {
    const score = scoreCase([finding()], { expected: [expected] });
    expect(counts(score)).toEqual({ tp: 1, fp: 0, fn: 0 });
    expect(score.truePositives[0]?.expected).toBe(expected);
  });

  it("matches line ranges that overlap within ±3 lines", () => {
    expect(LINE_TOLERANCE).toBe(3);
    // A single line just inside the tolerance on either side.
    for (const line of [14, 23]) {
      const score = scoreCase([finding({ startLine: line, endLine: line })], {
        expected: [expected],
      });
      expect(counts(score), `line ${line}`).toEqual({ tp: 1, fp: 0, fn: 0 });
    }
    // One line further away is a miss: a false positive plus a false negative.
    for (const line of [13, 24]) {
      const score = scoreCase([finding({ startLine: line, endLine: line })], {
        expected: [expected],
      });
      expect(counts(score), `line ${line}`).toEqual({ tp: 0, fp: 1, fn: 1 });
      expect(score.falsePositives[0]?.reason).toBe("unmatched");
    }
    // A wide finding that spans the expected range matches too.
    const wide = scoreCase([finding({ startLine: 1, endLine: 40 })], { expected: [expected] });
    expect(counts(wide)).toEqual({ tp: 1, fp: 0, fn: 0 });
  });

  it("does not match another file", () => {
    const score = scoreCase([finding({ path: "src/routes/users.ts" })], { expected: [expected] });
    expect(counts(score)).toEqual({ tp: 0, fp: 1, fn: 1 });
  });

  it("does not match a different category", () => {
    const score = scoreCase([finding({ category: "correctness" })], { expected: [expected] });
    expect(counts(score)).toEqual({ tp: 0, fp: 1, fn: 1 });
    expect(score.falseNegatives).toEqual([expected]);
  });

  it("does not match a severity below the minimum", () => {
    const below = scoreCase([finding({ severity: "medium" })], { expected: [expected] });
    expect(counts(below)).toEqual({ tp: 0, fp: 1, fn: 1 });
    // The minimum itself and anything above it match.
    for (const severity of ["high", "critical"] as const) {
      expect(counts(scoreCase([finding({ severity })], { expected: [expected] }))).toEqual({
        tp: 1,
        fp: 0,
        fn: 0,
      });
    }
    const infoMin = { ...expected, minSeverity: "info" as const };
    expect(counts(scoreCase([finding({ severity: "info" })], { expected: [infoMin] }))).toEqual({
      tp: 1,
      fp: 0,
      fn: 0,
    });
  });

  it("counts a hit on mustNotFlag as a false positive, even when it matches an expected item", () => {
    const mustNotFlag = [
      { path: "src/users/repository.ts", startLine: 19, endLine: 19, note: "Bound parameter" },
      { path: "src/routes/users.ts", note: "The whole file is fine" },
    ];
    const score = scoreCase(
      [
        finding({ startLine: 18, endLine: 19 }),
        finding({ path: "src/routes/users.ts", startLine: 3, endLine: 3 }),
        finding({ startLine: 20, endLine: 20 }),
      ],
      { expected: [expected], mustNotFlag },
    );
    expect(score.falsePositives.map((fp) => [fp.reason, fp.mustNotFlag?.note])).toEqual([
      ["must_not_flag", "Bound parameter"],
      ["must_not_flag", "The whole file is fine"],
    ]);
    // The finding next to the forbidden line still matches the expected item.
    expect(counts(score)).toEqual({ tp: 1, fp: 2, fn: 0 });
    // mustNotFlag has no line tolerance.
    const nextTo = scoreCase([finding({ startLine: 20, endLine: 20 })], {
      expected: [],
      mustNotFlag,
    });
    expect(nextTo.falsePositives[0]?.reason).toBe("unmatched");
  });

  it("scores a clean case with no findings as all zeros", () => {
    expect(counts(scoreCase([], { expected: [] }))).toEqual({ tp: 0, fp: 0, fn: 0 });
    expect(counts(scoreCase([], { expected: [], mustNotFlag: [] }))).toEqual({
      tp: 0,
      fp: 0,
      fn: 0,
    });
  });

  it("counts every finding on a clean case as a false positive", () => {
    const score = scoreCase([finding(), finding({ category: "performance" })], { expected: [] });
    expect(counts(score)).toEqual({ tp: 0, fp: 2, fn: 0 });
  });

  it("matches each expected item once and counts repeats as duplicates", () => {
    const score = scoreCase([finding(), finding({ startLine: 18, endLine: 18 })], {
      expected: [expected],
    });
    expect(counts(score)).toEqual({ tp: 1, fp: 1, fn: 0 });
    expect(score.falsePositives[0]?.reason).toBe("duplicate");
  });

  it("gives a finding the closest of several nearby expected items", () => {
    const first: ExpectedFinding = { ...expected, startLine: 10, endLine: 10 };
    const second: ExpectedFinding = { ...expected, startLine: 14, endLine: 14 };
    // Line 13 is within tolerance of both; it belongs to the closer one.
    const score = scoreCase(
      [finding({ startLine: 13, endLine: 13 }), finding({ startLine: 10, endLine: 10 })],
      { expected: [first, second] },
    );
    expect(counts(score)).toEqual({ tp: 2, fp: 0, fn: 0 });
    expect(score.truePositives.map((tp) => tp.expected)).toEqual([second, first]);
  });
});
