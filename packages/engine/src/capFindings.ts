import { FINDING_SEVERITIES, MAX_REVIEW_FINDINGS, type Finding } from "@omniralph/shared";

/**
 * The `limit` most severe (then most confident) findings, in their original
 * order, so the result fits `ReviewJobResult`.
 */
export function capFindings(findings: readonly Finding[], limit = MAX_REVIEW_FINDINGS): Finding[] {
  if (findings.length <= limit) return [...findings];
  const rank = (f: Finding) => FINDING_SEVERITIES.indexOf(f.severity);
  const kept = new Set(
    findings
      .map((finding, index) => ({ finding, index }))
      .sort(
        (a, b) =>
          rank(a.finding) - rank(b.finding) ||
          b.finding.confidence - a.finding.confidence ||
          a.index - b.index,
      )
      .slice(0, limit)
      .map(({ index }) => index),
  );
  return findings.filter((_, index) => kept.has(index));
}
