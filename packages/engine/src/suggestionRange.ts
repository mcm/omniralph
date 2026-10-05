import type { Finding } from "@omniralph/shared";

export type SuggestionAlignment =
  | { kind: "unchanged"; finding: Finding }
  /** The range now covers the lines the suggestion repeated. */
  | { kind: "extended"; finding: Finding; from: { startLine: number; endLine: number } }
  /** The repeated lines lie outside the finding's hunk: the suggestion is gone, the body stays. */
  | { kind: "dropped"; finding: Finding };

const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((line, i) => line.trimEnd() === b[i]!.trimEnd());

const hasContent = (lines: readonly string[]): boolean => lines.some((line) => line.trim() !== "");

/**
 * Number of leading suggestion lines that repeat the lines right above the
 * range (largest first). Lines that also equal the range's own first lines
 * are an unchanged prefix, not a repeat, so they don't count.
 */
function repeatedAbove(suggestion: readonly string[], file: readonly string[], start: number, end: number): number {
  const original = file.slice(start - 1, end);
  for (let k = Math.min(suggestion.length, start - 1); k > 0; k--) {
    const head = suggestion.slice(0, k);
    if (!hasContent(head) || !same(head, file.slice(start - 1 - k, start - 1))) continue;
    if (same(head, original.slice(0, k))) continue;
    return k;
  }
  return 0;
}

/** Same as `repeatedAbove` for trailing suggestion lines and the lines right below the range. */
function repeatedBelow(suggestion: readonly string[], file: readonly string[], start: number, end: number): number {
  const original = file.slice(start - 1, end);
  for (let k = Math.min(suggestion.length, file.length - end); k > 0; k--) {
    const tail = suggestion.slice(suggestion.length - k);
    if (!hasContent(tail) || !same(tail, file.slice(end, end + k))) continue;
    if (same(tail, original.slice(original.length - k))) continue;
    return k;
  }
  return 0;
}

/**
 * Applying a suggestion replaces exactly startLine..endLine. When the model
 * widens a suggestion (e.g. to the whole workflow step) but keeps the
 * original range, its first lines repeat the lines above the range or its
 * last lines the lines below, and applying it duplicates them. Extends the
 * range over those lines; if the extended range leaves the finding's diff
 * hunk (`hunks`: commentable head lines per hunk), drops the suggestion.
 */
export function alignSuggestionRange(
  finding: Finding,
  fileText: string,
  hunks: readonly ReadonlySet<number>[],
): SuggestionAlignment {
  if (finding.suggestion === undefined) return { kind: "unchanged", finding };
  const file = fileText.split("\n");
  const suggestion = finding.suggestion.split("\n");
  const { startLine, endLine } = finding;
  const above = repeatedAbove(suggestion, file, startLine, endLine);
  const below = repeatedBelow(suggestion.slice(above), file, startLine, endLine);
  if (above === 0 && below === 0) return { kind: "unchanged", finding };

  const range = { startLine: startLine - above, endLine: endLine + below };
  const fits = hunks.some((lines) => {
    for (let n = range.startLine; n <= range.endLine; n++) if (!lines.has(n)) return false;
    return true;
  });
  if (fits) {
    return { kind: "extended", finding: { ...finding, ...range }, from: { startLine, endLine } };
  }
  const { suggestion: _dropped, ...rest } = finding;
  return { kind: "dropped", finding: rest };
}
