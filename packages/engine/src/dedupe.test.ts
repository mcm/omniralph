import type { Finding } from "@omniralph/shared";
import { describe, expect, it } from "vitest";
import { dedupeFindings, mergeFindings, sameIssue, splitIssue } from "./dedupe.js";

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

describe("splitIssue", () => {
  it("also accepts adjacent line ranges", () => {
    const a = finding();
    expect(splitIssue(a, finding({ startLine: 13, endLine: 20 }))).toBe(true);
    expect(splitIssue(a, finding({ startLine: 1, endLine: 9 }))).toBe(true);
    expect(splitIssue(a, finding({ startLine: 14, endLine: 20 }))).toBe(false);
    expect(splitIssue(a, finding({ startLine: 1, endLine: 8 }))).toBe(false);
    expect(splitIssue(a, finding({ startLine: 13, path: "src/b.ts" }))).toBe(false);
    expect(splitIssue(a, finding({ startLine: 13, category: "security" }))).toBe(false);
  });
});

describe("mergeFindings", () => {
  it("lets the more severe finding lead and widens the range", () => {
    const minor = finding({ startLine: 13, endLine: 13, severity: "low", title: "Minor", body: "B." });
    const major = finding({ severity: "critical", body: "A.", confidence: 0.5 });
    const merged = mergeFindings(minor, major);
    expect(merged).toMatchObject({ severity: "critical", title: "Bug", startLine: 10, endLine: 13 });
    expect(merged.confidence).toBe(0.9);
    expect(merged.body).toBe("A.\n\nAlso (line 13): Minor. B.");
  });

  it("keeps the leader's suggestion when the other finding lies inside its range", () => {
    const lead = finding({ suggestion: "fixed();" });
    expect(mergeFindings(lead, finding({ startLine: 11, endLine: 11, title: "Dup" }))).toEqual(lead);
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

  it("merges two findings about one issue on adjacent lines into one", () => {
    // TOOL-57: a PR-title injection on the `run:` line (16) plus a separate
    // "add PR_TITLE to env" finding on the same step's `env:` lines (14-15).
    const path = ".github/workflows/ci.yml";
    const injection = finding({
      path,
      startLine: 16,
      endLine: 16,
      severity: "high",
      category: "security",
      title: "Script injection via the PR title",
      body: "`${{ github.event.pull_request.title }}` is expanded into the shell script.",
      suggestion: '        run: echo "Coverage for: $PR_TITLE"',
    });
    const envMapping = finding({
      path,
      startLine: 14,
      endLine: 15,
      severity: "medium",
      category: "security",
      title: "Add PR_TITLE to env",
      body: "Pass the title through an environment variable.",
      suggestion: "        env:\n          NODE_ENV: test\n          PR_TITLE: ${{ github.event.pull_request.title }}",
      confidence: 0.8,
    });

    const result = dedupeFindings([injection, envMapping]);

    expect(result.suppressed).toEqual([envMapping]);
    expect(result.findings).toHaveLength(1);
    const [merged] = result.findings;
    expect(merged).toMatchObject({
      path,
      startLine: 14,
      endLine: 16,
      severity: "high",
      category: "security",
      title: "Script injection via the PR title",
      confidence: 0.9,
    });
    // Neither suggestion alone fixes lines 14-16, so both move into the body.
    expect(merged!.suggestion).toBeUndefined();
    expect(merged!.body).toContain(injection.body);
    expect(merged!.body).toContain("Suggested change for line 16:");
    expect(merged!.body).toContain("Also (lines 14-15): Add PR_TITLE to env.");
    expect(merged!.body).toContain("PR_TITLE: ${{ github.event.pull_request.title }}");
  });

  it("keeps findings of other categories on adjacent lines apart", () => {
    const a = finding();
    const b = finding({ startLine: 13, endLine: 13, category: "performance" });
    expect(dedupeFindings([a, b])).toEqual({ findings: [a, b], suppressed: [] });
  });
});
