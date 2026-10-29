import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDiff, unquotePath, type DiffFile } from "./diff.js";

const fixture = (name: string) =>
  parseDiff(readFileSync(new URL(`../test/fixtures/${name}.diff`, import.meta.url), "utf8"));

function byPath(files: DiffFile[], path: string): DiffFile {
  const file = files.find((f) => f.path === path);
  if (!file) throw new Error(`no file ${path}`);
  return file;
}

describe("parseDiff", () => {
  it("parses modified files into hunks with old/new line numbers", () => {
    const files = fixture("basic");
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["src/app.ts", "modified"],
      ["src/new.ts", "added"],
      ["src/old.ts", "deleted"],
      ["src/tail.txt", "modified"],
    ]);

    const app = byPath(files, "src/app.ts");
    expect(app.oldPath).toBe("src/app.ts");
    expect(app.additions).toBe(2);
    expect(app.deletions).toBe(3);
    expect(app.hunks).toHaveLength(2);

    const [first, second] = app.hunks;
    expect(first).toMatchObject({ oldStart: 1, oldLines: 6, newStart: 1, newLines: 6 });
    expect(first?.lines.slice(1, 4)).toEqual([
      { type: "context", content: "line 2", oldLine: 2, newLine: 2 },
      { type: "del", content: "line 3", oldLine: 3, newLine: null },
      { type: "add", content: "line three", oldLine: null, newLine: 3 },
    ]);
    expect(second).toMatchObject({
      header: "@@ -22,9 +22,8 @@ line 21",
      oldStart: 22,
      newStart: 22,
    });
    expect(second?.lines.find((l) => l.content === "line twenty-five")).toMatchObject({
      newLine: 25,
    });
    expect(second?.lines.find((l) => l.content === "line 27")).toMatchObject({
      type: "del",
      oldLine: 27,
    });
    // Line 28 shifts up by one after the deletion.
    expect(second?.lines.find((l) => l.content === "line 28")).toMatchObject({
      oldLine: 28,
      newLine: 27,
    });
  });

  it("handles added and deleted files", () => {
    const files = fixture("basic");
    const added = byPath(files, "src/new.ts");
    expect(added.oldPath).toBeNull();
    expect(added.newMode).toBe("100644");
    expect(added.hunks[0]?.lines.map((l) => l.newLine)).toEqual([1, 2]);

    const deleted = byPath(files, "src/old.ts");
    expect(deleted.oldPath).toBe("src/old.ts");
    expect(deleted.deletions).toBe(2);
    expect(deleted.hunks[0]?.lines.every((l) => l.type === "del" && l.newLine === null)).toBe(true);
  });

  it("marks lines followed by '\\ No newline at end of file'", () => {
    const tail = byPath(fixture("basic"), "src/tail.txt");
    const lines = tail.hunks[0]?.lines ?? [];
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ type: "del", content: "no newline", noNewlineAtEof: true });
    expect(lines[2]).toMatchObject({
      type: "add",
      content: "now has more",
      newLine: 2,
      noNewlineAtEof: true,
    });
  });

  it("keeps each file's raw patch", () => {
    const added = byPath(fixture("basic"), "src/new.ts");
    expect(added.patch.split("\n")[0]).toBe("diff --git a/src/new.ts b/src/new.ts");
    expect(added.patch).toContain("+export const two = 2;");
    expect(added.patch).not.toContain("src/old.ts");
  });

  it("handles renames, copies, binary files and mode changes", () => {
    const files = fixture("renames-binary");

    const renamed = byPath(files, "new name ä.txt");
    expect(renamed).toMatchObject({
      status: "renamed",
      oldPath: "old.txt",
      similarity: 100,
      binary: false,
    });
    expect(renamed.hunks).toEqual([]);

    const copied = byPath(files, "copy.txt");
    expect(copied).toMatchObject({ status: "copied", oldPath: "big.txt", similarity: 54 });
    expect(copied.hunks).toHaveLength(1);

    const binary = byPath(files, "bin.dat");
    expect(binary).toMatchObject({ status: "modified", binary: true, hunks: [] });

    const newBinary = byPath(files, "newbin.bin");
    expect(newBinary).toMatchObject({ status: "added", binary: true, oldPath: null });

    const mode = byPath(files, "mode.sh");
    expect(mode).toMatchObject({
      status: "modified",
      oldMode: "100644",
      newMode: "100755",
      hunks: [],
    });

    expect(byPath(files, "gone.txt").status).toBe("deleted");
  });

  it("handles renames with edits and content lines that look like headers", () => {
    const files = fixture("tricky");
    const renamed = byPath(files, "after.txt");
    expect(renamed).toMatchObject({ status: "renamed", oldPath: "before.txt", similarity: 89 });
    expect(renamed.hunks[0]?.lines.find((l) => l.type === "add")).toMatchObject({
      content: "FIVE",
      newLine: 5,
    });

    const sql = byPath(files, "query.sql");
    expect(sql.hunks[0]?.lines).toEqual([
      { type: "del", content: "-- seed comment", oldLine: 1, newLine: null },
      { type: "context", content: "SELECT 1;", oldLine: 2, newLine: 1 },
      { type: "context", content: "++counter;", oldLine: 3, newLine: 2 },
      { type: "add", content: "++more;", oldLine: null, newLine: 3 },
    ]);
  });

  it("accepts context lines whose trailing space was stripped, CRLF and plain unified diffs", () => {
    const diff = [
      "--- a/x.txt\t2026-10-04 10:00:00",
      "+++ b/x.txt\t2026-10-04 10:00:01",
      "@@ -1,3 +1,3 @@",
      " one",
      "",
      "-three",
      "+THREE",
      "--- a/y.txt",
      "+++ b/y.txt",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\r\n");
    const files = parseDiff(diff);
    expect(files.map((f) => f.path)).toEqual(["x.txt", "y.txt"]);
    expect(files[0]?.hunks[0]?.lines[1]).toEqual({
      type: "context",
      content: "",
      oldLine: 2,
      newLine: 2,
    });
    expect(files[0]?.hunks[0]?.lines[3]).toMatchObject({
      type: "add",
      content: "THREE",
      newLine: 3,
    });
    expect(files[1]?.hunks[0]).toMatchObject({ oldLines: 1, newLines: 1 });
  });

  it("returns no files for an empty diff", () => {
    expect(parseDiff("")).toEqual([]);
    expect(parseDiff("\n")).toEqual([]);
  });

  it("splits unquoted header paths containing spaces", () => {
    const files = parseDiff(
      "diff --git a/my file.txt b/my file.txt\nold mode 100644\nnew mode 100755\n",
    );
    expect(files[0]).toMatchObject({ path: "my file.txt", oldPath: "my file.txt" });
  });
});

describe("unquotePath", () => {
  it("decodes git's octal UTF-8 escapes and C escapes", () => {
    expect(unquotePath('"caf\\303\\251 \\"q\\"\\t.txt"')).toBe('café "q"\t.txt');
    expect(unquotePath("plain.txt")).toBe("plain.txt");
  });
});
