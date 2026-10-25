import "server-only";
import {
  dismissFinding,
  getRepositoryWithConnection,
  type Database,
  type DismissFindingInput,
  type FindingRow,
  type Review,
} from "@omniralph/db";
import { getDispatcher, type JobDispatcher } from "@/lib/dispatch";
import { enqueueLearnRule } from "@/lib/rules/learn";
import { scmAdapterFor } from "@/lib/scm/adapters";

export type FindingFeedbackResult =
  | {
      status: "ok";
      finding: FindingRow;
      /** Set when resolving the SCM thread failed. */ scmWarning?: string;
      /** The `review.learn-rule` job a false-positive dismissal enqueued. */
      learnRuleJobId?: string;
    }
  | { status: "not_found" }
  | { status: "conflict"; finding: FindingRow };

/** Resolves the finding's inline thread on the code host; returns a warning instead of throwing. */
async function resolveFindingThread(
  db: Database,
  review: Review,
  finding: FindingRow,
): Promise<string | undefined> {
  // Findings that fell back into the summary comment have no thread of their own.
  if (!finding.scmCommentId) return undefined;
  try {
    const found = await getRepositoryWithConnection(db, review.repositoryId);
    if (!found) throw new Error("the repository isn't connected");
    const { repository, connection } = found;
    await scmAdapterFor(db, connection).resolveThread(
      { fullPath: repository.fullPath, externalId: repository.externalId },
      review.prNumber,
      finding.scmCommentId,
    );
    return undefined;
  } catch (error) {
    console.warn("couldn't resolve the finding's SCM thread", {
      findingId: finding.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return "The finding was dismissed, but its thread on the code host couldn't be resolved.";
  }
}

/**
 * Dismisses an open finding (`@bot dismiss` in its thread): sets it to
 * `dismissed`, records `scm` feedback by the code-host login and resolves the
 * SCM thread. A false-positive
 * dismissal also enqueues a `review.learn-rule` job. A failure to resolve the
 * thread doesn't undo the dismissal; it comes back as a warning. A failure to
 * enqueue rule generation is only logged.
 */
export async function dismissFindingWithFeedback(
  db: Database,
  input: DismissFindingInput,
  dispatcher: JobDispatcher = getDispatcher(),
): Promise<FindingFeedbackResult> {
  const result = await dismissFinding(db, input);
  if (result.status === "not_found") return result;
  if (result.status === "not_open") return { status: "conflict", finding: result.finding };
  const learnRuleJobId = await enqueueLearnRule(db, dispatcher, result).then(
    (enqueued) => ("jobId" in enqueued ? enqueued.jobId : undefined),
    (error: unknown) => {
      console.warn("couldn't enqueue rule generation", {
        feedbackId: result.feedback.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    },
  );
  const scmWarning = await resolveFindingThread(db, result.review, result.finding);
  return {
    status: "ok",
    finding: result.finding,
    ...(scmWarning ? { scmWarning } : {}),
    ...(learnRuleJobId ? { learnRuleJobId } : {}),
  };
}
