import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildGitLabDiffIndex,
  buildPosition,
  parseFileLines,
  type GitLabDiffFile,
} from "./positions.js";

const REFS = { baseSha: "b".repeat(40), startSha: "s".repeat(40), headSha: "h".repeat(40) };
const sha1 = (value: string) => createHash("sha1").update(value).digest("hex");

const modified: GitLabDiffFile = {
  old_path: "src/app.ts",
  new_path: "src/app.ts",
  diff: [
    "@@ -10,4 +10,5 @@ function main() {",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "+const c = 4;",
    " const d = 5;",
    " return a;",
    "@@ -40,2 +41,2 @@",
    " end();",
    "-old();",
    "+new();",
    "",
  ].join("\n"),
};

const renamed: GitLabDiffFile = {
  old_path: "lib/old-name.ts",
  new_path: "lib/new-name.ts",
  diff: "@@ -1,2 +1,2 @@\n export const x = 1;\n-export const y = 2;\n+export const y = 3;\n",
};

const deleted: GitLabDiffFile = {
  old_path: "gone.ts",
  new_path: "gone.ts",
  deleted_file: true,
  diff: "@@ -1,2 +0,0 @@\n-a\n-b\n",
};

const index = buildGitLabDiffIndex([modified, renamed, deleted]);

describe("parseFileLines", () => {
  it("maps both sides, keeping the counterpart line of context lines", () => {
    const lines = parseFileLines(modified);
    expect(lines.new.get(10)).toMatchObject({ type: "context", oldLine: 10, newLine: 10 });
    expect(lines.old.get(11)).toMatchObject({ type: "del", oldLine: 11, newLine: null });
    expect(lines.new.get(11)).toMatchObject({
      type: "add",
      oldLine: null,
      newLine: 11,
      oldPos: 12,
    });
    expect(lines.new.get(13)).toMatchObject({ type: "context", oldLine: 12, newLine: 13 });
    expect(lines.new.get(42)).toMatchObject({ type: "add", hunk: 1 });
    expect(lines.new.has(20)).toBe(false);
  });
});

describe("buildPosition", () => {
  it("gives added lines only new_line", () => {
    expect(buildPosition(index, REFS, { path: "src/app.ts", line: 11, body: "x" })).toEqual({
      position_type: "text",
      base_sha: REFS.baseSha,
      start_sha: REFS.startSha,
      head_sha: REFS.headSha,
      old_path: "src/app.ts",
      new_path: "src/app.ts",
      new_line: 11,
    });
  });

  it("gives deleted lines only old_line", () => {
    const position = buildPosition(index, REFS, {
      path: "src/app.ts",
      line: 11,
      side: "old",
      body: "x",
    });
    expect(position).toMatchObject({ old_line: 11 });
    expect(position).not.toHaveProperty("new_line");
  });

  it("gives unchanged lines both old_line and new_line", () => {
    expect(buildPosition(index, REFS, { path: "src/app.ts", line: 13, body: "x" })).toMatchObject({
      old_line: 12,
      new_line: 13,
    });
  });

  it("uses both paths of a renamed file and the base path of a deleted file", () => {
    expect(
      buildPosition(index, REFS, { path: "lib/new-name.ts", line: 2, body: "x" }),
    ).toMatchObject({
      old_path: "lib/old-name.ts",
      new_path: "lib/new-name.ts",
      new_line: 2,
    });
    expect(
      buildPosition(index, REFS, { path: "gone.ts", line: 2, side: "old", body: "x" }),
    ).toMatchObject({
      old_path: "gone.ts",
      old_line: 2,
    });
  });

  it("returns null for lines or files outside the diff", () => {
    expect(buildPosition(index, REFS, { path: "src/app.ts", line: 30, body: "x" })).toBeNull();
    expect(
      buildPosition(index, REFS, { path: "src/app.ts", line: 14, side: "old", body: "x" }),
    ).toBeNull();
    expect(buildPosition(index, REFS, { path: "other.ts", line: 1, body: "x" })).toBeNull();
  });

  it("adds a line_range for multi-line comments within one hunk", () => {
    const position = buildPosition(index, REFS, {
      path: "src/app.ts",
      startLine: 10,
      line: 12,
      body: "x",
    });
    const hash = sha1("src/app.ts");
    expect(position).toMatchObject({
      new_line: 12,
      line_range: {
        start: { line_code: `${hash}_10_10`, old_line: 10, new_line: 10 },
        end: { line_code: `${hash}_12_12`, type: "new", new_line: 12 },
      },
    });
    expect(position?.line_range?.start).not.toHaveProperty("type");
  });

  it("rejects ranges that span hunks or are reversed", () => {
    expect(
      buildPosition(index, REFS, { path: "src/app.ts", startLine: 13, line: 42, body: "x" }),
    ).toBeNull();
    expect(
      buildPosition(index, REFS, { path: "src/app.ts", startLine: 12, line: 11, body: "x" }),
    ).toBeNull();
  });
});
