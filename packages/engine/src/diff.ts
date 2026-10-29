/**
 * Unified diff parser for `git diff base...head` output (default `a/`/`b/`
 * prefixes). Plain `diff -u` output without `diff --git` headers also works.
 */

export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied";

export type DiffLineType = "add" | "del" | "context";

export interface DiffLine {
  type: DiffLineType;
  /** Line text without the leading `+`/`-`/space marker. */
  content: string;
  /** Line number in the base file; null for added lines. */
  oldLine: number | null;
  /** Line number in the head file; null for deleted lines. */
  newLine: number | null;
  /** True when followed by `\ No newline at end of file`. */
  noNewlineAtEof?: boolean;
}

export interface DiffHunk {
  /** The full `@@ -a,b +c,d @@ section` line. */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffFile {
  /** Head-side path (the base path for deleted files). */
  path: string;
  /** Base-side path; differs from `path` for renames and copies, null for added files. */
  oldPath: string | null;
  status: DiffFileStatus;
  binary: boolean;
  /** Present when the file mode changed (e.g. `100755`). */
  oldMode?: string;
  newMode?: string;
  /** Similarity index for renames and copies (0–100). */
  similarity?: number;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  /** This file's section of the raw diff, used for token estimates and prompts. */
  patch: string;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DEV_NULL = "/dev/null";

interface FileBuilder {
  lines: string[];
  headerOld?: string;
  headerNew?: string;
  minusPath?: string;
  plusPath?: string;
  renameFrom?: string;
  renameTo?: string;
  copyFrom?: string;
  copyTo?: string;
  isNew: boolean;
  isDeleted: boolean;
  binary: boolean;
  oldMode?: string;
  newMode?: string;
  similarity?: number;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

function newBuilder(): FileBuilder {
  return {
    lines: [],
    isNew: false,
    isDeleted: false,
    binary: false,
    hunks: [],
    additions: 0,
    deletions: 0,
  };
}

export function parseDiff(diff: string): DiffFile[] {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();

  const files: DiffFile[] = [];
  let file: FileBuilder | null = null;
  let hunk: DiffHunk | null = null;
  let oldRemaining = 0;
  let newRemaining = 0;
  let oldLine = 0;
  let newLine = 0;

  const finish = () => {
    if (file) files.push(buildFile(file));
    file = null;
    hunk = null;
    oldRemaining = newRemaining = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const inHunk = hunk !== null && (oldRemaining > 0 || newRemaining > 0);

    if (inHunk && hunk) {
      const current: DiffHunk = hunk;
      // Some tools strip the trailing space of empty context lines.
      const marker = line === "" ? " " : line[0];
      const content = line.slice(1);
      if (marker === " " && oldRemaining > 0 && newRemaining > 0) {
        current.lines.push({ type: "context", content, oldLine: oldLine++, newLine: newLine++ });
        oldRemaining--;
        newRemaining--;
        file?.lines.push(line);
        continue;
      }
      if (marker === "-" && oldRemaining > 0) {
        current.lines.push({ type: "del", content, oldLine: oldLine++, newLine: null });
        oldRemaining--;
        if (file) file.deletions++;
        file?.lines.push(line);
        continue;
      }
      if (marker === "+" && newRemaining > 0) {
        current.lines.push({ type: "add", content, oldLine: null, newLine: newLine++ });
        newRemaining--;
        if (file) file.additions++;
        file?.lines.push(line);
        continue;
      }
      if (marker === "\\") {
        markNoNewline(current);
        file?.lines.push(line);
        continue;
      }
      // Malformed hunk (counts don't match the body): fall through to headers.
      oldRemaining = newRemaining = 0;
    }

    if (line.startsWith("\\") && hunk) {
      markNoNewline(hunk);
      file?.lines.push(line);
      continue;
    }

    if (line.startsWith("diff --git ")) {
      finish();
      file = newBuilder();
      file.lines.push(line);
      const paths = parseGitHeaderPaths(line.slice("diff --git ".length));
      if (paths) {
        file.headerOld = paths[0];
        file.headerNew = paths[1];
      }
      continue;
    }

    // A `---`/`+++` pair starts a new file in plain unified diffs, or after a
    // file that already has hunks.
    if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      const current: FileBuilder | null = file;
      if (!current || current.hunks.length > 0 || current.minusPath !== undefined) {
        finish();
        file = newBuilder();
      }
      const target = file as FileBuilder | null;
      if (target) {
        target.minusPath = parseMarkerPath(line.slice(4), "a/");
        target.plusPath = parseMarkerPath((lines[i + 1] ?? "").slice(4), "b/");
        target.lines.push(line, lines[i + 1] ?? "");
      }
      i++;
      continue;
    }

    const header = HUNK_HEADER.exec(line);
    if (header && file) {
      const target: FileBuilder = file;
      const next: DiffHunk = {
        header: line,
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      target.hunks.push(next);
      target.lines.push(line);
      hunk = next;
      oldRemaining = next.oldLines;
      newRemaining = next.newLines;
      oldLine = next.oldStart;
      newLine = next.newStart;
      continue;
    }

    if (!file) continue; // preamble (e.g. commit message) before the first file
    const target: FileBuilder = file;
    target.lines.push(line);
    parseExtendedHeader(target, line);
  }
  finish();
  return files;
}

function markNoNewline(hunk: DiffHunk): void {
  const last = hunk.lines.at(-1);
  if (last) last.noNewlineAtEof = true;
}

function parseExtendedHeader(file: FileBuilder, line: string): void {
  let m: RegExpExecArray | null;
  if ((m = /^new file mode (\d+)/.exec(line))) {
    file.isNew = true;
    file.newMode = m[1];
  } else if ((m = /^deleted file mode (\d+)/.exec(line))) {
    file.isDeleted = true;
    file.oldMode = m[1];
  } else if ((m = /^old mode (\d+)/.exec(line))) {
    file.oldMode = m[1];
  } else if ((m = /^new mode (\d+)/.exec(line))) {
    file.newMode = m[1];
  } else if ((m = /^(?:similarity|dissimilarity) index (\d+)%/.exec(line))) {
    file.similarity = Number(m[1]);
  } else if (line.startsWith("rename from ")) {
    file.renameFrom = unquotePath(line.slice("rename from ".length));
  } else if (line.startsWith("rename to ")) {
    file.renameTo = unquotePath(line.slice("rename to ".length));
  } else if (line.startsWith("copy from ")) {
    file.copyFrom = unquotePath(line.slice("copy from ".length));
  } else if (line.startsWith("copy to ")) {
    file.copyTo = unquotePath(line.slice("copy to ".length));
  } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
    file.binary = true;
  }
}

function buildFile(b: FileBuilder): DiffFile {
  const minus = b.minusPath === DEV_NULL ? null : b.minusPath;
  const plus = b.plusPath === DEV_NULL ? null : b.plusPath;
  const isNew = b.isNew || b.minusPath === DEV_NULL;
  const isDeleted = b.isDeleted || b.plusPath === DEV_NULL;

  let oldPath = b.renameFrom ?? b.copyFrom ?? minus ?? b.headerOld ?? null;
  let path = b.renameTo ?? b.copyTo ?? plus ?? b.headerNew ?? oldPath ?? "";
  if (b.binary && !minus && !plus) {
    // `Binary files /dev/null and b/x differ` carries the only path info.
    const binaryLine = b.lines.find((l) => l.startsWith("Binary files "));
    const m = binaryLine ? /^Binary files (.+) and (.+) differ$/.exec(binaryLine) : null;
    if (m && m[1] && m[2]) {
      if (m[1] !== DEV_NULL && !b.renameFrom) oldPath = stripPrefix(unquotePath(m[1]), "a/");
      if (m[2] !== DEV_NULL && !b.renameTo) path = stripPrefix(unquotePath(m[2]), "b/");
    }
  }

  let status: DiffFileStatus = "modified";
  if (isNew) status = "added";
  else if (isDeleted) status = "deleted";
  else if (b.renameFrom !== undefined) status = "renamed";
  else if (b.copyFrom !== undefined) status = "copied";

  if (status === "added") oldPath = null;
  if (status === "deleted") path = oldPath ?? path;

  const file: DiffFile = {
    path,
    oldPath,
    status,
    binary: b.binary,
    additions: b.additions,
    deletions: b.deletions,
    hunks: b.hunks,
    patch: b.lines.join("\n"),
  };
  if (b.oldMode !== undefined) file.oldMode = b.oldMode;
  if (b.newMode !== undefined) file.newMode = b.newMode;
  if (b.similarity !== undefined) file.similarity = b.similarity;
  return file;
}

function stripPrefix(path: string, prefix: string): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** Path after `--- `/`+++ `, without a trailing timestamp or the `a/`/`b/` prefix. */
function parseMarkerPath(raw: string, prefix: string): string {
  let value = raw;
  if (!value.startsWith('"')) {
    const tab = value.indexOf("\t");
    if (tab >= 0) value = value.slice(0, tab);
  }
  value = unquotePath(value.trimEnd());
  return value === DEV_NULL ? DEV_NULL : stripPrefix(value, prefix);
}

/** Splits `a/x b/y` (either side may be quoted, paths may contain spaces). */
function parseGitHeaderPaths(rest: string): [string, string] | null {
  if (rest.startsWith('"')) {
    const end = findClosingQuote(rest);
    if (end < 0) return null;
    const first = unquotePath(rest.slice(0, end + 1));
    const second = unquotePath(rest.slice(end + 2));
    return [stripPrefix(first, "a/"), stripPrefix(second, "b/")];
  }
  if (rest.endsWith('"')) {
    const start = rest.lastIndexOf(' "');
    if (start < 0) return null;
    return [
      stripPrefix(rest.slice(0, start), "a/"),
      stripPrefix(unquotePath(rest.slice(start + 1)), "b/"),
    ];
  }
  // Unquoted: when both sides are the same path, the split point is exact.
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === " ") {
    const a = stripPrefix(rest.slice(0, half), "a/");
    const b = stripPrefix(rest.slice(half + 1), "b/");
    if (a === b) return [a, b];
  }
  const split = rest.indexOf(" b/");
  if (split < 0) return null;
  return [stripPrefix(rest.slice(0, split), "a/"), rest.slice(split + 3)];
}

function findClosingQuote(value: string): number {
  for (let i = 1; i < value.length; i++) {
    if (value[i] === "\\") i++;
    else if (value[i] === '"') return i;
  }
  return -1;
}

const SIMPLE_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

/** Decodes git's C-style quoted paths (`"caf\303\251.txt"`); unquoted input is returned as is. */
export function unquotePath(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  const body = value.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = String.fromCodePoint(body.codePointAt(i) ?? 0);
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      i += ch.length - 1;
      continue;
    }
    const next = body[i + 1] ?? "";
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1, i + 4));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 3;
    } else {
      bytes.push(SIMPLE_ESCAPES[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}
