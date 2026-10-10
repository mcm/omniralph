import "server-only";
import { supersedeOpenFindings, type Database, type SupersededFinding } from "@omniralph/db";
import { sameIssue } from "@omniralph/engine/same-issue";
import { reviewUrl } from "./post";
import { closeFindingThreads } from "./threads";

/**
 * After a `fresh` review completed: every earlier `open` finding of the PR
 * that matches one of its findings (the engine's dedupe rule: same path,
 * overlapping lines, same category) becomes `superseded`, and its SCM thread
 * gets a short reply linking the new review and is resolved. Unmatched
 * findings are left to `resolveFindingsNotRaisedAgain`. A failed reply or
 * resolve is only logged, so it never fails the review. Safe to call again:
 * nothing open is left to supersede.
 */
export async function supersedeEarlierFindings(
  db: Database,
  reviewId: string,
): Promise<SupersededFinding[]> {
  const superseded = await supersedeOpenFindings(db, reviewId, (prior, next) =>
    sameIssue(prior, next),
  );
  await closeFindingThreads(db, reviewId, {
    kind: "superseded",
    message: "A fresh review raised this issue again, so this thread is superseded.",
    threads: superseded
      .filter((s) => s.finding.scmCommentId !== null)
      .map(({ finding, by }) => ({ finding, link: `${reviewUrl(reviewId)}#finding-${by.id}` })),
  });
  return superseded;
}
