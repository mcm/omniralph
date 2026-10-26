import "server-only";
import { getRepositoryWithConnection, getReview, type Database } from "@omniralph/db";
import type { ChangeRequestState } from "@omniralph/scm";
import type { RerunReviewInput, ReviewDepth, ReviewMode } from "@omniralph/shared";
import type { JobDispatcher } from "@/lib/dispatch";
import { scmAdapterFor } from "@/lib/scm/adapters";
import { enqueueReview, type ReviewTaskRun } from "./enqueue";

/**
 * What a re-run reviews with: the Re-run dialog's mode and depth, or (a retry of a review
 * run) the run's own mode and depth.
 */
export type RerunReviewOptions =
  RerunReviewInput | { runMode: ReviewMode; depth: ReviewDepth | null };

/** The review mode a re-run enqueues. */
function rerunMode(options: RerunReviewOptions): ReviewMode {
  if ("runMode" in options) return options.runMode;
  return options.mode === "fresh" ? "fresh" : "full";
}

export type RerunReviewResult =
  | {
      status: "enqueued" | "duplicate";
      reviewRunId: string;
      runs: ReviewTaskRun[];
      /** The review run's review of the re-run review's task (else its first) and its job. */
      reviewId: string;
      jobId: string;
      headSha: string;
    }
  | { status: "not_found" | "repository_unavailable" | "no_review_tasks" }
  | { status: "not_open"; state: Exclude<ChangeRequestState, "open"> }
  | { status: "scm_error"; error: string };

/**
 * Re-runs a review from the control panel (`POST /api/ui/reviews/{id}/rerun`): looks up the PR's
 * **current** head on the code host and enqueues a `manual` review run of
 * it (every review task of the repository) through `enqueueReview`. Incremental reviews the whole diff for new issues
 * (mode `full`, like `@bot review`: open findings are still dropped as
 * duplicates); Fresh reviews it from scratch (mode `fresh`). A closed or
 * merged PR gets no job; an active review of the same head is returned as
 * `duplicate` (the dedupe key). Only reviews of `organizationId` are re-run. A retry of a review
 * run (`runMode`) keeps the run's mode and profile instead.
 */
export async function rerunReview(
  db: Database,
  dispatcher: JobDispatcher,
  input: { organizationId: string; reviewId: string } & RerunReviewOptions,
): Promise<RerunReviewResult> {
  const review = await getReview(db, input.reviewId);
  if (!review) return { status: "not_found" };
  const found = await getRepositoryWithConnection(db, review.repositoryId);
  // Another organization's review doesn't exist as far as the caller can tell.
  if (found && found.repository.organizationId !== input.organizationId) {
    return { status: "not_found" };
  }
  if (!found || found.repository.disconnectedAt || !found.repository.reviewsEnabled) {
    return { status: "repository_unavailable" };
  }
  const { repository, connection } = found;

  let cr;
  try {
    cr = await scmAdapterFor(db, connection).getChangeRequest(
      { fullPath: repository.fullPath, externalId: repository.externalId },
      review.prNumber,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("couldn't look up the change request to re-run a review", {
      reviewId: review.id,
      error: message,
    });
    return { status: "scm_error", error: message };
  }
  if (cr.state !== "open") return { status: "not_open", state: cr.state };

  const result = await enqueueReview(db, dispatcher, {
    repositoryId: repository.id,
    prNumber: review.prNumber,
    baseSha: cr.startSha ?? cr.baseSha,
    headSha: cr.headSha,
    title: cr.title,
    description: cr.description,
    author: cr.author,
    trigger: "manual",
    mode: rerunMode(input),
    depth: input.depth,
  });
  switch (result.status) {
    case "enqueued":
    case "duplicate": {
      const same = result.runs.find((run) => run.taskId === review.taskId);
      return {
        status: result.status,
        reviewRunId: result.reviewRunId,
        runs: result.runs,
        reviewId: same?.reviewId ?? result.reviewId,
        jobId: same?.jobId ?? result.jobId,
        headSha: cr.headSha,
      };
    }
    default:
      return { status: result.status };
  }
}
