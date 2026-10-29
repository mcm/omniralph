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

export interface ParsedIgnoreList {
  entries: AccessibilityIgnoreEntry[];
  /** Accessibility rows that never match: no scope, or a scope key it doesn't know. */
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
  const problems: string[] = [];
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|") || /^\|[\s|:-]+\|$/.test(line)) continue;
    const [ruleCell = "", scopeCell = "", reason = ""] = line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
    const match = CHECK_RULE.exec(ruleCell.replace(/`/g, ""));
    if (!match) continue;
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
  return { entries, problems };
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
