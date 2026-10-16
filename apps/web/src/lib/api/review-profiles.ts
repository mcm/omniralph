import { z } from "zod";
import { isoDate } from "./schemas";

/** Settings › Review profiles (`/api/ui/review-profiles/**`, admins). */

const profileLimitsSchema = z.object({
  model: z.string(),
  maxTokensPerReview: z.number(),
  maxFiles: z.number(),
  allowRepoExploration: z.boolean(),
});

export const reviewProfileRowSchema = profileLimitsSchema.extend({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  updatedAt: isoDate,
  builtIn: z.boolean(),
  /** A built-in profile's original limits; null for others. */
  defaults: profileLimitsSchema.nullable(),
  /** The connected repositories using the profile, by path. */
  repositories: z.array(z.object({ id: z.string(), fullPath: z.string() })),
});
export type ReviewProfileRow = z.infer<typeof reviewProfileRowSchema>;

/** `GET /api/ui/review-profiles`: the profiles, and the models the harnesses report to pick from. */
export const reviewProfilesSchema = z.object({
  profiles: z.array(reviewProfileRowSchema),
  choices: z.object({
    models: z.array(
      z.object({ value: z.string(), displayName: z.string(), harnessIds: z.array(z.string()) }),
    ),
    harnessCount: z.number(),
  }),
});
export type ReviewProfiles = z.infer<typeof reviewProfilesSchema>;
