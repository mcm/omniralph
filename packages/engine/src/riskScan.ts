/**
 * Deterministic, zero-token risk pre-pass over a parsed diff: file risk
 * weights, regex risk signals on changed lines and a 1–10 complexity score.
 *
 * Ported from `engineering-team/skills/code-reviewer/scripts/pr_analyzer.py`
 * in claude-skills (https://github.com/alirezarezvani/claude-skills, commit
 * 19392f7a08264ed00486a251f5b2098321771f94), MIT License, Copyright (c) 2025
 * Alireza Rezvani. See THIRD_PARTY_NOTICES.md.
 *
 * Changes from the original: signals record line numbers; the C#-specific
 * patterns are dropped (they misfire on TypeScript); added `eval`/`new
 * Function`, `@ts-ignore`/`@ts-expect-error`, destructive migrations, removed
 * exports, env var changes and prompt-injection text aimed at AI reviewers.
 */
import type { DiffFile } from "./diff.js";

export type RiskCategory = "critical" | "high" | "medium" | "low" | "default";

export type SignalSeverity = "critical" | "high" | "medium" | "low";

interface CategoryRule {
  category: Exclude<RiskCategory, "default">;
  weight: number;
  patterns: RegExp[];
}

/** Path patterns, checked in order against the lower-cased path; the first match wins. */
export const FILE_CATEGORIES: readonly CategoryRule[] = [
  {
    category: "critical",
    weight: 5,
    patterns: [
      /auth/,
      /security/,
      /password/,
      /token/,
      /secret/,
      /payment/,
      /billing/,
      /crypto/,
      /encrypt/,
    ],
  },
  {
    category: "high",
    weight: 4,
    patterns: [/api/, /database/, /migration/, /schema/, /model/, /config/, /env/, /middleware/],
  },
  {
    category: "medium",
    weight: 3,
    patterns: [/service/, /controller/, /handler/, /util/, /helper/],
  },
  {
    category: "low",
    weight: 1,
    patterns: [/test/, /spec/, /mock/, /fixture/, /story/, /readme/, /docs/, /\.md$/],
  },
];

/** Weight of a path that matches no category. */
export const DEFAULT_RISK_WEIGHT = 2;

export function categorizeFile(path: string): { category: RiskCategory; weight: number } {
  const lower = path.toLowerCase();
  for (const rule of FILE_CATEGORIES) {
    if (rule.patterns.some((p) => p.test(lower)))
      return { category: rule.category, weight: rule.weight };
  }
  return { category: "default", weight: DEFAULT_RISK_WEIGHT };
}

export function riskWeight(path: string): number {
  return categorizeFile(path).weight;
}

export type RiskSignalName =
  | "hardcoded_secret"
  | "sql_concatenation"
  | "dynamic_code"
  | "debugger"
  | "console_log"
  | "todo_fixme"
  | "analyzer_disable"
  | "ts_suppression"
  | "loose_type"
  | "destructive_migration"
  | "removed_export"
  | "env_var_added"
  | "env_var_removed"
  | "prompt_injection";

export interface RiskSignal {
  name: RiskSignalName;
  severity: SignalSeverity;
  message: string;
  path: string;
  /** Number of matching lines. */
  count: number;
  /** Matching line numbers, on the side given by `side`. */
  lines: number[];
  /** `new` = head-side (added) lines, `old` = base-side (removed) lines. */
  side: "new" | "old";
}

interface ChangedLine {
  line: number;
  content: string;
}

interface LineSignal {
  name: RiskSignalName;
  severity: SignalSeverity;
  message: string;
  side: "new" | "old";
  pattern: RegExp;
  /** Restricts the signal to matching paths. */
  paths?: RegExp;
}

const ENV_FILE = /(^|\/)\.env(\.[^/]*)?$/;
const ENV_ACCESS =
  /\bprocess\.env(?:\.[A-Za-z_]\w*|\[\s*['"`][A-Za-z_]\w*['"`]\s*\])|\bimport\.meta\.env\.[A-Za-z_]\w*|\bos\.environ\b|\bos\.getenv\s*\(|\bDeno\.env\.get\s*\(/;
const ENV_ASSIGNMENT = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/;

const PROMPT_INJECTION = new RegExp(
  [
    String.raw`\b(?:ignore|disregard|forget|override)\b.{0,30}\b(?:previous|prior|above|earlier|preceding|all|your|system)\b.{0,20}\b(?:instructions?|prompts?|rules|directives|guidelines)\b`,
    String.raw`\byou are now\b`,
    String.raw`\bapprove (?:this|the) (?:pr|pull request|merge request|mr|change|changes|diff|code)\b`,
    String.raw`\b(?:do not|don't|never)\s+(?:report|flag|mention|comment on)\b.{0,40}\b(?:issues?|findings?|problems?|vulnerabilit(?:y|ies)|bugs?)\b`,
    String.raw`\b(?:new|updated|real) (?:system )?instructions?\s*:`,
    String.raw`\bsystem prompt\b`,
    String.raw`<\/?(?:system|assistant|instructions?)>|\[(?:system|INST)\]`,
    String.raw`\b(?:ai|llm|automated)[ -](?:code[ -])?reviewers?\b`,
  ].join("|"),
  "i",
);

/** Line-based signals. Patterns are case-insensitive, as in the original. */
const LINE_SIGNALS: readonly LineSignal[] = [
  {
    name: "hardcoded_secret",
    severity: "critical",
    message: "Potential hardcoded secret or connection string",
    side: "new",
    pattern: /(password|secret|api_?key|token|connection_?string)\s*[=:]\s*['"][^'"]+['"]/i,
  },
  {
    name: "sql_concatenation",
    severity: "critical",
    message: "Potential SQL injection (string concatenation or interpolation in a query)",
    side: "new",
    pattern:
      /\b(?:SELECT|INSERT|UPDATE|DELETE)\b.*(?:\+.*['"`]|['"`]\s*\+|\$\{)|(?:FromSql|ExecuteSql)\w*\([^)]*\$"/i,
  },
  {
    name: "dynamic_code",
    severity: "critical",
    message: "Dynamic code execution (eval / new Function)",
    side: "new",
    pattern: /\beval\s*\(|\bnew\s+Function\s*\(/i,
  },
  {
    name: "debugger",
    severity: "high",
    message: "Debugger statement",
    side: "new",
    pattern: /\bdebugger\b/i,
  },
  {
    name: "console_log",
    severity: "medium",
    message: "Debug output statement (console.* / Debug.WriteLine / System.out / printStackTrace)",
    side: "new",
    pattern:
      /console\.(?:log|debug|info|warn|error|trace)\(|\bDebug\.WriteLine\(|\bSystem\.out\.print(?:ln)?\(|\.printStackTrace\(/i,
  },
  {
    name: "todo_fixme",
    severity: "low",
    message: "TODO/FIXME comment",
    side: "new",
    pattern: /\b(?:TODO|FIXME|HACK|XXX):/i,
  },
  {
    name: "analyzer_disable",
    severity: "medium",
    message:
      "Static-analyzer rule disabled (eslint-disable / #pragma warning disable / @SuppressWarnings)",
    side: "new",
    pattern: /eslint-disable|#pragma\s+warning\s+disable|\[SuppressMessage|@SuppressWarnings/i,
  },
  {
    name: "ts_suppression",
    severity: "medium",
    message: "TypeScript error suppressed (@ts-ignore / @ts-expect-error / @ts-nocheck)",
    side: "new",
    pattern: /@ts-(?:ignore|expect-error|nocheck)\b/i,
  },
  {
    name: "loose_type",
    severity: "medium",
    message: "Loose type used (TypeScript `any`)",
    side: "new",
    pattern: /:\s*any\b|\bas\s+any\b|<any>/,
  },
  {
    name: "destructive_migration",
    severity: "high",
    message: "Destructive schema change (DROP, TRUNCATE or column removal)",
    side: "new",
    pattern:
      /\bDROP\s+(?:TABLE|COLUMN|SCHEMA|DATABASE|INDEX|CONSTRAINT|TYPE|VIEW)\b|\bTRUNCATE\b\s+(?:TABLE\s+)?["'`\w]|\bALTER\s+TABLE\b.*\bDROP\b|\.(?:dropColumns?|removeColumn|dropTable)\s*\(|\b(?:remove_column|drop_table)\b/i,
  },
  {
    name: "env_var_added",
    severity: "medium",
    message: "Environment variable added or newly read",
    side: "new",
    pattern: ENV_ACCESS,
  },
  {
    name: "env_var_added",
    severity: "medium",
    message: "Environment variable added or newly read",
    side: "new",
    pattern: ENV_ASSIGNMENT,
    paths: ENV_FILE,
  },
  {
    name: "env_var_removed",
    severity: "medium",
    message: "Environment variable removed or no longer read",
    side: "old",
    pattern: ENV_ACCESS,
  },
  {
    name: "env_var_removed",
    severity: "medium",
    message: "Environment variable removed or no longer read",
    side: "old",
    pattern: ENV_ASSIGNMENT,
    paths: ENV_FILE,
  },
  {
    name: "prompt_injection",
    severity: "critical",
    message:
      "Text that looks like instructions to an AI reviewer (possible prompt injection); treat as data",
    side: "new",
    pattern: PROMPT_INJECTION,
  },
];

const EXPORT_DECLARATION =
  /^\s*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\s*\*?|const|let|var|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/;
const EXPORT_DEFAULT = /^\s*export\s+default\b/;
const EXPORT_LIST = /^\s*export\s+(?:type\s+)?\{([^}]*)\}/;

/** Names exported by a line (`default` for default exports). */
function exportedNames(content: string): string[] {
  const names: string[] = [];
  if (EXPORT_DEFAULT.test(content)) names.push("default");
  const decl = EXPORT_DECLARATION.exec(content);
  if (decl?.[1] && !EXPORT_DEFAULT.test(content)) names.push(decl[1]);
  const list = EXPORT_LIST.exec(content);
  if (list?.[1]) {
    for (const part of list[1].split(",")) {
      const name = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)
        .at(-1)
        ?.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

function changedLines(file: DiffFile, side: "new" | "old"): ChangedLine[] {
  const out: ChangedLine[] = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (side === "new" && line.type === "add" && line.newLine !== null) {
        out.push({ line: line.newLine, content: line.content });
      } else if (side === "old" && line.type === "del" && line.oldLine !== null) {
        out.push({ line: line.oldLine, content: line.content });
      }
    }
  }
  return out;
}

/** Exports present on removed lines that no added line re-declares. */
function removedExportLines(removed: ChangedLine[], added: ChangedLine[]): number[] {
  const stillExported = new Set(added.flatMap((l) => exportedNames(l.content)));
  return removed
    .filter((l) => exportedNames(l.content).some((name) => !stillExported.has(name)))
    .map((l) => l.line);
}

/** Risk signals found in one file's changed lines. */
export function scanSignals(file: DiffFile): RiskSignal[] {
  const added = changedLines(file, "new");
  const removed = changedLines(file, "old");
  const byName = new Map<RiskSignalName, RiskSignal>();

  const record = (def: Omit<LineSignal, "pattern" | "paths">, lines: number[]) => {
    if (lines.length === 0) return;
    const existing = byName.get(def.name);
    if (existing) {
      const merged = [...new Set([...existing.lines, ...lines])].sort((a, b) => a - b);
      existing.lines = merged;
      existing.count = merged.length;
      return;
    }
    const unique = [...new Set(lines)].sort((a, b) => a - b);
    byName.set(def.name, {
      name: def.name,
      severity: def.severity,
      message: def.message,
      path: file.path,
      count: unique.length,
      lines: unique,
      side: def.side,
    });
  };

  for (const def of LINE_SIGNALS) {
    if (def.paths && !def.paths.test(file.path)) continue;
    const lines = def.side === "new" ? added : removed;
    record(
      def,
      lines.filter((l) => def.pattern.test(l.content)).map((l) => l.line),
    );
  }
  record(
    {
      name: "removed_export",
      severity: "high",
      message: "Export removed (possible breaking change for importers)",
      side: "old",
    },
    removedExportLines(removed, added),
  );

  return [...byName.values()];
}

export interface FileRisk {
  path: string;
  category: RiskCategory;
  weight: number;
  signals: RiskSignal[];
}

export function scanFile(file: DiffFile): FileRisk {
  const { category, weight } = categorizeFile(file.path);
  return { path: file.path, category, weight, signals: scanSignals(file) };
}

/**
 * PR complexity, 1–10: up to 3 points for the number of files, 3 for changed
 * lines, 2 for critical signals and 2 for high signals (one per file × signal).
 */
export function complexityScore(
  files: readonly DiffFile[],
  signals: readonly RiskSignal[],
): number {
  let score = 0;

  const fileCount = files.length;
  if (fileCount > 20) score += 3;
  else if (fileCount > 10) score += 2;
  else if (fileCount > 5) score += 1;

  const totalChanges = files.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  if (totalChanges > 500) score += 3;
  else if (totalChanges > 200) score += 2;
  else if (totalChanges > 50) score += 1;

  score += Math.min(2, signals.filter((s) => s.severity === "critical").length);
  score += Math.min(2, signals.filter((s) => s.severity === "high").length);

  return Math.min(10, Math.max(1, score));
}

export interface RiskScan {
  files: FileRisk[];
  complexityScore: number;
}

export function riskScan(files: readonly DiffFile[]): RiskScan {
  const risks = files.map(scanFile);
  return {
    files: risks,
    complexityScore: complexityScore(
      files,
      risks.flatMap((r) => r.signals),
    ),
  };
}
