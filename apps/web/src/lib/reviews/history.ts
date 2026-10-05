import "server-only";
import type {
  FeedbackEntry,
  FindingRow,
  ReviewDetail,
  ReviewListEntry,
  ReviewStatus,
} from "@omniralph/db";
import { changeRequestWebUrl } from "@/lib/repositories/web-url";
import { userDisplayName } from "@/lib/user-display";
import type {
  FeedbackView,
  FileFindings,
  FindingView,
  ReviewDetailView,
  ReviewRow,
} from "./display";

/** A list entry as serializable view props. */
export function reviewRow(entry: ReviewListEntry): ReviewRow {
  const { repository } = entry;
  return {
    id: entry.id,
    repository: {
      id: repository.id,
      provider: repository.provider,
      fullPath: repository.fullPath,
    },
    prNumber: entry.prNumber,
    prTitle: entry.prTitle,
    prUrl: changeRequestWebUrl(
      repository.provider,
      repository.baseUrl,
      repository.fullPath,
      entry.prNumber,
    ),
    trigger: entry.trigger,
    status: entry.status,
    profileName: entry.profile?.name ?? null,
    agent: entry.agent,
    findingCounts: entry.findingCounts,
    tokensUsed: entry.tokensIn + entry.tokensOut,
    budget: entry.budget,
    durationMs: entry.durationMs,
    error: entry.error,
    createdAt: entry.createdAt.toISOString(),
  };
}

/** Why the review stopped, derived from its final status (null while it's active). */
export function stopReason(status: ReviewStatus): string | null {
  switch (status) {
    case "completed":
      return "Completed";
    case "budget_exhausted":
      return "Token budget exhausted (partial findings)";
    case "failed":
      return "Failed";
    case "skipped":
      return "Skipped";
    case "queued":
    case "running":
      return null;
  }
}

/** A feedback entry as view props; thread dismissals name the code-host login. */
export function feedbackView(entry: FeedbackEntry): FeedbackView {
  const actor = entry.user
    ? userDisplayName(entry.user)
    : entry.scmUsername
      ? `@${entry.scmUsername}`
      : "Unknown user";
  return {
    id: entry.id,
    source: entry.source,
    reason: entry.reason,
    note: entry.note,
    actor,
    createdAt: entry.createdAt.toISOString(),
    restoredAt: entry.restoredAt?.toISOString() ?? null,
    restoredBy: entry.restoredAt
      ? entry.restoredBy
        ? userDisplayName(entry.restoredBy)
        : "Unknown user"
      : null,
  };
}

/**
 * Findings grouped by file: files in the order of their first finding,
 * findings within a file by start line.
 */
export function groupFindingsByFile(
  rows: FindingRow[],
  feedback: FeedbackEntry[] = [],
  supersedingReviewIds: Record<string, string> = {},
): FileFindings[] {
  const feedbackByFinding = new Map<string, FeedbackView[]>();
  for (const entry of feedback) {
    const list = feedbackByFinding.get(entry.findingId) ?? [];
    list.push(feedbackView(entry));
    feedbackByFinding.set(entry.findingId, list);
  }
  const byPath = new Map<string, FindingView[]>();
  for (const row of rows) {
    const list = byPath.get(row.path) ?? [];
    list.push({
      id: row.id,
      startLine: row.startLine,
      endLine: row.endLine,
      severity: row.severity,
      category: row.category,
      title: row.title,
      body: row.body,
      suggestion: row.suggestion,
      confidence: row.confidence,
      status: row.status,
      supersededBy:
        row.supersededByFindingId && supersedingReviewIds[row.supersededByFindingId]
          ? {
              reviewId: supersedingReviewIds[row.supersededByFindingId]!,
              findingId: row.supersededByFindingId,
            }
          : null,
      feedback: feedbackByFinding.get(row.id) ?? [],
    });
    byPath.set(row.path, list);
  }
  return [...byPath].map(([path, findings]) => ({
    path,
    findings: findings.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine),
  }));
}

/** A review's detail as serializable view props. */
export function reviewDetailView(detail: ReviewDetail): ReviewDetailView {
  const { review, repository } = detail;
  return {
    id: review.id,
    repository: {
      id: repository.id,
      provider: repository.provider,
      fullPath: repository.fullPath,
    },
    prNumber: review.prNumber,
    prTitle: review.prTitle,
    prUrl: changeRequestWebUrl(
      repository.provider,
      repository.baseUrl,
      repository.fullPath,
      review.prNumber,
    ),
    headSha: review.headSha,
    baseSha: review.baseSha,
    trigger: review.trigger,
    status: review.status,
    profileName: detail.profile?.name ?? null,
    model: review.model,
    agent: detail.agent,
    tokensIn: review.tokensIn,
    tokensOut: review.tokensOut,
    budget: review.budget,
    durationMs: review.durationMs,
    stopReason: stopReason(review.status),
    error: review.error,
    skippedFiles: review.skippedFiles.map(({ path, reason }) => ({ path, reason })),
    files: groupFindingsByFile(detail.findings, detail.feedback, detail.supersedingReviewIds),
    findingCount: detail.findings.length,
    createdAt: review.createdAt.toISOString(),
    updatedAt: review.updatedAt.toISOString(),
  };
}
