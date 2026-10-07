import "server-only";
import {
  getFeedbackWithFinding,
  getRepositoryReviewSettings,
  getRepositoryWithConnection,
  insertLearnedRule,
  type Database,
  type Feedback,
  type FindingRow,
  type InsertLearnedRuleResult,
  type Job,
  type Review,
} from "@omniralph/db";
import { findDuplicateRule } from "@omniralph/engine/rules";
import {
  LEARN_RULE_CAPABILITY,
  LEARN_RULE_JOB_TYPE,
  LEARN_RULE_TOKEN_CAP,
  LearnRuleJobPayload,
  LearnRuleJobResult,
} from "@omniralph/shared";
import type { JobDispatcher } from "@/lib/dispatch";
import { jobRepository } from "@/lib/scm/adapters";

/**
 * Learned rules: a `false_positive` dismissal (from the control panel or
 * `@bot dismiss`) enqueues a `review.learn-rule` job; its result is deduped
 * against the repository's rules and stored as an enabled `learned` rule.
 */

export type EnqueueLearnRuleResult =
  | { status: "enqueued" | "duplicate"; jobId: string }
  | { status: "skipped"; reason: "not_false_positive" | "repository_unavailable" };

/** Enqueues rule generation for a false-positive dismissal (once per feedback row). */
export async function enqueueLearnRule(
  db: Database,
  dispatcher: JobDispatcher,
  input: { feedback: Feedback; finding: FindingRow; review: Review },
): Promise<EnqueueLearnRuleResult> {
  const { feedback, finding, review } = input;
  if (feedback.reason !== "false_positive") {
    return { status: "skipped", reason: "not_false_positive" };
  }
  const found = await getRepositoryWithConnection(db, review.repositoryId);
  const settings = found && (await getRepositoryReviewSettings(db, review.repositoryId));
  if (!found || !settings || found.repository.disconnectedAt) {
    return { status: "skipped", reason: "repository_unavailable" };
  }
  const payload = LearnRuleJobPayload.parse({
    feedbackId: feedback.id,
    findingId: finding.id,
    repositoryId: review.repositoryId,
    repository: jobRepository(found.repository, found.connection),
    baseSha: review.baseSha,
    headSha: review.headSha,
    model: settings.profile.model,
    maxTokens: LEARN_RULE_TOKEN_CAP,
    finding: {
      path: finding.path,
      startLine: finding.startLine,
      endLine: finding.endLine,
      severity: finding.severity,
      category: finding.category,
      title: finding.title.slice(0, 200),
      body: finding.body.slice(0, 10_000),
    },
    note: feedback.note?.slice(0, 1000) ?? null,
  } satisfies LearnRuleJobPayload);
  const { job, created } = await dispatcher.createAndPublish({
    organizationId: found.repository.organizationId,
    capability: LEARN_RULE_CAPABILITY,
    type: LEARN_RULE_JOB_TYPE,
    payload,
    repositoryId: review.repositoryId,
    dedupeKey: `${LEARN_RULE_JOB_TYPE}:${feedback.id}`,
  });
  return { status: created ? "enqueued" : "duplicate", jobId: job.id };
}

/** Validates a rule generation's result before the job is completed. */
export function parseLearnRuleResult(result: unknown): LearnRuleJobResult | null {
  const parsed = LearnRuleJobResult.safeParse(result);
  return parsed.success ? parsed.data : null;
}

export type LearnRuleOutcome =
  | InsertLearnedRuleResult
  | { status: "no_rule" }
  /** The finding was restored (or its feedback deleted) before the rule came back. */
  | { status: "feedback_withdrawn" };

/**
 * For a `completed` rule generation: stores its rule as an enabled `learned`
 * rule linked to the source finding, unless it nearly duplicates (normalized
 * similarity ≥ 0.9) one of the repository's rules. Safe to call again for a
 * replayed result: the stored rule then counts as the duplicate.
 */
export async function onLearnRuleJobCompleted(db: Database, job: Job): Promise<LearnRuleOutcome> {
  const payload = LearnRuleJobPayload.parse(job.payload);
  const result = LearnRuleJobResult.parse(job.result);
  if (result.rule === null) return { status: "no_rule" };
  const current = await getFeedbackWithFinding(db, payload.feedbackId);
  if (!current || current.feedback.restoredAt) return { status: "feedback_withdrawn" };
  return insertLearnedRule(db, {
    repositoryId: payload.repositoryId,
    text: result.rule,
    sourceFindingId: payload.findingId,
    findDuplicate: (text, existing) => findDuplicateRule(text, existing),
  });
}
