import type { Finding } from "@omniralph/shared";
import { fence } from "./prompt.js";

/**
 * A sentence that points at another finding ("…for the title finding", "see
 * the other finding"). Each finding is posted as its own comment, so such a
 * sentence only confuses, and the fix it hints at belongs in that finding.
 */
const CROSS_REFERENCE = [
  /\b(?:for|in|see|from|by|with|of|per|under|like)\s+(?:the|that|this|a|another)\s+(?:[\w`'".-]+\s+){0,4}finding\b/i,
  /\b(?:other|another|separate|previous|preceding|next|following|above|below|earlier|later|related|sibling)\s+(?:[\w`'".-]+\s+){0,2}findings?\b/i,
  /\bfindings?\s+(?:above|below|on lines?\s+\d)/i,
];

/** Removes sentences that refer to other findings (outside code blocks). Keeps the body if nothing else would remain. */
export function stripCrossReferences(finding: Finding): Finding {
  let changed = false;
  const parts = finding.body.split(/(^`{3,}[^\n]*\n[\s\S]*?^`{3,}[ \t]*$)/m);
  const stripped = parts.map((part, i) => {
    if (i % 2 === 1) return part; // fenced code block
    return part
      .split("\n")
      .map((line) => {
        const sentences = line.split(/(?<=[.!?])[ \t]+/);
        const kept = sentences.filter((s) => !CROSS_REFERENCE.some((pattern) => pattern.test(s)));
        if (kept.length !== sentences.length) changed = true;
        return kept.join(" ");
      })
      .join("\n");
  });
  if (!changed) return finding;
  const body = stripped
    .join("")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return body === "" ? finding : { ...finding, body };
}

/** Variables every runner (GitHub Actions, GitLab CI) or shell defines. */
const PREDEFINED = /^(?:GITHUB_\w+|RUNNER_\w+|ACTIONS_\w+|CI|CI_\w+|GITLAB_\w+|HOME|PATH|PWD|OLDPWD|USER|SHELL|HOSTNAME|LANG|TMPDIR|RANDOM|IFS|UID|EUID|SECONDS|LINENO|BASH\w*|OSTYPE)$/;

/** Shell text with single-quoted strings removed: the shell expands nothing inside them. */
const unquoted = (line: string): string => line.replace(/'[^'\n]*'/g, "''");

/** `$VAR` and `${VAR}` references, except `${VAR:-default}`-style ones that work when VAR is unset. */
export function variableReferences(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const shell = unquoted(line);
    for (const m of shell.matchAll(/\$\{([A-Za-z_]\w*)([^}]*)\}/g)) {
      if (!/^:?[-=+?]/.test(m[2]!)) names.add(m[1]!);
    }
    for (const m of shell.matchAll(/(?<!\$)\$([A-Za-z_]\w*)/g)) names.add(m[1]!);
  }
  return names;
}

/** Names a script or YAML text assigns: `X=…`, `export X`, `read X`, `for X in`, and `X:` keys. */
export function assignedNames(text: string): Set<string> {
  const names = new Set<string>();
  const patterns = [
    /(?:^|[\s;&|(])(?:export\s+|local\s+|declare\s+(?:-\w+\s+)*|readonly\s+)?([A-Za-z_]\w*)=(?!=)/g,
    /\b(?:export|local|readonly)\s+([A-Za-z_]\w*)\b/g,
    /\bread\s+(?:-\w+\s+(?:\S+\s+)?)*([A-Za-z_]\w*)/g,
    /\bfor\s+([A-Za-z_]\w*)\s+in\b/g,
    /^\s*(?:-\s+)?([A-Za-z_]\w*)\s*:(?:\s|$)/gm,
    /[{\s]([A-Z_][A-Z0-9_]*)\s*:\s/g,
  ];
  for (const pattern of patterns) for (const m of text.matchAll(pattern)) names.add(m[1]!);
  return names;
}

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isContent = (line: string | undefined): line is string =>
  line !== undefined && line.trim() !== "" && !line.trimStart().startsWith("#");

/** Indent of the keys of the mapping that starts at `index` (`- name: x` or `key:`). */
function childIndent(lines: readonly string[], index: number): number | undefined {
  const line = lines[index]!;
  const item = /^(\s*)-\s+/.exec(line);
  if (item) return item[0].length;
  for (let j = index + 1; j < lines.length; j++) {
    if (!isContent(lines[j])) continue;
    return indentOf(lines[j]!) > indentOf(line) ? indentOf(lines[j]!) : undefined;
  }
  return undefined;
}

/** Keys of `env:` / `variables:` mappings at `keyIndent` within lines [from, to). */
function envKeys(lines: readonly string[], from: number, to: number, keyIndent: number): string[] {
  const keys: string[] = [];
  for (let i = from; i < to; i++) {
    const line = lines[i]!;
    const block = /^(\s*(?:-\s+)?)(?:env|variables):\s*(\{.*\})?\s*(?:#.*)?$/.exec(line);
    if (!block || block[1]!.length !== keyIndent) continue;
    if (block[2]) {
      for (const m of block[2].matchAll(/([A-Za-z_]\w*)\s*:/g)) keys.push(m[1]!);
      continue;
    }
    let inner: number | undefined;
    for (let j = i + 1; j < to; j++) {
      if (!isContent(lines[j])) continue;
      const indent = indentOf(lines[j]!);
      if (indent <= keyIndent) break;
      inner ??= indent;
      const key = /^\s*([A-Za-z_]\w*)\s*:/.exec(lines[j]!);
      if (indent === inner && key) keys.push(key[1]!);
    }
  }
  return keys;
}

/**
 * Names in the `env:` (or GitLab `variables:`) mappings that apply at line
 * `lineNumber` (1-based) of a workflow file: the step's, the job's and the
 * workflow's, found by indentation.
 */
export function workflowEnvAt(fileText: string, lineNumber: number): Set<string> {
  const lines = fileText.split("\n");
  const names = new Set(envKeys(lines, 0, lines.length, 0));
  const start = Math.min(lineNumber - 1, lines.length - 1);
  let minIndent = Infinity;
  for (let i = start; i >= 0; i--) {
    const line = lines[i]!;
    if (!isContent(line)) continue;
    const indent = indentOf(line);
    // The finding's own line counts when it starts a step (`- name: …`).
    if (indent >= minIndent && !(i === start && /^\s*-\s+/.test(line))) continue;
    minIndent = indent;
    const keyIndent = childIndent(lines, i);
    if (keyIndent === undefined) continue;
    let end = i + 1;
    while (end < lines.length && (!isContent(lines[end]) || indentOf(lines[end]!) > indent)) end++;
    const from = /^\s*-\s+/.test(line) ? i : i + 1;
    for (const key of envKeys(lines, from, end, keyIndent)) names.add(key);
  }
  return names;
}

/**
 * Variables a workflow suggestion starts using that nothing defines: not the
 * suggestion itself, the step/job/workflow `env:`, an assignment elsewhere in
 * the file (e.g. via `$GITHUB_ENV`), or the runner. Applying such a
 * suggestion leaves the variable empty, so it is not a complete fix.
 */
export function undefinedSuggestionVariables(finding: Finding, fileText: string): string[] {
  if (finding.suggestion === undefined) return [];
  const lines = fileText.split("\n");
  const original = lines.slice(finding.startLine - 1, finding.endLine).join("\n");
  const before = variableReferences(original);
  const defined = new Set([
    ...assignedNames(finding.suggestion),
    ...assignedNames(lines.map(unquoted).join("\n").replace(/^\s*(?:-\s+)?[\w-]+\s*:/gm, "")),
    ...workflowEnvAt(fileText, finding.startLine),
  ]);
  return [...variableReferences(finding.suggestion)].filter(
    (name) => !before.has(name) && !defined.has(name) && !PREDEFINED.test(name),
  );
}

const lineRange = (f: Finding): string =>
  f.startLine === f.endLine ? `line ${f.startLine}` : `lines ${f.startLine}-${f.endLine}`;

/**
 * Turns an incomplete suggestion into body text: the one-click fix would
 * leave `missing` unset, so the body says what else the fix needs.
 */
export function downgradeSuggestion(finding: Finding, missing: readonly string[]): Finding {
  const { suggestion, ...rest } = finding;
  if (suggestion === undefined) return finding;
  const vars = missing.map((name) => `\`${name}\``).join(", ");
  const note =
    `This change alone is not a complete fix: it uses ${vars}, which the step, job and workflow \`env:\` don't define. ` +
    `Define ${missing.length === 1 ? "it" : "them"} in the step's \`env:\` as part of the fix, then change ${lineRange(finding)} to:\n${fence(suggestion)}`;
  return { ...rest, body: `${finding.body}\n\n${note}` };
}
