import { describe, expect, it } from "vitest";
import { capPatch, countPatchLines, MAX_PATCH_LINES, maxFilesOf } from "./commit-diff.js";

describe("capPatch", () => {
  it("keeps a short patch whole, without its trailing newline", () => {
    expect(capPatch("@@ -1 +1 @@\n-a\n+b\n")).toEqual({
      patch: "@@ -1 +1 @@\n-a\n+b",
      truncated: false,
    });
  });

  it("cuts a long patch to MAX_PATCH_LINES lines", () => {
    const lines = Array.from({ length: MAX_PATCH_LINES + 1 }, (_, i) => `+${i}`);
    const capped = capPatch(lines.join("\n"));
    expect(capped.truncated).toBe(true);
    expect(capped.patch.split("\n")).toEqual(lines.slice(0, MAX_PATCH_LINES));
    expect(capPatch(lines.slice(1).join("\n")).truncated).toBe(false);
  });
});

describe("countPatchLines", () => {
  it("counts added and removed lines, not context or markers", () => {
    expect(
      countPatchLines("@@ -1,3 +1,3 @@\n a\n-b\n+c\n+d\n\\ No newline at end of file"),
    ).toEqual({ additions: 2, deletions: 1 });
  });
});

describe("maxFilesOf", () => {
  it("defaults to 100 and is at least 1", () => {
    expect(maxFilesOf(undefined)).toBe(100);
    expect(maxFilesOf({ maxFiles: 0 })).toBe(1);
    expect(maxFilesOf({ maxFiles: 7 })).toBe(7);
  });
});
