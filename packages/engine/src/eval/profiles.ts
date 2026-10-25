import { REVIEW_DEPTH_IDS, reviewProfileConfigForDepth } from "@omniralph/shared";
import type { ReviewProfileConfig } from "../prompt.js";

/**
 * The review depth presets (`REVIEW_DEPTHS` in `@omniralph/shared`) as the
 * profiles evals run with, so eval runs match production reviews.
 */
export const EVAL_PROFILES: readonly ReviewProfileConfig[] = REVIEW_DEPTH_IDS.map(
  reviewProfileConfigForDepth,
);

export const EVAL_PROFILE_IDS = EVAL_PROFILES.map((p) => p.id);

/** `all` or one depth → the profiles to run. */
export function selectProfiles(selection: string): ReviewProfileConfig[] {
  if (selection === "all") return [...EVAL_PROFILES];
  const profile = EVAL_PROFILES.find((p) => p.id === selection);
  if (!profile) {
    throw new Error(
      `Unknown profile "${selection}" (use ${[...EVAL_PROFILE_IDS, "all"].join(", ")})`,
    );
  }
  return [profile];
}
