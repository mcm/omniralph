import "server-only";
import {
  getRepositoryReviewSettings,
  getRepositoryWithConnection,
  type Database,
  type Feedback,
  type FindingRow,
  type Review,
} from "@omniralph/db";
import { LEARN_RULE_JOB_TYPE } from "@omniralph/shared";
import { getBuiltinTask } from "@omniralph/tasks";
import type { JobDispatcher } from "@/lib/dispatch";
import { runSpecJobInput } from "@/lib/runs/job";

/**
 * Learned rules: a `false_positive` dismissal (from the control panel or
 * `@bot dismiss`) enqueues a run of the built-in query task
 * `builtin:learn-rule`; its `learned-rule` sink (`lib/sinks/learned-rule.ts`)
 * dedupes the result against the repository's rules and stores it as an
 * enabled `learned` rule.
 */

export const LEARN_RULE_TASK_ID = "builtin:learn-rule";

export type EnqueueLearnRuleResult =
  | { status: "enqueued" | "duplicate"; jobId: string }
  | { status: "skipped"; reason: "not_false_positive" | "repository_unavailable" };

/**
 * The `finding.dismissed` trigger context of a rule generation: the finding
 * (raw `path`, lines and the review's base/head commits, from which the
 * harness computes its diff hunk; the JSON-quoted `file` and `location` the
 * prompt shows), the dismissal note, the repository, and the feedback row the
 * sink re-checks before storing the rule.
 */
export function learnRuleContext(input: {
  feedback: Feedback;
  finding: FindingRow;
  review: Pick<Review, "baseSha" | "headSha">;
  repository: string;
}): Record<string, unknown> {
  const { feedback, finding, review } = input;
  return {
    feedbackId: feedback.id,
    repository: input.repository,
    finding: {
      id: finding.id,
      path: finding.path,
      file: JSON.stringify(finding.path),
      startLine: finding.startLine,
      endLine: finding.endLine,
      location:
        finding.startLine === finding.endLine
          ? `line ${finding.startLine}`
          : `lines ${finding.startLine}-${finding.endLine}`,
      severity: finding.severity,
      category: finding.category,
      title: finding.title.slice(0, 200),
      body: finding.body.slice(0, 10_000),
      baseSha: review.baseSha,
      headSha: review.headSha,
    },
    dismissal: { note: feedback.note?.slice(0, 1000).trim() ?? "" },
  };
}

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
  const task = getBuiltinTask(LEARN_RULE_TASK_ID);
  if (!task) throw new Error(`Built-in task ${LEARN_RULE_TASK_ID} is missing`);
  const context = learnRuleContext({
    feedback,
    finding,
    review,
    repository: found.repository.fullPath,
  });
  const { job, created } = await dispatcher.createAndPublish({
    organizationId: found.repository.organizationId,
    type: LEARN_RULE_JOB_TYPE,
    ...runSpecJobInput(task, {
      trigger: { kind: "finding.dismissed", context },
      repositoryId: review.repositoryId,
    }),
    dedupeKey: `${LEARN_RULE_JOB_TYPE}:${feedback.id}`,
  });
  return { status: created ? "enqueued" : "duplicate", jobId: job.id };
}
