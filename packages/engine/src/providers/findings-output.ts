import { Finding, FindingList } from "@omniralph/shared";
import type { DiffFile } from "../diff.js";

export type ParsedOutput =
  | { ok: true; findings: Finding[] }
  /** `items` is set when the JSON shape was right but some items are invalid. */
  | { ok: false; error: string; items?: unknown[] };

/** The last fenced code block, else the text from the first `[`/`{` to the last `]`/`}`. */
function jsonCandidate(text: string): string | null {
  const fences = [...text.matchAll(/```(?:json)?[^\S\n]*\n([\s\S]*?)```/g)];
  const fenced = fences.at(-1)?.[1];
  if (fenced !== undefined) return fenced.trim();
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf("]"), text.lastIndexOf("}"));
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

function findingItems(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (
    value &&
    typeof value === "object" &&
    Array.isArray((value as { findings?: unknown }).findings)
  ) {
    return (value as { findings: unknown[] }).findings;
  }
  return null;
}

/** Parses the model's final answer: `{"findings": [...]}` or a bare array, optionally fenced. */
export function parseFindingsOutput(text: string): ParsedOutput {
  const candidate = jsonCandidate(text);
  if (candidate === null) return { ok: false, error: "The answer contains no JSON." };
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch (err) {
    return { ok: false, error: `The answer is not valid JSON: ${(err as Error).message}` };
  }
  const items = findingItems(value);
  if (!items) return { ok: false, error: 'Expected an object {"findings": [...]}.' };
  const parsed = FindingList.safeParse(items);
  if (parsed.success) return { ok: true, findings: parsed.data };
  const issues = parsed.error.issues.slice(0, 20).map((issue) => {
    const [index, ...rest] = issue.path;
    const field = rest.map((key) => `.${String(key)}`).join("");
    return `findings[${String(index)}]${field}: ${issue.message}`;
  });
  return { ok: false, error: `Invalid findings:\n${issues.join("\n")}`, items };
}

/** Keeps the valid items; returns how many were dropped. */
export function validFindings(items: readonly unknown[]): {
  findings: Finding[];
  invalid: unknown[];
} {
  const findings: Finding[] = [];
  const invalid: unknown[] = [];
  for (const item of items) {
    const parsed = Finding.safeParse(item);
    if (parsed.success) findings.push(parsed.data);
    else invalid.push(item);
  }
  return { findings, invalid };
}

/**
 * Salvages complete finding objects from text that may be cut off (budget
 * abort) or malformed: every balanced `{…}` (outside strings) that parses as
 * a valid `Finding`.
 */
export function extractPartialFindings(text: string): Finding[] {
  const findings: Finding[] = [];
  const starts: number[] = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      starts.push(i);
    } else if (ch === "}") {
      const start = starts.pop();
      if (start === undefined) continue;
      try {
        const parsed = Finding.safeParse(JSON.parse(text.slice(start, i + 1)));
        if (parsed.success) findings.push(parsed.data);
      } catch {
        // not JSON
      }
    }
  }
  return findings;
}

/**
 * Commentable lines per file: head-side lines (added or context) of each hunk,
 * base-side lines for deleted files. A finding must fit inside one hunk.
 */
function hunkLineSets(file: DiffFile): Set<number>[] {
  const deleted = file.status === "deleted";
  return file.hunks.map((hunk) => {
    const lines = new Set<number>();
    for (const line of hunk.lines) {
      const n = deleted ? line.oldLine : line.newLine;
      if (n !== null) lines.add(n);
    }
    return lines;
  });
}

export function filterToDiff(
  findings: readonly Finding[],
  files: readonly DiffFile[],
): { inside: Finding[]; outside: Finding[] } {
  const byPath = new Map(files.map((file) => [file.path, hunkLineSets(file)]));
  const inside: Finding[] = [];
  const outside: Finding[] = [];
  for (const finding of findings) {
    const hunks = byPath.get(finding.path) ?? [];
    const fits = hunks.some((lines) => {
      if (finding.endLine - finding.startLine >= lines.size) return false;
      for (let n = finding.startLine; n <= finding.endLine; n++) if (!lines.has(n)) return false;
      return true;
    });
    (fits ? inside : outside).push(finding);
  }
  return { inside, outside };
}
