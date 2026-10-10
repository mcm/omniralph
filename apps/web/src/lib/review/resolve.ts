import "server-only";
import { resolveEarlierOpenFindings, type Database, type FindingRow } from "@omniralph/db";
import { sameIssue } from "@omniralph/engine/same-issue";
import type { ReviewJobPayload, ReviewJobResult } from "@omniralph/shared";
import { reviewUrl } from "./post";
import { inlineCode } from "./sanitize";
import { closeFindingThreads } from "./threads";

/**
 * The review re-checked the PR's earlier `open` findings it was given and
 * reported some fixed (`fixedOpenFindings`): those become `resolved`, and
 * their SCM threads get a short reply linking the new review and are
 * resolved. A finding the review didn't confirm fixed stays open, whatever
 * the scope: not raising it again is no verdict. One a new finding matches
 * (`sameIssue`) also stays open. Safe to call again.
 */
export async function resolveFixedFindings(
  db: Database,
  input: { reviewId: string; payload: ReviewJobPayload; result: ReviewJobResult },
): Promise<FindingRow[]> {
  const { payload, result } = input;
  const given = payload.previousReview?.openFindings ?? [];
  const fixed = new Set((result.fixedOpenFindings ?? []).flatMap((i) => given[i]?.id ?? []));
  if (fixed.size === 0) return [];
  const resolved = await resolveEarlierOpenFindings(
    db,
    input.reviewId,
    (prior) => fixed.has(prior.id) && !result.findings.some((f) => sameIssue(prior, f)),
  );

  const link = reviewUrl(input.reviewId);
  await closeFindingThreads(db, input.reviewId, {
    kind: "fixed",
    message: `A re-review of ${inlineCode(payload.headSha.slice(0, 12))} re-checked this issue and found it fixed, so this thread is resolved.`,
    threads: resolved
      .filter((finding) => finding.scmCommentId !== null)
      .map((finding) => ({ finding, link })),
  });
  return resolved;
}
