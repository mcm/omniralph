import { z } from "zod";
import { apiHandler } from "@/lib/api/handler";
import { getDb } from "@/lib/db";
import { updateReviewProfile } from "@/lib/review-profiles/manage";

/**
 * Saves a review profile's model and limits (`ReviewProfileInput`). The body is checked in
 * `updateReviewProfile`, so each invalid field gets its own field error.
 */
export const PUT = apiHandler<"admin", z.ZodUnknown, undefined, { id: string }>(
  { access: "admin", body: z.unknown() },
  async ({ user, params, body }) =>
    updateReviewProfile(getDb(), user.organization.id, params.id, body),
);
