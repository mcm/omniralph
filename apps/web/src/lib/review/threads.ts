import "server-only";
import {
  getRepositoryWithConnection,
  getReview,
  type Database,
  type FindingRow,
} from "@omniralph/db";
import { repositoryWebUrl } from "@/lib/repositories/web-url";
import { scmAdapterFor } from "@/lib/scm/adapters";
import { MAX_BODY_CHARS, sanitizeCapped } from "./sanitize";

export interface FindingThread {
  /** An earlier finding with an SCM thread (`scmCommentId`). */
  finding: FindingRow;
  /** The new review's page (or one of its findings) the reply links to. */
  link: string;
}

/**
 * Replies `message` (sanitized) plus a link to the new review in each earlier
 * finding's SCM thread, then resolves the thread. `kind` names the findings
 * in log messages. A failed reply or resolve is only logged, so it never
 * fails the review.
 */
export async function closeFindingThreads(
  db: Database,
  reviewId: string,
  input: { kind: string; message: string; threads: readonly FindingThread[] },
): Promise<void> {
  if (input.threads.length === 0) return;
  const review = await getReview(db, reviewId);
  const found = review && (await getRepositoryWithConnection(db, review.repositoryId));
  if (!review || !found) {
    console.warn(`couldn't resolve ${input.kind} findings' threads: repository not found`, {
      reviewId,
    });
    return;
  }
  const { repository, connection } = found;
  const adapter = scmAdapterFor(db, connection);
  const repo = { fullPath: repository.fullPath, externalId: repository.externalId };
  const webUrl = repositoryWebUrl(repository.provider, connection.baseUrl, repository.fullPath);
  const text = sanitizeCapped(
    input.message,
    { allowedHosts: [new URL(webUrl).hostname], author: null },
    MAX_BODY_CHARS,
  );

  for (const { finding, link } of input.threads) {
    const commentId = finding.scmCommentId;
    if (commentId === null) continue;
    const body = `${text}\n\n[View the new review](${link})`;
    const steps = [
      ["reply to", () => adapter.replyToComment(repo, review.prNumber, commentId, body)],
      ["resolve", () => adapter.resolveThread(repo, review.prNumber, commentId)],
    ] as const;
    for (const [step, run] of steps) {
      try {
        await run();
      } catch (error) {
        console.warn(`couldn't ${step} a ${input.kind} finding's SCM thread`, {
          findingId: finding.id,
          reviewId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
