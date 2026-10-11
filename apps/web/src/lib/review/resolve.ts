import "server-only";
import {
  getReview,
  listReviewFindings,
  listReviewRunReviews,
  resolveEarlierOpenFindings,
  type Database,
  type FindingRow,
  type ReviewTarget,
} from "@omniralph/db";
import { sameIssue } from "@omniralph/engine/same-issue";
import { reviewUrl } from "./post";
import { inlineCode } from "./sanitize";
import { closeFindingThreads } from "./threads";

/**
 * The finished task runs of a review run (or a legacy review) re-checked the
 * PR's earlier `open` findings they were given and reported some fixed
 * (`fixed_finding_ids`): a finding every finished task run reported fixed
 * becomes `resolved`, and its SCM thread gets a short reply linking the new
 * review and is resolved. A finding not every task run confirmed fixed stays
 * open, whatever the scope: not raising it again is no verdict. One a new
 * finding of the run matches (`sameIssue`) also stays open. Findings of the
 * same review run never resolve each other. Summary-only task runs have no
 * say. Safe to call again.
 */
export async function resolveFixedFindings(
  db: Database,
  target: ReviewTarget,
): Promise<FindingRow[]> {
  const targetReviews =
    "reviewId" in target
      ? [await getReview(db, target.reviewId)].filter((r) => r !== null)
      : (await listReviewRunReviews(db, target.reviewRunId)).filter((r) => !r.summaryOnly);
  const finished = targetReviews.filter(
    (r) => r.status === "completed" || r.status === "budget_exhausted",
  );
  const [first, ...rest] = finished;
  if (!first) return [];
  const fixed = new Set(
    first.fixedFindingIds.filter((id) => rest.every((r) => r.fixedFindingIds.includes(id))),
  );
  if (fixed.size === 0) return [];
  const raised = (await Promise.all(finished.map((r) => listReviewFindings(db, r.id))))
    .flat()
    .filter((f) => f.status !== "merged");
  const resolved = await resolveEarlierOpenFindings(
    db,
    target,
    (prior) => fixed.has(prior.id) && !raised.some((f) => sameIssue(prior, f)),
  );

  const link = reviewUrl(first.id);
  await closeFindingThreads(db, first.id, {
    kind: "fixed",
    message: `A re-review of ${inlineCode(first.headSha.slice(0, 12))} re-checked this issue and found it fixed, so this thread is resolved.`,
    threads: resolved
      .filter((finding) => finding.scmCommentId !== null)
      .map((finding) => ({ finding, link })),
  });
  return resolved;
}
