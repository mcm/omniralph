import type { Finding } from "@omniralph/shared";
import { describe, expect, it } from "vitest";
import { parseDiff } from "./diff.js";
import { hunkLineSets } from "./providers/findings-output.js";
import { alignSuggestionRange } from "./suggestionRange.js";

const FILE = [
  "function total(items) {", // 1
  "  let sum = 0;", // 2
  "  for (const item of items) {", // 3
  "    sum += item.price;", // 4
  "  }", // 5
  "  return sum;", // 6
  "}", // 7
  "", // 8
].join("\n");

/** Every line is in one hunk unless a test narrows it. */
const ALL = [new Set([1, 2, 3, 4, 5, 6, 7])];

const finding = (startLine: number, endLine: number, suggestion?: string): Finding => ({
  path: "src/total.js",
  startLine,
  endLine,
  severity: "medium",
  category: "correctness",
  title: "Price ignores quantity",
  body: "Multiply by `item.quantity`.",
  ...(suggestion !== undefined ? { suggestion } : {}),
  confidence: 0.8,
});

/** What "Commit suggestion" does: replace exactly startLine..endLine. */
function apply(text: string, f: Finding): string {
  const lines = text.split("\n");
  lines.splice(f.startLine - 1, f.endLine - f.startLine + 1, ...f.suggestion!.split("\n"));
  return lines.join("\n");
}

const FIXED = FILE.replace("item.price;", "item.price * item.quantity;");

describe("alignSuggestionRange", () => {
  it("leaves a suggestion that replaces exactly its range alone", () => {
    const f = finding(4, 4, "    sum += item.price * item.quantity;");
    expect(alignSuggestionRange(f, FILE, ALL)).toEqual({ kind: "unchanged", finding: f });
    expect(alignSuggestionRange(finding(4, 4), FILE, ALL).kind).toBe("unchanged");
  });

  it("extends the range over duplicated leading lines", () => {
    // Widened to the loop, still anchored on the body line.
    const f = finding(4, 5, "  for (const item of items) {\n    sum += item.price * item.quantity;\n  }");
    const aligned = alignSuggestionRange(f, FILE, ALL);
    expect(aligned).toEqual({
      kind: "extended",
      finding: { ...f, startLine: 3, endLine: 5 },
      from: { startLine: 4, endLine: 5 },
    });
    expect(apply(FILE, f)).not.toBe(FIXED); // the bug: `for` twice
    expect(apply(FILE, aligned.finding)).toBe(FIXED);
  });

  it("extends the range over duplicated trailing lines", () => {
    const f = finding(3, 4, "  for (const item of items) {\n    sum += item.price * item.quantity;\n  }\n  return sum;");
    const aligned = alignSuggestionRange(f, FILE, ALL);
    expect(aligned).toMatchObject({ kind: "extended", finding: { startLine: 3, endLine: 6 } });
    expect(apply(FILE, aligned.finding)).toBe(FIXED);
  });

  it("extends both ends of a whole-function suggestion anchored on one line", () => {
    const f = finding(4, 4, FIXED.split("\n").slice(0, 7).join("\n"));
    const aligned = alignSuggestionRange(f, FILE, ALL);
    expect(aligned.finding).toMatchObject({ startLine: 1, endLine: 7 });
    expect(apply(FILE, aligned.finding)).toBe(FIXED);
  });

  it("doesn't treat an unchanged first or last line, or blank lines, as a repeat", () => {
    // Line 4 is kept unchanged inside a 4..5 replacement: no line above is repeated.
    const keepsFirst = finding(4, 5, "    sum += item.price;\n    count++;\n  }");
    expect(alignSuggestionRange(keepsFirst, FILE, ALL).kind).toBe("unchanged");
    // A trailing blank line matches the blank line 8 but repeats nothing meaningful.
    const blank = finding(7, 7, "}\n");
    expect(alignSuggestionRange(blank, FILE, [new Set([7, 8])]).kind).toBe("unchanged");
  });

  it("drops the suggestion and keeps the body when the extended range leaves the hunk", () => {
    const f = finding(4, 5, "  for (const item of items) {\n    sum += item.price * item.quantity;\n  }");
    // Line 3 is outside the diff hunk, so the range can't cover it.
    const aligned = alignSuggestionRange(f, FILE, [new Set([4, 5, 6, 7])]);
    expect(aligned.kind).toBe("dropped");
    expect(aligned.finding).toMatchObject({ startLine: 4, endLine: 5, body: f.body });
    expect(aligned.finding.suggestion).toBeUndefined();
  });

  it("only extends within a single hunk of the real diff", () => {
    const diff = [
      "diff --git a/src/total.js b/src/total.js",
      "--- a/src/total.js",
      "+++ b/src/total.js",
      "@@ -1,3 +1,3 @@",
      " function total(items) {",
      "-  let sum = 1;",
      "+  let sum = 0;",
      "   for (const item of items) {",
      "@@ -4,4 +4,4 @@",
      "-    sum += item.cost;",
      "+    sum += item.price;",
      "   }",
      "   return sum;",
      " }",
    ].join("\n");
    const hunks = hunkLineSets(parseDiff(diff)[0]!);
    const crossing = finding(4, 4, "  for (const item of items) {\n    sum += item.price * item.quantity;");
    expect(alignSuggestionRange(crossing, FILE, hunks).kind).toBe("dropped");
    const inside = finding(4, 4, "    sum += item.price * item.quantity;\n  }");
    expect(alignSuggestionRange(inside, FILE, hunks).finding).toMatchObject({ startLine: 4, endLine: 5 });
  });
});
