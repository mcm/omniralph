/**
 * View props of Repository › Rules (client-safe: no server imports).
 */
import type { RuleEntry } from "@omniralph/db";
import { runHref } from "@/lib/runs/hrefs";
import { userDisplayName } from "@/lib/user-display";

export interface RuleView {
  id: string;
  kind: "custom" | "learned";
  text: string;
  enabled: boolean;
  /** ISO timestamp. */
  createdAt: string;
  /** Who wrote it; null for learned rules (and deleted accounts). */
  createdBy: string | null;
  /** The dismissed finding a learned rule came from, while it exists. */
  sourceFinding: { href: string | null; title: string; path: string } | null;
}

/**
 * Link to a finding in its review run's Findings tab (the pass is the run's step); null for a
 * review from before review runs, which has no page.
 */
export function findingHref(finding: {
  id: string;
  reviewId: string;
  reviewRunId: string | null;
}): string | null {
  if (!finding.reviewRunId) return null;
  return `${runHref(finding.reviewRunId, { step: finding.reviewId, tab: "findings" })}#finding-${finding.id}`;
}

export function ruleView(entry: RuleEntry): RuleView {
  return {
    id: entry.id,
    kind: entry.kind,
    text: entry.text,
    enabled: entry.enabled,
    createdAt: entry.createdAt.toISOString(),
    createdBy: entry.createdBy ? userDisplayName(entry.createdBy) : null,
    sourceFinding: entry.sourceFinding && {
      href: findingHref(entry.sourceFinding),
      title: entry.sourceFinding.title,
      path: entry.sourceFinding.path,
    },
  };
}
