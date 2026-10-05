import { FINDING_SEVERITIES, type Finding } from "@omniralph/shared";
import { fence } from "./prompt.js";
import { sameIssue, type FindingLocation } from "./sameIssue.js";
import { assignedNames, variableReferences } from "./selfContained.js";

export { sameIssue, type FindingLocation };

/**
 * Same path, same category and overlapping or adjacent line ranges: one
 * problem the model split into several findings (e.g. an injection on a `run:`
 * line plus "add the `env:` mapping" on the lines right above it).
 */
export function splitIssue(a: FindingLocation, b: FindingLocation): boolean {
  return (
    a.path === b.path &&
    a.category === b.category &&
    a.startLine <= b.endLine + 1 &&
    b.startLine <= a.endLine + 1
  );
}

const lineRange = (f: FindingLocation): string =>
  f.startLine === f.endLine ? `line ${f.startLine}` : `lines ${f.startLine}-${f.endLine}`;

const rank = (f: Finding): number => FINDING_SEVERITIES.indexOf(f.severity);

/**
 * Merges two findings about one problem into one. The more severe one (the
 * first on a tie) leads. A finding inside the leader's range is a plain
 * repeat and adds nothing. Otherwise the range widens to cover both, and the
 * other finding's text is appended. Each suggestion only fixed its own range,
 * so a widened finding carries them in the body instead.
 */
export function mergeFindings(first: Finding, second: Finding): Finding {
  const [lead, other] = rank(second) < rank(first) ? [second, first] : [first, second];
  const startLine = Math.min(lead.startLine, other.startLine);
  const endLine = Math.max(lead.endLine, other.endLine);
  const confidence = Math.max(lead.confidence, other.confidence);
  if (startLine === lead.startLine && endLine === lead.endLine) return { ...lead, confidence };

  const parts = [lead.body];
  if (lead.suggestion !== undefined) {
    parts.push(`Suggested change for ${lineRange(lead)}:\n${fence(lead.suggestion)}`);
  }
  parts.push(`Also (${lineRange(other)}): ${other.title}. ${other.body}`);
  if (other.suggestion !== undefined) {
    parts.push(`Suggested change for ${lineRange(other)}:\n${fence(other.suggestion)}`);
  }
  const { suggestion: _dropped, ...rest } = lead;
  return { ...rest, startLine, endLine, confidence, body: parts.join("\n\n") };
}

const codeOf = (f: Finding): string =>
  [...f.body.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).join("\n") + `\n${f.suggestion ?? ""}`;

/**
 * Whether `fragment` supplies a variable `finding` relies on: e.g. "add
 * `env: PR_TITLE: …`" for an injection fix that uses `${PR_TITLE}`.
 */
export function completes(fragment: Finding, finding: Finding): boolean {
  const supplied = assignedNames(codeOf(fragment));
  const own = assignedNames(codeOf(finding));
  const used = variableReferences(`${finding.body}\n${finding.suggestion ?? ""}`);
  return [...used].some((name) => supplied.has(name) && !own.has(name));
}

export interface DedupeResult {
  findings: Finding[];
  /** New findings dropped as duplicates of an open prior finding or merged into an earlier new one. */
  suppressed: Finding[];
}

/**
 * Drops findings that repeat an open finding from a previous review of the
 * same PR, and merges new findings about one problem into one: a fragment
 * into the nearby finding it completes, then splits of one issue (same file
 * and category, overlapping or adjacent lines) into the first of them.
 */
export function dedupeFindings(
  findings: readonly Finding[],
  openPrior: readonly FindingLocation[] = [],
): DedupeResult {
  const suppressed: Finding[] = [];
  const fresh = findings.filter((finding) => {
    const repeat = openPrior.some((prior) => sameIssue(prior, finding));
    if (repeat) suppressed.push(finding);
    return !repeat;
  });

  // A fragment that completes a nearby finding goes into it first, whatever
  // its category, so the "add the env mapping" part of an injection fix
  // can't be merged into another finding on the same step.
  const near = (a: Finding, b: Finding) => splitIssue({ ...a, category: b.category }, b);
  for (let i = 0; i < fresh.length; i++) {
    const fragment = fresh[i]!;
    const target = fresh.findIndex(
      (other, j) => j !== i && near(other, fragment) && completes(fragment, other),
    );
    if (target === -1) continue;
    fresh[target] = mergeFindings(fresh[target]!, fragment);
    suppressed.push(fragment);
    fresh.splice(i, 1);
    i = -1;
  }

  const kept: Finding[] = [];
  for (const finding of fresh) {
    const index = kept.findIndex((other) => splitIssue(other, finding));
    if (index === -1) {
      kept.push(finding);
    } else {
      kept[index] = mergeFindings(kept[index]!, finding);
      suppressed.push(finding);
    }
  }
  return { findings: kept, suppressed };
}
