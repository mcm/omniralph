import { createHash } from "node:crypto";
import type { InlineComment } from "../types.js";

/** `diff_refs` of a merge request (or one of its diff versions). */
export interface DiffRefs {
  baseSha: string;
  startSha: string;
  headSha: string;
}

/** One file of a merge request diff, as returned by GitLab's diff endpoints. */
export interface GitLabDiffFile {
  old_path: string;
  new_path: string;
  new_file?: boolean;
  deleted_file?: boolean;
  /** Hunks only (`@@ … @@`), without `---`/`+++` headers. */
  diff: string;
}

/** A diff line that can carry a comment. */
export interface DiffLine {
  type: "add" | "del" | "context";
  /** Base-side line number; `null` for added lines. */
  oldLine: number | null;
  /** Head-side line number; `null` for deleted lines. */
  newLine: number | null;
  /** Running old/new counters, as GitLab uses them in `line_code`. */
  oldPos: number;
  newPos: number;
  hunk: number;
}

export interface FileLines {
  oldPath: string;
  newPath: string;
  new: Map<number, DiffLine>;
  old: Map<number, DiffLine>;
}

/** The `position` GitLab expects when creating a diff discussion. */
export interface TextPosition {
  position_type: "text";
  base_sha: string;
  start_sha: string;
  head_sha: string;
  old_path: string;
  new_path: string;
  new_line?: number;
  old_line?: number;
  line_range?: { start: LineRangeEnd; end: LineRangeEnd };
}

interface LineRangeEnd {
  line_code: string;
  type?: "new" | "old";
  old_line?: number;
  new_line?: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parses one file's hunks into commentable lines on both sides. */
export function parseFileLines(file: GitLabDiffFile): FileLines {
  const result: FileLines = {
    oldPath: file.old_path,
    newPath: file.new_path,
    new: new Map(),
    old: new Map(),
  };
  let hunk = -1;
  let oldPos = 0;
  let newPos = 0;
  const rows = file.diff.split("\n");
  if (rows.at(-1) === "") rows.pop();
  for (const raw of rows) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      hunk += 1;
      oldPos = Number(header[1]);
      newPos = Number(header[2]);
      continue;
    }
    if (hunk < 0 || raw.startsWith("\\")) continue;
    if (raw.startsWith("+")) {
      result.new.set(newPos, { type: "add", oldLine: null, newLine: newPos, oldPos, newPos, hunk });
      newPos += 1;
    } else if (raw.startsWith("-")) {
      result.old.set(oldPos, { type: "del", oldLine: oldPos, newLine: null, oldPos, newPos, hunk });
      oldPos += 1;
    } else if (raw.startsWith(" ") || raw === "") {
      const line: DiffLine = {
        type: "context",
        oldLine: oldPos,
        newLine: newPos,
        oldPos,
        newPos,
        hunk,
      };
      result.new.set(newPos, line);
      result.old.set(oldPos, line);
      oldPos += 1;
      newPos += 1;
    }
  }
  return result;
}

/** Commentable lines per path (head path, plus the base path of deleted files). */
export type GitLabDiffIndex = Map<string, FileLines>;

export function buildGitLabDiffIndex(files: GitLabDiffFile[]): GitLabDiffIndex {
  const index: GitLabDiffIndex = new Map();
  for (const file of files) {
    const lines = parseFileLines(file);
    index.set(file.deleted_file ? file.old_path : file.new_path, lines);
  }
  return index;
}

/** GitLab's `line_code`: `sha1(path)_oldPos_newPos`. */
export function lineCode(path: string, line: DiffLine): string {
  return `${createHash("sha1").update(path).digest("hex")}_${line.oldPos}_${line.newPos}`;
}

function lineFields(line: DiffLine): { old_line?: number; new_line?: number } {
  return {
    ...(line.oldLine === null ? {} : { old_line: line.oldLine }),
    ...(line.newLine === null ? {} : { new_line: line.newLine }),
  };
}

function rangeEnd(file: FileLines, line: DiffLine): LineRangeEnd {
  const type = line.type === "add" ? "new" : line.type === "del" ? "old" : undefined;
  return {
    line_code: lineCode(file.newPath, line),
    ...(type ? { type } : {}),
    ...lineFields(line),
  };
}

/**
 * Builds a text position for an inline comment, or `null` when its lines
 * aren't in the diff. Added lines get only `new_line`, deleted lines only
 * `old_line`, and unchanged (context) lines both, as GitLab requires.
 * Multi-line comments must stay within one hunk and get a `line_range`.
 */
export function buildPosition(
  index: GitLabDiffIndex,
  refs: DiffRefs,
  comment: InlineComment,
): TextPosition | null {
  const file = index.get(comment.path);
  if (!file) return null;
  const lines = comment.side === "old" ? file.old : file.new;
  const end = lines.get(comment.line);
  if (!end) return null;

  const position: TextPosition = {
    position_type: "text",
    base_sha: refs.baseSha,
    start_sha: refs.startSha,
    head_sha: refs.headSha,
    old_path: file.oldPath,
    new_path: file.newPath,
    ...lineFields(end),
  };
  if (comment.startLine === undefined || comment.startLine === comment.line) return position;
  if (comment.startLine > comment.line) return null;

  for (let n = comment.startLine; n < comment.line; n++) {
    if (lines.get(n)?.hunk !== end.hunk) return null;
  }
  const start = lines.get(comment.startLine);
  if (!start) return null;
  position.line_range = { start: rangeEnd(file, start), end: rangeEnd(file, end) };
  return position;
}
