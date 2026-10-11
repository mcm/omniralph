import "server-only";
import { getReviewRun, listReviewRunReviews, type Database } from "@omniralph/db";
import { onReviewForRalph } from "@/lib/ralph/jobs";
import { postReviewRun } from "./post";
import { resolveFixedFindings } from "./resolve";
import { supersedeEarlierFindings } from "./supersede";

/**
 * After a review run may have ended (its last task run settled, or its
 * correlation applied or failed): a `completed` run is posted as one review
 * (once); then a `fresh` run supersedes the PR's earlier open findings it
 * raised again, the earlier open findings every finished task run found
 * fixed are resolved, and a ralph PR/MR's open findings go back to its run
 * (`onReviewForRalph`, at most once per review run). A `failed` run gets
 * one failure note. Anything else is left alone, and so is a run whose
 * tasks are all summary-only (they post to sticky comments themselves).
 * Safe to call again, e.g.
 * for a replayed result; that also retries a post that failed before.
 */
export async function finishReviewRun(db: Database, reviewRunId: string): Promise<void> {
  const run = await getReviewRun(db, reviewRunId);
  if (!run || (run.status !== "completed" && run.status !== "failed")) return;
  const reviews = await listReviewRunReviews(db, run.id);
  if (reviews.every((r) => r.summaryOnly)) return;
  await postReviewRun(db, run.id);
  if (run.status !== "completed") return;
  if (run.mode === "fresh") await supersedeEarlierFindings(db, { reviewRunId: run.id });
  await resolveFixedFindings(db, { reviewRunId: run.id });
  await onReviewForRalph(db, run.id);
}
