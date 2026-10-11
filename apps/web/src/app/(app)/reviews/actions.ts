"use server";

import { RerunReviewInput } from "@omniralph/shared";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { AuthorizationError } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { getDispatcher } from "@/lib/dispatch";
import { rerunReview as rerun } from "@/lib/review/rerun";

export type RerunActionResult =
  | { ok: true; /** The new review. */ reviewId: string }
  | {
      ok: false;
      error: string;
      /** The queued or running review of the same head, when that's why nothing was enqueued. */
      activeReviewId?: string;
    };

/**
 * Re-runs a review on its PR's current head (admins only): Incremental
 * reviews the whole diff for new issues, Fresh from scratch; the profile is
 * the repository's default or a built-in override. Closed or merged PRs and
 * heads with an active review get an error and no job. Members are rejected
 * (like `runAdminAction`, which only returns plain `ActionResult`s).
 */
export async function rerunReview(
  reviewId: string,
  input: RerunReviewInput,
): Promise<RerunActionResult> {
  let admin;
  try {
    admin = await requireUser("admin");
  } catch (error) {
    if (error instanceof AuthorizationError) return { ok: false, error: error.message };
    throw error;
  }
  const parsed = RerunReviewInput.safeParse(input);
  if (!z.uuid().safeParse(reviewId).success) {
    return { ok: false, error: "That review doesn't exist." };
  }
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid re-run options." };
  }
  const result = await rerun(getDb(), getDispatcher(), {
    organizationId: admin.organization.id,
    reviewId,
    ...parsed.data,
  });
  switch (result.status) {
    case "enqueued":
      revalidatePath(`/reviews/${reviewId}`);
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
      return { ok: false, error: "That review doesn't exist." };
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
