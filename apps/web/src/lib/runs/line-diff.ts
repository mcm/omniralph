/**
 * A line diff of two texts as unified hunks (`@@ -a,b +c,d @@` then ` `, `-` and `+` lines),
 * the shape `DiffView` of `@omniralph/ui` shows. A plain longest-common-subsequence diff: the
 * texts it compares (a triage round's draft against the previous round's) are short.
 */

/** The diff of two texts: lines added and removed, and the hunks (null when equal). */
export interface LineDiff {
  additions: number;
  deletions: number;
  /** Unified hunks; null when the texts are equal, or when they're too long to compare. */
  patch: string | null;
  /** The texts were too long to compare line by line: only the counts of lines are known. */
  truncated: boolean;
}

/** Most line pairs the diff compares (the LCS table's size); longer texts aren't diffed. */
const MAX_CELLS = 4_000_000;
/** Unchanged lines kept around each change. */
const CONTEXT = 3;

type Op = { kind: " " | "-" | "+"; line: string };

const splitLines = (text: string): string[] => (text === "" ? [] : text.split("\n"));

/** The edit script turning `a` into `b`, from the LCS table, removals before additions. */
function editScript(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j]: the longest common subsequence of a[i..] and b[j..].
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i]! });
      i++;
      j++;
    } else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      ops.push({ kind: "-", line: a[i]! });
      i++;
    } else {
      ops.push({ kind: "+", line: b[j]! });
      j++;
    }
  }
  return ops;
}

/** The edit script's hunks: each run of changes with up to `CONTEXT` unchanged lines around it. */
function hunks(ops: readonly Op[]): string {
  const changed = ops.flatMap((op, index) => (op.kind === " " ? [] : [index]));
  const out: string[] = [];
  let k = 0;
  while (k < changed.length) {
    const start = Math.max(0, changed[k]! - CONTEXT);
    let end = changed[k]!;
    // Join the next change while the unchanged lines between them fit both contexts.
    while (k + 1 < changed.length && changed[k + 1]! - end <= 2 * CONTEXT + 1) end = changed[++k]!;
    k++;
    const last = Math.min(ops.length - 1, end + CONTEXT);
    // Line numbers (1-based) where the hunk starts in each text.
    let oldLine = 1;
    let newLine = 1;
    for (const op of ops.slice(0, start)) {
      if (op.kind !== "+") oldLine++;
      if (op.kind !== "-") newLine++;
    }
    const body = ops.slice(start, last + 1);
    const oldCount = body.filter((op) => op.kind !== "+").length;
    const newCount = body.filter((op) => op.kind !== "-").length;
    out.push(
      `@@ -${oldCount === 0 ? oldLine - 1 : oldLine},${oldCount} +${newCount === 0 ? newLine - 1 : newLine},${newCount} @@`,
      ...body.map((op) => `${op.kind}${op.line}`),
    );
  }
  return out.join("\n");
}

/** The line diff turning `before` into `after`. */
export function lineDiff(before: string, after: string): LineDiff {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length * b.length > MAX_CELLS) {
    return { additions: b.length, deletions: a.length, patch: null, truncated: true };
  }
  const ops = editScript(a, b);
  const additions = ops.filter((op) => op.kind === "+").length;
  const deletions = ops.filter((op) => op.kind === "-").length;
  return {
    additions,
    deletions,
    patch: additions + deletions === 0 ? null : hunks(ops),
    truncated: false,
  };
}
