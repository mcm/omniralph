import { describe, expect, it } from "vitest";
import { lineDiff } from "./line-diff";

describe("lineDiff", () => {
  it("has no patch for equal texts", () => {
    expect(lineDiff("a\nb", "a\nb")).toEqual({
      additions: 0,
      deletions: 0,
      patch: null,
      truncated: false,
    });
  });

  it("writes one hunk for a changed line, with its context", () => {
    const diff = lineDiff("a\nb\nc\nd", "a\nB\nc\nd");
    expect(diff).toMatchObject({ additions: 1, deletions: 1, truncated: false });
    expect(diff.patch).toBe(["@@ -1,4 +1,4 @@", " a", "-b", "+B", " c", " d"].join("\n"));
  });

  it("keeps three lines of context and splits changes far apart into hunks", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const after = [...before];
    after[1] = "changed 2";
    after[17] = "changed 18";
    const patch = lineDiff(before.join("\n"), after.join("\n")).patch!;
    const headers = patch.split("\n").filter((line) => line.startsWith("@@"));
    expect(headers).toEqual(["@@ -1,5 +1,5 @@", "@@ -15,6 +15,6 @@"]);
  });

  it("diffs a first text against an empty one as all additions", () => {
    expect(lineDiff("", "a\nb")).toEqual({
      additions: 2,
      deletions: 0,
      patch: "@@ -0,0 +1,2 @@\n+a\n+b",
      truncated: false,
    });
  });

  it("only counts lines of texts too long to compare", () => {
    const long = (prefix: string) =>
      Array.from({ length: 2100 }, (_, i) => `${prefix} ${i}`).join("\n");
    expect(lineDiff(long("a"), long("b"))).toEqual({
      additions: 2100,
      deletions: 2100,
      patch: null,
      truncated: true,
    });
  });
});
