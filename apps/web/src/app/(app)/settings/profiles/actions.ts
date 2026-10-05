"use server";

import { updateReviewProfile as updateReviewProfileRow } from "@omniralph/db";
import { fieldErrors, ReviewProfileInput } from "@omniralph/shared";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import { runAdminAction } from "@/lib/auth/admin-action";
import { getDb } from "@/lib/db";

/**
 * Updates a review profile's model and limits. Review jobs enqueued from now
 * on use them; queued and running ones keep the profile they were created with.
 */
export async function updateReviewProfile(
  profileId: string,
  input: ReviewProfileInput,
): Promise<ActionResult> {
  return runAdminAction(async () => {
    const parsed = ReviewProfileInput.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Fix the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }
    if (!(await updateReviewProfileRow(getDb(), profileId, parsed.data))) {
      return { ok: false, error: "That profile doesn't exist." };
    }
    revalidatePath("/settings/profiles");
    revalidatePath("/repositories", "layout");
  });
}
