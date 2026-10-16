import "server-only";
import {
  BUILT_IN_REVIEW_PROFILES,
  listActiveHarnessIds,
  listProfileRepositories,
  listReportedModels,
  listReviewProfiles,
  updateReviewProfile as updateReviewProfileRow,
  type Database,
} from "@omniralph/db";
import { fieldErrors, ReviewProfileInput } from "@omniralph/shared";
import type { ActionResult } from "@/lib/action-result";
import type { ReviewProfiles } from "@/lib/api/review-profiles";

/**
 * Settings › Review profiles: the logic behind the `/api/ui/review-profiles/**` handlers,
 * which parse, authorize and serialize. Every function is scoped to `organizationId`.
 */

/** The organization's review profiles with the repositories using each, and the model choices. */
export async function loadReviewProfiles(
  db: Database,
  organizationId: string,
): Promise<ReviewProfiles> {
  const [profiles, repositories, harnessIds, models] = await Promise.all([
    listReviewProfiles(db, organizationId),
    listProfileRepositories(db, organizationId),
    listActiveHarnessIds(db, organizationId),
    listReportedModels(db, organizationId),
  ]);
  return {
    choices: { models, harnessCount: harnessIds.length },
    profiles: profiles.map((p) => {
      const builtIn = BUILT_IN_REVIEW_PROFILES.find((b) => b.id === p.id);
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        model: p.model,
        maxTokensPerReview: p.maxTokensPerReview,
        maxFiles: p.maxFiles,
        allowRepoExploration: p.allowRepoExploration,
        updatedAt: p.updatedAt.toISOString(),
        builtIn: p.builtIn,
        defaults: builtIn
          ? {
              model: builtIn.model,
              maxTokensPerReview: builtIn.maxTokensPerReview,
              maxFiles: builtIn.maxFiles,
              allowRepoExploration: builtIn.allowRepoExploration,
            }
          : null,
        repositories: repositories
          .filter((r) => r.profileId === p.id)
          .map((r) => ({ id: r.id, fullPath: r.fullPath })),
      };
    }),
  };
}

/**
 * Updates a review profile of the organization: its model and limits. Review jobs enqueued
 * from now on use them; queued and running ones keep the profile they were created with.
 */
export async function updateReviewProfile(
  db: Database,
  organizationId: string,
  profileId: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = ReviewProfileInput.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Fix the highlighted fields.",
      fieldErrors: fieldErrors(parsed.error),
    };
  }
  if (!(await updateReviewProfileRow(db, organizationId, profileId, parsed.data))) {
    return { ok: false, error: "That profile doesn't exist." };
  }
  return { ok: true };
}
