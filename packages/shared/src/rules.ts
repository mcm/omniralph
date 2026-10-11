/**
 * Repository rules: admin-written `custom` rules and `learned` rules generated
 * from false-positive dismissals by a `review.learn-rule` job. Enabled rules
 * are added to every review prompt of the repository.
 */
import { z } from "zod";
import { JobRepository } from "./protocol.js";
import { CommitSha } from "./review-job.js";

export const RULE_KINDS = ["custom", "learned"] as const;
export type RuleKindValue = (typeof RULE_KINDS)[number];

/** Longest rule an admin can write or edit. */
export const MAX_RULE_LENGTH = 1000;
/** Longest rule a `review.learn-rule` job may produce; longer answers are rejected. */
export const MAX_LEARNED_RULE_LENGTH = 300;
/** Token cap (input + output) of one rule generation. */
export const LEARN_RULE_TOKEN_CAP = 5000;
/** Normalized similarity at or above which a learned rule duplicates an existing one. */
export const RULE_DUPLICATE_SIMILARITY = 0.9;

/** Add/edit form of Repository › Rules. */
export const RuleInput = z.object({
  text: z
    .string()
    .trim()
    .min(1, "Enter the rule.")
    .max(MAX_RULE_LENGTH, `Rules can be at most ${MAX_RULE_LENGTH} characters.`),
});
export type RuleInput = z.infer<typeof RuleInput>;

/** Generates a "do not flag" rule from a false-positive dismissal (a `query` task). */
export const LEARN_RULE_JOB_TYPE = "review.learn-rule";

/**
 * Payload of a `review.learn-rule` job. The agent computes the finding's diff
 * hunk from the review's base and head (git through the read-only broker),
 * then asks Claude, with no tools, for one generalized rule.
 */
export const LearnRuleJobPayload = z.object({
  feedbackId: z.uuid(),
  findingId: z.uuid(),
  repositoryId: z.uuid(),
  repository: JobRepository,
  baseSha: CommitSha,
  headSha: CommitSha,
  /** The repository's profile model; null uses the Claude Code default. */
  model: z.string().min(1).max(200).nullable(),
  /** Token cap of the generation (input + output). */
  maxTokens: z.int().min(1).max(LEARN_RULE_TOKEN_CAP),
  finding: z.object({
    path: z.string().min(1).max(4096),
    startLine: z.int().min(1),
    endLine: z.int().min(1),
    severity: z.string().max(32),
    category: z.string().max(64),
    title: z.string().max(200),
    body: z.string().max(10_000),
  }),
  /** The dismissal note (user-written), if any. */
  note: z.string().max(1000).nullable(),
});
export type LearnRuleJobPayload = z.infer<typeof LearnRuleJobPayload>;

export const LEARN_RULE_OUTCOMES = [
  /** A rule was produced. */
  "rule",
  /** The model found nothing generalizable (`null`). */
  "none",
  /** The answer was unusable (not the expected JSON, or a rule over the length limit). */
  "rejected",
  /** Generation stopped at the token cap. */
  "budget_exhausted",
] as const;

/** Result of a `review.learn-rule` job (`/api/harness/jobs/{id}/result`). */
export const LearnRuleJobResult = z
  .object({
    rule: z.string().trim().min(1).max(MAX_LEARNED_RULE_LENGTH).nullable(),
    outcome: z.enum(LEARN_RULE_OUTCOMES),
    /** Why the answer was rejected. */
    error: z.string().max(500).optional(),
    usage: z.object({ inputTokens: z.int().min(0), outputTokens: z.int().min(0) }),
    durationMs: z.int().min(0),
  })
  .refine((r) => (r.outcome === "rule") === (r.rule !== null), {
    message: "rule is set exactly when outcome is 'rule'",
    path: ["rule"],
  });
export type LearnRuleJobResult = z.infer<typeof LearnRuleJobResult>;
