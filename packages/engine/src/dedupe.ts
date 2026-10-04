import type { Finding } from "@omniralph/shared";

type FindingLocation = Pick<Finding, "path" | "startLine" | "endLine" | "category">;

/** Same path, same category and overlapping line ranges. */
export function sameIssue(a: FindingLocation, b: FindingLocation): boolean {
  return (
    a.path === b.path &&
    a.category === b.category &&
    a.startLine <= b.endLine &&
    b.startLine <= a.endLine
  );
}

export interface DedupeResult {
  findings: Finding[];
  /** New findings dropped as duplicates of an open prior finding or of an earlier new one. */
  suppressed: Finding[];
}

/**
 * Drops findings that repeat an open finding from a previous review of the
 * same PR, and repeats among the new findings (the first one wins).
 */
export function dedupeFindings(
  findings: readonly Finding[],
  openPrior: readonly FindingLocation[] = [],
): DedupeResult {
  const kept: Finding[] = [];
  const suppressed: Finding[] = [];
  for (const finding of findings) {
    const duplicate =
      openPrior.some((prior) => sameIssue(prior, finding)) ||
      kept.some((other) => sameIssue(other, finding));
    (duplicate ? suppressed : kept).push(finding);
  }
  return { findings: kept, suppressed };
}
