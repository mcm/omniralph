import "server-only";
import {
  getRepositoryWithConnection,
  getReview,
  supersedeOpenFindings,
  type Database,
  type SupersededFinding,
} from "@omniralph/db";
import { sameIssue } from "@omniralph/engine/same-issue";
import { repositoryWebUrl } from "@/lib/repositories/web-url";
import { scmAdapterFor } from "@/lib/scm/adapters";
import { reviewUrl } from "./post";
import { MAX_BODY_CHARS, sanitizeCapped } from "./sanitize";

/**
 * After a `fresh` review completed: every earlier `open` finding of the PR
 * that matches one of its findings (the engine's dedupe rule: same path,
 * overlapping lines, same category) becomes `superseded`, and its SCM thread
 * gets a short reply linking the new review and is resolved. Unmatched
 * findings stay `open`. A failed reply or resolve is only logged, so it never
 * fails the review. Safe to call again: nothing open is left to supersede.
 */
export async function supersedeEarlierFindings(
  db: Database,
  reviewId: string,
): Promise<SupersededFinding[]> {
  const superseded = await supersedeOpenFindings(db, reviewId, (prior, next) =>
    sameIssue(prior, next),
  );
  const threads = superseded.filter((s) => s.finding.scmCommentId !== null);
  if (threads.length === 0) return superseded;

  const review = await getReview(db, reviewId);
  const found = review && (await getRepositoryWithConnection(db, review.repositoryId));
  if (!review || !found) {
    console.warn("couldn't resolve superseded findings' threads: repository not found", {
      reviewId,
    });
    return superseded;
  }
  const { repository, connection } = found;
  const adapter = scmAdapterFor(db, connection);
  const repo = { fullPath: repository.fullPath, externalId: repository.externalId };
  const webUrl = repositoryWebUrl(repository.provider, connection.baseUrl, repository.fullPath);
  const text = sanitizeCapped(
    "A fresh review raised this issue again, so this thread is superseded.",
    { allowedHosts: [new URL(webUrl).hostname], author: null },
    MAX_BODY_CHARS,
  );

  for (const { finding, by } of threads) {
    const commentId = finding.scmCommentId!;
    const body = `${text}\n\n[View the new review](${reviewUrl(reviewId)}#finding-${by.id})`;
    const steps = [
      ["reply to", () => adapter.replyToComment(repo, review.prNumber, commentId, body)],
      ["resolve", () => adapter.resolveThread(repo, review.prNumber, commentId)],
    ] as const;
    for (const [step, run] of steps) {
      try {
        await run();
      } catch (error) {
        console.warn(`couldn't ${step} a superseded finding's SCM thread`, {
          findingId: finding.id,
          reviewId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return superseded;
}
