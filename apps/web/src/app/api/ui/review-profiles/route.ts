import { apiHandler } from "@/lib/api/handler";
import type { ReviewProfiles } from "@/lib/api/review-profiles";
import { getDb } from "@/lib/db";
import { loadReviewProfiles } from "@/lib/review-profiles/manage";

/** Settings › Review profiles (admins): the profiles and the models to pick from. */
export const GET = apiHandler({ access: "admin" }, async ({ user }): Promise<ReviewProfiles> =>
  loadReviewProfiles(getDb(), user.organization.id),
);
