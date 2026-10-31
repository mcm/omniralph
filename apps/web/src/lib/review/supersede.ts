import "server-only";
import {
  reviewRunIdsOf,
  supersedeOpenFindings,
  type Database,
  type ReviewTarget,
  type SupersededFinding,
} from "@omniralph/db";
import { sameIssue } from "@omniralph/engine/same-issue";
import { reviewUrl } from "./post";
import { closeFindingThreads } from "./threads";

/**
 * After a `fresh` review run (or legacy review) completed: every earlier
 * `open` finding of the PR (not of the same review run) that matches one of
 * its findings (the engine's dedupe rule: same path, overlapping lines, same
 * category) becomes `superseded`, and its SCM thread gets a short reply
 * linking the new finding and is resolved. Unmatched findings stay `open`.
 * A failed reply or resolve is only logged, so it never fails the review.
 * Safe to call again: nothing open is left to supersede.
 */
export async function supersedeEarlierFindings(
  db: Database,
  target: ReviewTarget,
): Promise<SupersededFinding[]> {
  const superseded = await supersedeOpenFindings(db, target, (prior, next) =>
    sameIssue(prior, next),
  );
  const [first] = superseded;
  if (!first) return superseded;
  const runOf = await reviewRunIdsOf(
    db,
    superseded.map((s) => s.by.reviewId),
  );
  await closeFindingThreads(db, first.by.reviewId, {
    kind: "superseded",
    message: "A fresh review raised this issue again, so this thread is superseded.",
    threads: superseded
      .filter((s) => s.finding.scmCommentId !== null)
      .map(({ finding, by }) => ({
        finding,
        link: reviewUrl({ id: by.reviewId, reviewRunId: runOf[by.reviewId] ?? null }, by.id),
      })),
  });
  return superseded;
}
