import type { Finding } from "@omniralph/shared";
import { severityRank, type EvalCase, type ExpectedFinding, type MustNotFlag } from "./case.js";

/** How far (in lines) a finding may sit from an expected item and still match it. */
export const LINE_TOLERANCE = 3;

export type FalsePositiveReason =
  /** Matches no expected item. */
  | "unmatched"
  /** Matches an expected item another finding already matched. */
  | "duplicate"
  /** Touches a `mustNotFlag` range. */
  | "must_not_flag";

export interface FalsePositive {
  finding: Finding;
  reason: FalsePositiveReason;
  /** The `mustNotFlag` item hit, for `must_not_flag`. */
  mustNotFlag?: MustNotFlag;
}

export interface CaseScore {
  truePositives: { finding: Finding; expected: ExpectedFinding }[];
  falsePositives: FalsePositive[];
  /** Expected items no finding matched. */
  falseNegatives: ExpectedFinding[];
}

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) =>
  aStart <= bEnd && bStart <= aEnd;

/** Lines between a finding and an expected item's range; 0 when they overlap. */
function distance(finding: Finding, expected: ExpectedFinding): number {
  return Math.max(0, expected.startLine - finding.endLine, finding.startLine - expected.endLine);
}

/**
 * Same path, line ranges overlapping within ±`LINE_TOLERANCE` lines, same
 * category and a severity at least `minSeverity`.
 */
export function matchesExpected(finding: Finding, expected: ExpectedFinding): boolean {
  return (
    finding.path === expected.path &&
    overlaps(
      finding.startLine,
      finding.endLine,
      expected.startLine - LINE_TOLERANCE,
      expected.endLine + LINE_TOLERANCE,
    ) &&
    finding.category === expected.category &&
    severityRank(finding.severity) >= severityRank(expected.minSeverity)
  );
}

/** Same path and (when the item has lines) an overlapping range, with no tolerance. */
export function hitsMustNotFlag(finding: Finding, item: MustNotFlag): boolean {
  if (finding.path !== item.path) return false;
  if (item.startLine === undefined && item.endLine === undefined) return true;
  const start = item.startLine ?? item.endLine ?? 1;
  const end = item.endLine ?? item.startLine ?? start;
  return overlaps(finding.startLine, finding.endLine, start, end);
}

/**
 * Scores a review's findings against a case. A finding that hits a
 * `mustNotFlag` item is a false positive even if it also matches an expected
 * item; each expected item is matched by at most one finding (the closest
 * unmatched one is taken; extra matches are `duplicate` false positives).
 */
export function scoreCase(
  findings: readonly Finding[],
  evalCase: Pick<EvalCase, "expected" | "mustNotFlag">,
): CaseScore {
  const score: CaseScore = { truePositives: [], falsePositives: [], falseNegatives: [] };
  const matched = new Set<ExpectedFinding>();
  for (const finding of findings) {
    const forbidden = (evalCase.mustNotFlag ?? []).find((item) => hitsMustNotFlag(finding, item));
    if (forbidden) {
      score.falsePositives.push({ finding, reason: "must_not_flag", mustNotFlag: forbidden });
      continue;
    }
    const candidates = evalCase.expected.filter((e) => matchesExpected(finding, e));
    const expected = candidates
      .filter((e) => !matched.has(e))
      .sort((a, b) => distance(finding, a) - distance(finding, b))[0];
    if (expected) {
      matched.add(expected);
      score.truePositives.push({ finding, expected });
    } else {
      score.falsePositives.push({
        finding,
        reason: candidates.length > 0 ? "duplicate" : "unmatched",
      });
    }
  }
  score.falseNegatives = evalCase.expected.filter((e) => !matched.has(e));
  return score;
}
