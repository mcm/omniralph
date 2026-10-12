import "server-only";
import {
  getFeedbackWithFinding,
  insertLearnedRule,
  type Database,
  type InsertLearnedRuleResult,
  type Job,
} from "@omniralph/db";
import { parseLearnedRuleOutput } from "@omniralph/engine/learn-rule";
import { findDuplicateRule } from "@omniralph/engine/rules";
import { MAX_QUERY_ANSWER_LENGTH, RunSpecJobPayload } from "@omniralph/shared";
import { z } from "zod";
import type { Sink, SinkResult } from "./index";

/** The structured output of `builtin:learn-rule` (its task's output schema). */
export const LearnedRuleOutput = z.strictObject({
  rule: z.string().max(MAX_QUERY_ANSWER_LENGTH).nullable(),
});
export type LearnedRuleOutput = z.infer<typeof LearnedRuleOutput>;

/** What the sink needs from the trigger context `enqueueLearnRule` stores. */
const LearnedRuleContext = z.object({
  feedbackId: z.uuid(),
  finding: z.object({ id: z.uuid() }),
});

export type LearnRuleOutcome =
  | InsertLearnedRuleResult
  /** No rule: the model answered null, its rule was rejected (too long), or the run ran out of budget. */
  | { status: "no_rule" }
  /** The finding was restored (or its feedback deleted) before the rule came back. */
  | { status: "feedback_withdrawn" };

/**
 * For a completed `builtin:learn-rule` run: stores its rule (whitespace
 * collapsed, at most `MAX_LEARNED_RULE_LENGTH` characters, as
 * `parseLearnedRuleOutput` accepts) as an enabled `learned` rule linked to
 * the source finding, unless the dismissal was withdrawn meanwhile or it
 * nearly duplicates (normalized similarity ≥ 0.9) one of the repository's
 * rules. Safe to call again for a replayed result: the stored rule then
 * counts as the duplicate.
 */
export async function applyLearnedRule(
  db: Database,
  job: Pick<Job, "id" | "payload" | "repositoryId">,
  result: SinkResult<LearnedRuleOutput>,
): Promise<LearnRuleOutcome> {
  if (result.outcome !== "answered" || result.structured === null) return { status: "no_rule" };
  const parsed = parseLearnedRuleOutput(JSON.stringify(result.structured));
  if (parsed.status !== "rule") {
    if (parsed.status === "rejected")
      console.info(`Learned rule of job ${job.id} rejected: ${parsed.error}`);
    return { status: "no_rule" };
  }
  const payload = RunSpecJobPayload.parse(job.payload);
  const context = LearnedRuleContext.parse(payload.trigger.context);
  const repositoryId = payload.repositoryId ?? job.repositoryId;
  if (!repositoryId) throw new Error(`Learn-rule job ${job.id} has no repository`);
  const current = await getFeedbackWithFinding(db, context.feedbackId);
  if (!current || current.feedback.restoredAt) return { status: "feedback_withdrawn" };
  return insertLearnedRule(db, {
    repositoryId,
    text: parsed.rule,
    sourceFindingId: context.finding.id,
    findDuplicate: (text, existing) => findDuplicateRule(text, existing),
  });
}

/** `learned-rule`: turns a rule generation into a repository rule (`applyLearnedRule`). */
export const learnedRuleSink: Sink<LearnedRuleOutput> = {
  kind: "learned-rule",
  taskType: "query",
  outputSchema: LearnedRuleOutput,
  apply: applyLearnedRule,
};
