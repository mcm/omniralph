import "server-only";
import { getFindingOrganizationId, type Database } from "@omniralph/db";
import type { DismissFindingInput, RerunReviewInput } from "@omniralph/shared";
import type { ActionResult } from "@/lib/action-result";
import type { JobDispatcher } from "@/lib/dispatch";
import { rerunReview as rerun } from "@/lib/review/rerun";
import { dismissFindingWithFeedback, restoreDismissedFinding } from "./feedback";

export const REVIEW_NOT_FOUND = "That review doesn't exist.";
export const FINDING_NOT_FOUND = "That finding doesn't exist.";

export type RerunOutcome =
  | { ok: true; /** The new review. */ reviewId: string }
  | {
      ok: false;
      error: string;
      /** The queued or running review of the same head, when that's why nothing was enqueued. */
      activeReviewId?: string;
      /** The review isn't one of the organization's. */
      notFound?: boolean;
    };

/**
 * Re-runs a review of `organizationId` on its PR's current head (admins: the caller checks):
 * Incremental reviews the whole diff for new issues, Fresh from scratch; the profile is the
 * repository's default or a built-in override. Closed or merged PRs and heads with an
 * active review get an error and no job.
 */
export async function rerunOrganizationReview(
  db: Database,
  dispatcher: JobDispatcher,
  organizationId: string,
  reviewId: string,
  input: RerunReviewInput,
): Promise<RerunOutcome> {
  const result = await rerun(db, dispatcher, { organizationId, reviewId, ...input });
  switch (result.status) {
    case "enqueued":
      return { ok: true, reviewId: result.reviewId };
    case "duplicate":
      return {
        ok: false,
        error: `A review of ${result.headSha.slice(0, 12)} is already queued or running.`,
        activeReviewId: result.reviewId,
      };
    case "not_open":
      return {
        ok: false,
        error: `This change request is ${result.state}, so it can't be reviewed again.`,
      };
    case "not_found":
      return { ok: false, error: REVIEW_NOT_FOUND, notFound: true };
    case "repository_unavailable":
      return { ok: false, error: "Reviews are disabled or the repository is disconnected." };
    case "profile_not_found":
      return { ok: false, error: "That review profile doesn't exist." };
    case "no_review_tasks":
      return { ok: false, error: "None of the repository's review tasks can be re-run." };
    case "scm_error":
      return {
        ok: false,
        error: "Couldn't look up the change request on the code host. Try again later.",
      };
  }
}

/** Whether the finding is one of the organization's. */
export async function findingInOrganization(
  db: Database,
  organizationId: string,
  findingId: string,
): Promise<boolean> {
  return (await getFindingOrganizationId(db, findingId)) === organizationId;
}

/**
 * Dismisses an open finding (one of the caller's organization: see `findingInOrganization`)
 * from the control panel: records `ui` feedback by `userId` and resolves the finding's SCM
 * thread. A thread that can't be resolved comes back as a warning; the dismissal still stands.
 */
export async function dismissFindingFromPanel(
  db: Database,
  { findingId, userId, input }: { findingId: string; userId: string; input: DismissFindingInput },
): Promise<ActionResult> {
  const result = await dismissFindingWithFeedback(db, {
    findingId,
    source: "ui",
    reason: input.reason,
    note: input.note ?? null,
    userId,
  });
  switch (result.status) {
    case "not_found":
      return { ok: false, error: FINDING_NOT_FOUND };
    case "conflict":
      return { ok: false, error: "Only open findings can be dismissed." };
  }
  return result.scmWarning ? { ok: true, warning: result.scmWarning } : { ok: true };
}

/** Restores a dismissed finding to `open`; its feedback stays in the history, marked restored. */
export async function restoreFindingFromPanel(
  db: Database,
  { findingId, userId }: { findingId: string; userId: string },
): Promise<ActionResult> {
  const result = await restoreDismissedFinding(db, { findingId, userId });
  switch (result.status) {
    case "not_found":
      return { ok: false, error: FINDING_NOT_FOUND };
    case "conflict":
      return { ok: false, error: "Only dismissed findings can be restored." };
  }
  return { ok: true };
}
