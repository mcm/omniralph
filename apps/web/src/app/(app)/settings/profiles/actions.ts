"use server";

import { updateReviewProfile as updateReviewProfileRow } from "@omniralph/db";
import { fieldErrors, ReviewProfileInput } from "@omniralph/shared";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import { runAdminAction } from "@/lib/auth/admin-action";
import { getDb } from "@/lib/db";

/**
 * Updates a review profile of the admin's active organization: its model and limits. Review jobs enqueued from now
 * on use them; queued and running ones keep the profile they were created with.
 */
export async function updateReviewProfile(
  profileId: string,
  input: ReviewProfileInput,
): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const parsed = ReviewProfileInput.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Fix the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }
    if (!(await updateReviewProfileRow(getDb(), admin.organization.id, profileId, parsed.data))) {
      return { ok: false, error: "That profile doesn't exist." };
    }
    revalidatePath("/settings/profiles");
    revalidatePath("/repositories", "layout");
  });
}
