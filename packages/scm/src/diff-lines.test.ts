import { describe, expect, it } from "vitest";
import { buildDiffLineIndex, isCommentInDiff, parsePatchLines } from "./diff-lines.js";

const PATCH = [
  "@@ -1,3 +1,4 @@",
  " line one",
  "-old two",
  "+new two",
  "+new three",
  " line four",
  "@@ -20,2 +21,3 @@ function foo() {",
  " ctx",
  "+added",
  " ctx",
  "\\ No newline at end of file",
].join("\n");

describe("parsePatchLines", () => {
  it("maps new- and old-side lines to their hunks", () => {
    const lines = parsePatchLines(PATCH);
    expect([...lines.new.entries()]).toEqual([
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 0],
      [21, 1],
      [22, 1],
      [23, 1],
    ]);
    expect([...lines.old.entries()]).toEqual([
      [1, 0],
      [2, 0],
      [3, 0],
      [20, 1],
      [21, 1],
    ]);
  });
});

describe("isCommentInDiff", () => {
  const index = buildDiffLineIndex([
    { path: "a.ts", patch: PATCH },
    { path: "binary.png", patch: null },
  ]);

  it("accepts lines in the diff on the requested side", () => {
    expect(isCommentInDiff(index, { path: "a.ts", line: 3, body: "" })).toBe(true);
    expect(isCommentInDiff(index, { path: "a.ts", line: 2, side: "old", body: "" })).toBe(true);
    expect(isCommentInDiff(index, { path: "a.ts", line: 20, side: "old", body: "" })).toBe(true);
  });

  it("rejects lines outside the diff, unknown files and patchless files", () => {
    expect(isCommentInDiff(index, { path: "a.ts", line: 10, body: "" })).toBe(false);
    expect(isCommentInDiff(index, { path: "a.ts", line: 20, body: "" })).toBe(false);
    expect(isCommentInDiff(index, { path: "other.ts", line: 1, body: "" })).toBe(false);
    expect(isCommentInDiff(index, { path: "binary.png", line: 1, body: "" })).toBe(false);
  });

  it("requires multi-line ranges to stay within one hunk", () => {
    expect(isCommentInDiff(index, { path: "a.ts", startLine: 2, line: 4, body: "" })).toBe(true);
    expect(isCommentInDiff(index, { path: "a.ts", startLine: 4, line: 22, body: "" })).toBe(false);
    expect(isCommentInDiff(index, { path: "a.ts", startLine: 5, line: 3, body: "" })).toBe(false);
  });
});
