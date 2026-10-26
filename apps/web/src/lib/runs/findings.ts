import "server-only";
/**
 * A review run's findings (`GET /api/ui/runs/{id}/findings`): each pass's findings from
 * `getReviewDetail`, grouped by file, with their dismissals.
 */
import {
  getReviewDetail,
  getReviewRunDetailFacts,
  reviewRunIdsOf,
  type Database,
  type RunIndexEntry,
} from "@omniralph/db";
import type { ReviewPassFindings, RunFindings } from "@/lib/api/runs";
import { groupFindingsByFile } from "@/lib/reviews/history";

/**
 * The findings of a review run's passes, in step order; null when the run isn't a review
 * run (or is gone). A superseded finding links to the later pass that replaced it.
 */
export async function loadRunFindings(
  db: Database,
  run: RunIndexEntry,
): Promise<RunFindings | null> {
  if (run.kind !== "review") return null;
  const facts = await getReviewRunDetailFacts(db, run.id);
  if (!facts) return null;
  const details = (
    await Promise.all(facts.passes.map((pass) => getReviewDetail(db, run.organizationId, pass.id)))
  ).filter((detail) => detail !== null);
  const runOf = await reviewRunIdsOf(
    db,
    details.flatMap((detail) => Object.values(detail.supersedingReviewIds)),
  );
  const passes = details.map((detail): ReviewPassFindings => {
    const files = groupFindingsByFile(
      detail.findings,
      detail.feedback,
      detail.supersedingReviewIds,
    ).map((file) => ({
      path: file.path,
      findings: file.findings.map(({ supersededBy, ...finding }) => ({
        ...finding,
        supersededBy:
          supersededBy && runOf[supersededBy.reviewId]
            ? {
                runId: runOf[supersededBy.reviewId]!,
                stepId: supersededBy.reviewId,
                findingId: supersededBy.findingId,
              }
            : null,
      })),
    }));
    return {
      id: detail.review.id,
      status: detail.review.status,
      files,
      findingCount: detail.findings.length,
      skippedFiles: detail.review.skippedFiles.map(({ path, reason }) => ({ path, reason })),
    };
  });
  return { passes };
}
