import type { Finding } from "@omniralph/shared";

/** A finding's location; `category` may be any string (stored DB findings). */
export type FindingLocation = Pick<Finding, "path" | "startLine" | "endLine"> & {
  category: string;
};

/**
 * Same path, same category and overlapping line ranges: the rule for a
 * duplicate of an open finding (dedupe) and for superseding one (fresh re-run).
 */
export function sameIssue(a: FindingLocation, b: FindingLocation): boolean {
  return (
    a.path === b.path &&
    a.category === b.category &&
    a.startLine <= b.endLine &&
    b.startLine <= a.endLine
  );
}
