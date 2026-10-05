import "server-only";
import type { FindingRow, ReviewDetail, ReviewListEntry, ReviewStatus } from "@omniralph/db";
import { changeRequestWebUrl } from "@/lib/repositories/web-url";
import type { FileFindings, FindingView, ReviewDetailView, ReviewRow } from "./display";

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

/**
 * Findings grouped by file: files in the order of their first finding,
 * findings within a file by start line.
 */
export function groupFindingsByFile(rows: FindingRow[]): FileFindings[] {
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
    files: groupFindingsByFile(detail.findings),
    findingCount: detail.findings.length,
    createdAt: review.createdAt.toISOString(),
    updatedAt: review.updatedAt.toISOString(),
  };
}
