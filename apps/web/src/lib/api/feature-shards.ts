import { z } from "zod";
import { isoDate } from "./schemas";

/**
 * Sharding a feature's Plan into epics (`/api/ui/features/{id}/shard/**`): Om drafts the
 * epics as a loop, a person reviews each draft (edit, remove, approve), and the approved
 * ones are filed as epics in the tracker. Members read it; admins start, review and file.
 * Safe to import in the browser.
 */

export const FEATURE_SHARD_STATUSES = [
  "drafting",
  "review",
  "filing",
  "filed",
  "failed",
  "canceled",
] as const;
export type FeatureShardStatusValue = (typeof FEATURE_SHARD_STATUSES)[number];

export const FEATURE_SHARD_DECISIONS = ["pending", "approved", "removed"] as const;
export type FeatureShardDecisionValue = (typeof FEATURE_SHARD_DECISIONS)[number];

/** The longest epic title, as the tracker takes it. */
export const SHARD_TITLE_MAX_LENGTH = 255;
/** The longest epic description. */
export const SHARD_DESCRIPTION_MAX_LENGTH = 50_000;

export const featureShardDraftSchema = z.object({
  key: z.string(),
  title: z.string(),
  /** The epic in the epic format (Markdown). */
  description: z.string(),
  /** The Plan sections it covers. */
  covers: z.array(z.string()),
  /** The keys of the drafts it waits for (epic→epic blocks relations once filed). */
  dependsOn: z.array(z.string()),
  /** The verifier's notes on it. */
  notes: z.array(z.string()),
  decision: z.enum(FEATURE_SHARD_DECISIONS),
  edited: z.boolean(),
  /** The epic it was filed as, once filed. */
  filed: z.object({ identifier: z.string(), url: z.string() }).nullable(),
});
export type FeatureShardDraftRow = z.infer<typeof featureShardDraftSchema>;

/** One round of the sharding loop. */
export const featureShardRoundSchema = z.object({
  number: z.number(),
  status: z.enum(["working", "verifying", "done", "failed"]),
  /** Whether Om's check and the verifier both passed it; null until both answered. */
  passed: z.boolean().nullable(),
  /** The verifier's summary, Om's problems or why it failed. */
  summary: z.string().nullable(),
});
export type FeatureShardRound = z.infer<typeof featureShardRoundSchema>;

export const featureShardSchema = z.object({
  id: z.string(),
  status: z.enum(FEATURE_SHARD_STATUSES),
  /** The Plan version it shards. */
  planVersion: z.number(),
  /** The Plan's sections an epic can cover. */
  sections: z.array(z.object({ name: z.string(), body: z.string() })),
  drafts: z.array(featureShardDraftSchema),
  /** The sections the drafts say need no epic, with why. */
  exempt: z.array(z.object({ section: z.string(), reason: z.string() })),
  summary: z.string().nullable(),
  /** What still failed the checks when the loop stopped at its cap. */
  leftovers: z.array(z.string()),
  error: z.string().nullable(),
  rounds: z.array(featureShardRoundSchema),
  /** The loop's cap. */
  maxRounds: z.number().nullable(),
  /** The repo whose team and project the drafts were filed in. */
  repositoryId: z.string().nullable(),
  createdAt: isoDate,
  filedAt: isoDate.nullable(),
});
export type FeatureShardRow = z.infer<typeof featureShardSchema>;

/**
 * `GET /api/ui/features/{id}/shard`: the feature's newest sharding (null when never sharded),
 * where the tracker shows features, and the feature's parent issue once it has one.
 */
export const featureShardViewSchema = z.object({
  shard: featureShardSchema.nullable(),
  featureMapping: z.enum(["omniralph", "parent-issue"]).nullable(),
  parentIssue: z.object({ identifier: z.string(), url: z.string() }).nullable(),
});
export type FeatureShardView = z.infer<typeof featureShardViewSchema>;

/** `PATCH /api/ui/features/{id}/shard/drafts/{key}`: edits, removes or approves a draft. */
export const updateShardDraftBodySchema = z
  .strictObject({
    title: z
      .string()
      .trim()
      .min(1, { error: "Give the epic a title." })
      .max(SHARD_TITLE_MAX_LENGTH, {
        error: `Keep the title to ${SHARD_TITLE_MAX_LENGTH} characters.`,
      })
      .optional(),
    description: z
      .string()
      .trim()
      .min(1, { error: "Describe the epic." })
      .max(SHARD_DESCRIPTION_MAX_LENGTH, { error: "The description is too long." })
      .optional(),
    decision: z.enum(FEATURE_SHARD_DECISIONS).optional(),
  })
  .refine(
    (body) =>
      body.title !== undefined || body.description !== undefined || body.decision !== undefined,
    { error: "Nothing to change." },
  );
export type UpdateShardDraftBody = z.infer<typeof updateShardDraftBodySchema>;

/** `POST /api/ui/features/{id}/shard/file`: files the approved drafts in the repo's team and project. */
export const fileShardBodySchema = z.strictObject({
  repositoryId: z.uuid({ error: "Choose a repo." }),
});
export type FileShardBody = z.infer<typeof fileShardBodySchema>;
