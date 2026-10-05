import "server-only";
import { getRepositoryWithConnection, getReview, type Database } from "@omniralph/db";
import type { ChangeRequestState } from "@omniralph/scm";
import type { RerunReviewInput } from "@omniralph/shared";
import type { JobDispatcher } from "@/lib/dispatch";
import { scmAdapterFor } from "@/lib/scm/adapters";
import { enqueueReview } from "./enqueue";

export type RerunReviewResult =
  | { status: "enqueued" | "duplicate"; reviewId: string; jobId: string; headSha: string }
  | { status: "not_found" | "repository_unavailable" | "profile_not_found" }
  | { status: "not_open"; state: Exclude<ChangeRequestState, "open"> }
  | { status: "scm_error"; error: string };

/**
 * Re-runs a review from the control panel (Re-run button): looks up the PR's
 * **current** head on the code host and enqueues a `manual` review of it
 * through `enqueueReview`. Incremental reviews the whole diff for new issues
 * (mode `full`, like `@bot review`: open findings are still dropped as
 * duplicates); Fresh reviews it from scratch (mode `fresh`). A closed or
 * merged PR gets no job; an active review of the same head is returned as
 * `duplicate` (the dedupe key).
 */
export async function rerunReview(
  db: Database,
  dispatcher: JobDispatcher,
  input: { reviewId: string } & RerunReviewInput,
): Promise<RerunReviewResult> {
  const review = await getReview(db, input.reviewId);
  if (!review) return { status: "not_found" };
  const found = await getRepositoryWithConnection(db, review.repositoryId);
  if (!found || !found.repository.enabled || found.repository.disconnectedAt) {
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
    mode: input.mode === "fresh" ? "fresh" : "full",
    profileId: input.profileId,
  });
  switch (result.status) {
    case "enqueued":
    case "duplicate":
      return {
        status: result.status,
        reviewId: result.reviewId,
        jobId: result.jobId,
        headSha: cr.headSha,
      };
    default:
      return { status: result.status };
  }
}
