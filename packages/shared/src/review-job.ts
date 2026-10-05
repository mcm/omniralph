/**
 * The `review.run` job: its payload (resolved by the control panel when the
 * job is enqueued) and the result an agent reports to `/result`.
 */
import { z } from "zod";
import { Finding, FindingCategory } from "./finding.js";
import { JobRepository } from "./protocol.js";

export const REVIEW_CAPABILITY = "review";
export const REVIEW_JOB_TYPE = "review.run";

export const CommitSha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

/** The `review_profiles` fields a review runs with. */
export const ReviewProfileConfig = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  /** Null uses the Claude Code default model. */
  model: z.string().min(1).max(200).nullable(),
  maxTokensPerReview: z.int().min(1),
  maxFiles: z.int().min(1),
  allowRepoExploration: z.boolean(),
});
export type ReviewProfileConfig = z.infer<typeof ReviewProfileConfig>;

export const ReviewRule = z.object({
  kind: z.enum(["custom", "learned"]),
  text: z.string().max(4000),
  enabled: z.boolean(),
});
export type ReviewRule = z.infer<typeof ReviewRule>;

/** A repository's review configuration, resolved at enqueue time. */
export const ReviewJobConfig = z.object({
  profile: ReviewProfileConfig,
  customInstructions: z.string().max(20_000).nullable(),
  rules: z.array(ReviewRule).max(500),
  pathExcludes: z.array(z.string().min(1).max(500)).max(500),
});
export type ReviewJobConfig = z.infer<typeof ReviewJobConfig>;

/**
 * Payload of a `review.run` job. It carries everything the agent needs except
 * credentials: git gets a short-lived read-only token from the broker.
 */
/** See `ReviewJobPayload.mode`. */
export const REVIEW_MODES = ["incremental", "full", "fresh"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

export const ReviewJobPayload = z.object({
  reviewId: z.uuid(),
  repositoryId: z.uuid(),
  repository: JobRepository,
  /** PR number (GitHub) or MR IID (GitLab). */
  prNumber: z.int().min(1),
  baseSha: CommitSha,
  headSha: CommitSha,
  /** PR/MR title and description (untrusted; quoted into the prompt) and author. */
  changeRequest: z.object({
    title: z.string().max(1000),
    description: z.string().max(100_000).nullable(),
    /** Code-host username; the only `@mention` posted findings may keep. */
    author: z.string().max(255).nullable(),
  }),
  reviewConfig: ReviewJobConfig,
  /**
   * How the review was requested: `incremental` (webhook; commits since the
   * last review), `full` (`@bot review`; the whole diff, open findings still
   * suppressed) or `fresh` (`@bot review fresh` / Re-run › Fresh; the whole
   * diff with nothing suppressed, and matching earlier open findings are
   * superseded when it completes). Absent on jobs from before re-runs.
   */
  mode: z.enum(REVIEW_MODES).optional(),
  /**
   * Earlier reviews of the PR, for incremental reviews and dedupe. `headSha`
   * is the last fully (`completed`) reviewed head; null when no review got
   * through the whole diff (e.g. only `budget_exhausted` ones), so the full
   * diff is reviewed but their open findings are still suppressed.
   */
  previousReview: z
    .object({
      headSha: CommitSha.nullable(),
      openFindings: z
        .array(
          z.object({
            path: z.string().min(1),
            startLine: z.int().min(1),
            endLine: z.int().min(1),
            category: FindingCategory,
          }),
        )
        .max(1000),
    })
    .nullable(),
});
export type ReviewJobPayload = z.infer<typeof ReviewJobPayload>;

export const REVIEW_SKIP_REASONS = [
  "excluded",
  "generated",
  "binary",
  "no_changes",
  "budget",
  "max_files",
] as const;

/** Most findings a review result may carry (the agent keeps the most severe). */
export const MAX_REVIEW_FINDINGS = 500;
/** Most skipped-file entries a review result may carry. */
export const MAX_REVIEW_SKIPPED = 10_000;

/**
 * Result of a `review.run` job (`/api/agent/jobs/{id}/result`). Reviews that
 * stopped on a rate limit or an error are reported through `/fail` instead.
 */
export const ReviewJobResult = z.object({
  findings: z.array(Finding).max(MAX_REVIEW_FINDINGS),
  usage: z.object({ inputTokens: z.int().min(0), outputTokens: z.int().min(0) }),
  skipped: z
    .array(z.object({ path: z.string().min(1), reason: z.enum(REVIEW_SKIP_REASONS) }))
    .max(MAX_REVIEW_SKIPPED),
  stopReason: z.enum(["completed", "budget_exhausted"]),
  scope: z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("full"),
      baseSha: CommitSha,
      headSha: CommitSha,
      fallbackFrom: CommitSha.optional(),
    }),
    z.object({ mode: z.literal("incremental"), fromSha: CommitSha, headSha: CommitSha }),
  ]),
  discarded: z.object({
    invalid: z.int().min(0),
    outsideDiff: z.int().min(0),
    duplicate: z.int().min(0),
  }),
  durationMs: z.int().min(0),
});
export type ReviewJobResult = z.infer<typeof ReviewJobResult>;
