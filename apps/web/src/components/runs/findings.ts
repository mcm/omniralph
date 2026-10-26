/**
 * Pure helpers of a review pass's Findings tab: labels, the line range, the tab's count and
 * the empty state.
 */
import type {
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  ReviewFindingView,
  RunStep,
} from "@/lib/api/runs";

export const FINDING_SEVERITY_LABELS: Record<(typeof FINDING_SEVERITIES)[number], string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Info",
};

/** The status shown beside a finding that is no longer open. */
export const FINDING_STATUS_LABELS: Record<(typeof FINDING_STATUSES)[number], string> = {
  open: "Open",
  dismissed: "Dismissed",
  resolved: "Resolved",
  superseded: "Superseded",
  merged: "Merged",
};

/** "L12", or "L12–14" for a range. */
export function lineRange(finding: Pick<ReviewFindingView, "startLine" | "endLine">): string {
  return finding.startLine === finding.endLine
    ? `L${finding.startLine}`
    : `L${finding.startLine}–${finding.endLine}`;
}

/** "bug · 80% confidence". */
export function findingFacts(finding: Pick<ReviewFindingView, "category" | "confidence">): string {
  return `${finding.category} · ${Math.round(finding.confidence * 100)}% confidence`;
}

/** The pass's open findings: the Findings tab's count. */
export function openFindingsTotal(step: Extract<RunStep, { kind: "review_pass" }>): number {
  return Object.values(step.openFindings).reduce((sum, n) => sum + n, 0);
}

/** What the tab says when the pass has no findings, by the pass's status. */
export function noFindingsText(
  status: Extract<RunStep, { kind: "review_pass" }>["status"],
): string {
  switch (status) {
    case "queued":
    case "running":
      return "Findings appear here when the pass finishes.";
    case "completed":
    case "budget_exhausted":
      return "Om found nothing to report.";
    case "failed":
    case "skipped":
      return "This pass produced no findings.";
  }
}
