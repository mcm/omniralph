import type { DiffSide, InlineComment } from "./types.js";

/**
 * Lines of one file that can carry an inline comment, keyed by line number
 * with the index of the hunk they belong to (multi-line comments must stay
 * within one hunk).
 */
export interface CommentableLines {
  new: Map<number, number>;
  old: Map<number, number>;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parses a unified-diff patch (one file, as returned by code-host APIs). */
export function parsePatchLines(patch: string): CommentableLines {
  const lines: CommentableLines = { new: new Map(), old: new Map() };
  let hunk = -1;
  let oldLine = 0;
  let newLine = 0;
  const rows = patch.split("\n");
  if (rows.at(-1) === "") rows.pop();
  for (const raw of rows) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      hunk += 1;
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      continue;
    }
    if (hunk < 0 || raw.startsWith("\\")) continue;
    if (raw.startsWith("+")) {
      lines.new.set(newLine++, hunk);
    } else if (raw.startsWith("-")) {
      lines.old.set(oldLine++, hunk);
    } else if (raw.startsWith(" ") || raw === "") {
      // Context line (some tools strip the leading space of blank ones).
      lines.new.set(newLine++, hunk);
      lines.old.set(oldLine++, hunk);
    }
  }
  return lines;
}

/** Commentable lines per file path. */
export type DiffLineIndex = Map<string, CommentableLines>;

export function buildDiffLineIndex(
  files: { path: string; patch?: string | null }[],
): DiffLineIndex {
  const index: DiffLineIndex = new Map();
  for (const file of files) {
    if (file.patch) index.set(file.path, parsePatchLines(file.patch));
  }
  return index;
}

/** Whether an inline comment's whole range is inside a single diff hunk. */
export function isCommentInDiff(index: DiffLineIndex, comment: InlineComment): boolean {
  const side: DiffSide = comment.side ?? "new";
  const lines = index.get(comment.path)?.[side];
  if (!lines) return false;
  const endHunk = lines.get(comment.line);
  if (endHunk === undefined) return false;
  if (comment.startLine === undefined || comment.startLine === comment.line) return true;
  if (comment.startLine > comment.line) return false;
  for (let n = comment.startLine; n < comment.line; n++) {
    if (lines.get(n) !== endHunk) return false;
  }
  return true;
}
