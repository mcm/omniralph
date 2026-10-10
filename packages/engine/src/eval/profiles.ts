import type { ReviewProfileConfig } from "../prompt.js";

/**
 * The built-in profiles as seeded by `packages/db/drizzle/0001_seed_review_profiles.sql`.
 * Evals use these defaults (not a database's edited copies) so runs stay comparable;
 * update both together.
 */
export const EVAL_PROFILES: readonly ReviewProfileConfig[] = [
  {
    id: "quick",
    name: "Quick",
    model: "claude-haiku-5-5",
    maxTokensPerReview: 60_000,
    maxFiles: 15,
    allowRepoExploration: false,
  },
  {
    id: "standard",
    name: "Standard",
    model: "claude-sonnet-5-5",
    maxTokensPerReview: 200_000,
    maxFiles: 40,
    allowRepoExploration: true,
  },
  {
    id: "deep",
    name: "Deep",
    model: "claude-opus-5-5",
    maxTokensPerReview: 500_000,
    maxFiles: 100,
    allowRepoExploration: true,
  },
];

export const EVAL_PROFILE_IDS = EVAL_PROFILES.map((p) => p.id);

/** `all` or one profile ID → the profiles to run. */
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
