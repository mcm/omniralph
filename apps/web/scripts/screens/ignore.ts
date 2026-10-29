import { routeMatches } from "./routes";

/**
 * The accessibility checks of each capture (capture.mjs, `a11y-page.mjs`). Their findings fail
 * `--strict` unless an entry of `.impeccable/critique/ignore.md` names the check's rule and
 * scopes it to the capture.
 */
export const ACCESSIBILITY_CHECKS = ["axe", "keyboard", "escape", "landmarks"] as const;
export type AccessibilityCheck = (typeof ACCESSIBILITY_CHECKS)[number];

/** One finding of an accessibility check on one capture. */
export interface AccessibilityFinding {
  /** The axe-core rule ID, or the check's rule (e.g. `unreachable`, `no-main`). */
  rule: string;
  /** axe-core's impact (`minor` … `critical`); the other checks have none. */
  impact?: string | null;
  /** The element: axe-core's selector, or the check's description of it; `null` for the page. */
  target: string | null;
  summary: string;
}

/** Where a finding was seen, for scope matching. */
export interface FindingCapture {
  route: string;
  path: string;
  surface: string;
  viewport: string;
  theme: string;
}

/** The scope keys of an accessibility entry: `` `route: inbox-*` ``, `` `theme: light` ``, … */
export const SCOPE_KEYS = ["route", "surface", "viewport", "theme", "target"] as const;
type ScopeKey = (typeof SCOPE_KEYS)[number];

/** An ignore.md row whose rule is `<check>: <rule>`, e.g. `axe: color-contrast`. */
export interface AccessibilityIgnoreEntry {
  check: AccessibilityCheck;
  rule: string;
  /** Values per key; a capture matches a key when it matches any of its values. */
  scope: Partial<Record<ScopeKey, string[]>>;
  reason: string;
  /** The row as written, to name it in the report. */
  text: string;
}

/** One finding of `impeccable detect --json` (a `<screen>.impeccable.json` item). */
export interface DetectFinding {
  /** The detector's rule, e.g. `cramped-padding`. */
  antipattern: string;
  name?: string;
  severity?: string;
  /** The scanned file: the HTML snapshot, or a source file. */
  file: string;
  line?: number;
  /** What it saw, naming the element (`<span> "or-ref": …`, `.whiteout::after — …`) or a color. */
  snippet: string;
  /** Set on the detector's less certain rules. */
  advisory?: boolean;
}

/**
 * An ignore.md row for an `impeccable detect` rule (any row that isn't `decided:` or an
 * accessibility row): it ignores the rule's findings that name one of what its Scope cell names
 * in backticks: a class selector (`.or-ref`), a file (`packages/ui/styles/refs.css`), a custom
 * property (`--or-glow`) or a color (`#f5f3ee`, also matched in `rgb()` form).
 */
export interface DetectIgnoreEntry {
  rule: string;
  /** Class names, each set from one backticked selector (`.a.b` needs both). */
  selectors: string[][];
  files: string[];
  properties: string[];
  /** Lowercase `#rrggbb`. */
  colors: string[];
  reason: string;
  text: string;
}

export interface ParsedIgnoreList {
  entries: AccessibilityIgnoreEntry[];
  /** The `impeccable detect` entries (`detectIgnoredBy`). */
  detect: DetectIgnoreEntry[];
  /**
   * Rows that never match: an accessibility row with no scope or a scope key it doesn't know,
   * or a detect row whose scope names no selector, file, custom property or color.
   */
  problems: string[];
}

const CHECK_RULE = new RegExp(`^(${ACCESSIBILITY_CHECKS.join("|")}): ?([\\w-]+)$`);

/**
 * The accessibility entries of ignore.md's table. Other rows (impeccable rules and the
 * `decided:` items) are for the critique and `impeccable detect` only: they never match an
 * accessibility finding. An accessibility row must be scoped: at least one `` `key: value` ``
 * in its Scope cell.
 */
export function parseIgnoreList(markdown: string): ParsedIgnoreList {
  const entries: AccessibilityIgnoreEntry[] = [];
  const detect: DetectIgnoreEntry[] = [];
  const problems: string[] = [];
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|") || /^\|[\s|:-]+\|$/.test(line)) continue;
    const [ruleCell = "", scopeCell = "", reason = ""] = line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
    const rule = ruleCell.replace(/`/g, "").trim();
    const match = CHECK_RULE.exec(rule);
    if (!match) {
      if (!DETECT_RULE.test(rule)) continue;
      const entry = detectEntry(rule, scopeCell, reason);
      if (entry) detect.push(entry);
      else problems.push(`${rule}: names no selector, file, custom property or color in backticks`);
      continue;
    }
    const scope: Partial<Record<ScopeKey, string[]>> = {};
    let unknown = false;
    for (const [, token] of scopeCell.matchAll(/`([^`]+)`/g)) {
      const pair = /^([a-z]+):\s*(.+)$/.exec(token!.trim());
      if (!pair || !(SCOPE_KEYS as readonly string[]).includes(pair[1]!)) {
        problems.push(`${ruleCell}: unknown scope \`${token}\` (use ${SCOPE_KEYS.join(", ")})`);
        unknown = true;
        continue;
      }
      (scope[pair[1] as ScopeKey] ??= []).push(pair[2]!.trim());
    }
    // A scope it can't read would ignore more than it says: the row ignores nothing.
    if (unknown) continue;
    if (Object.keys(scope).length === 0) {
      problems.push(`${ruleCell}: no scope, so it ignores nothing`);
      continue;
    }
    entries.push({
      check: match[1] as AccessibilityCheck,
      rule: match[2]!,
      scope,
      reason,
      text: `${ruleCell} | ${scopeCell}`,
    });
  }
  return { entries, detect, problems };
}

/** A detector rule ID (the header row's "Rule" and `decided:` items aren't). */
const DETECT_RULE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const HEX = /#([0-9a-f]{6}|[0-9a-f]{3})\b/gi;
const RGB = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/gi;

function detectEntry(rule: string, scopeCell: string, reason: string): DetectIgnoreEntry | null {
  const entry: DetectIgnoreEntry = {
    rule,
    selectors: [],
    files: [],
    properties: [],
    colors: [],
    reason,
    text: `${rule} | ${scopeCell}`,
  };
  for (const [, raw] of scopeCell.matchAll(/`([^`]+)`/g)) {
    const token = raw!.trim();
    if (token.includes("/")) {
      entry.files.push(token.replace(/^\.\//, ""));
      continue;
    }
    entry.colors.push(...colorsIn(token));
    if (token.startsWith("--")) {
      entry.properties.push(token.split(":")[0]!.trim());
    } else if (token.startsWith(".")) {
      const classes = [...token.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map(([, name]) => name!);
      if (classes.length > 0) entry.selectors.push(classes);
    }
  }
  const named =
    entry.selectors.length + entry.files.length + entry.properties.length + entry.colors.length;
  return named > 0 ? entry : null;
}

/** The colors a text names, as lowercase `#rrggbb`: hex, and `rgb()`/`rgba()`. */
export function colorsIn(text: string): string[] {
  const colors: string[] = [];
  for (const [, hex] of text.matchAll(HEX)) {
    const long = hex!.length === 3 ? [...hex!].map((digit) => digit + digit).join("") : hex!;
    colors.push(`#${long.toLowerCase()}`);
  }
  for (const [, ...channels] of text.matchAll(RGB)) {
    colors.push(
      `#${channels
        .slice(0, 3)
        .map((channel) => Number(channel).toString(16).padStart(2, "0"))
        .join("")}`,
    );
  }
  return colors;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The first detect entry that ignores `finding`, or `null`: same rule, and the finding names
 * one of the entry's selectors (every class of it, as a whole class name in the snippet), files
 * (the scanned file is it), custom properties or colors.
 */
export function detectIgnoredBy(
  entries: readonly DetectIgnoreEntry[],
  finding: Pick<DetectFinding, "antipattern" | "file" | "snippet">,
): DetectIgnoreEntry | null {
  const snippet = finding.snippet ?? "";
  const file = (finding.file ?? "").replace(/\\/g, "/");
  const colors = colorsIn(snippet);
  const hasClass = (name: string) =>
    new RegExp(`(^|[^\\w-])${escapeRegExp(name)}(?![\\w-])`).test(snippet);
  return (
    entries.find(
      (entry) =>
        entry.rule === finding.antipattern &&
        (entry.files.some((path) => file === path || file.endsWith(`/${path}`)) ||
          entry.selectors.some((classes) => classes.every(hasClass)) ||
          entry.properties.some((property) => snippet.includes(property)) ||
          entry.colors.some((color) => colors.includes(color))),
    ) ?? null
  );
}

/** The first entry that ignores `finding` of `check` on `capture`, or `null`. */
export function ignoredBy(
  entries: readonly AccessibilityIgnoreEntry[],
  check: AccessibilityCheck,
  finding: Pick<AccessibilityFinding, "rule" | "target">,
  capture: FindingCapture,
): AccessibilityIgnoreEntry | null {
  const matchesKey = (key: ScopeKey, values: string[]) =>
    values.some((value) => {
      switch (key) {
        case "route":
          return routeMatches({ name: capture.route, path: capture.path }, value);
        case "target":
          return finding.target !== null && finding.target.includes(value);
        default:
          return capture[key] === value;
      }
    });
  return (
    entries.find(
      (entry) =>
        entry.check === check &&
        entry.rule === finding.rule &&
        Object.entries(entry.scope).every(([key, values]) => matchesKey(key as ScopeKey, values!)),
    ) ?? null
  );
}
