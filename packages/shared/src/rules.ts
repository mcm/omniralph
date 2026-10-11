/**
 * Repository rules: admin-written `custom` rules and `learned` rules generated
 * from false-positive dismissals by the `builtin:learn-rule` query task. Enabled rules
 * are added to every review prompt of the repository.
 */
import { z } from "zod";

export const RULE_KINDS = ["custom", "learned"] as const;
export type RuleKindValue = (typeof RULE_KINDS)[number];

/** Longest rule an admin can write or edit. */
export const MAX_RULE_LENGTH = 1000;
/** Longest rule a rule generation (`builtin:learn-rule`) may produce; longer answers are rejected. */
export const MAX_LEARNED_RULE_LENGTH = 300;
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

/** Job type of a `builtin:learn-rule` run (and its dedupe key prefix): a "do not flag" rule from a false-positive dismissal. */
export const LEARN_RULE_JOB_TYPE = "review.learn-rule";
