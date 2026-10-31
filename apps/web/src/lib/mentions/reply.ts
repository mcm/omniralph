import "server-only";
import {
  getRepositoryWithConnection,
  type Database,
  type FindingRow,
  type Review,
} from "@omniralph/db";
import { MAX_REPLY_QUESTION_LENGTH, REVIEW_REPLY_JOB_TYPE } from "@omniralph/shared";
import type { JobDispatcher } from "@/lib/dispatch";
import { getPlaybookTask, organizationPlaybooks, taskJobInput } from "@/lib/playbooks";
import { runTokenBudget } from "@/lib/runs/resolve";
import type { FindingThreadContext } from "@/lib/sinks/finding-thread";

/**
 * Thread replies: a question asked by mentioning the bot in a finding's
 * thread enqueues a run of the built-in query task `builtin:reply-to-finding`
 * (read-only, with the task's fixed token budget); its `finding-thread`
 * sink (`lib/sinks/finding-thread.ts`) posts the answer in the thread.
 */

export const REPLY_TASK_ID = "builtin:reply-to-finding";

export type EnqueueReplyResult =
  | { status: "enqueued" | "duplicate"; jobId: string }
  | { status: "repository_unavailable" }
  /** The repository's query tasks are turned off: nothing was enqueued. */
  | { status: "query_disabled" }
  /** The finding has no inline thread to answer in. */
  | { status: "no_thread" };

/**
 * The `finding.mention` trigger context of a thread reply: the finding (raw
 * `path`, lines and the review's base/head commits, from which the agent
 * computes its diff hunk; the JSON-quoted `file` and `location` the prompt
 * shows), the question, and what the sink needs to answer in the thread.
 */
export function replyContext(input: {
  finding: FindingRow;
  review: Pick<Review, "id" | "reviewRunId" | "prNumber" | "baseSha" | "headSha">;
  repository: string;
  question: string;
  askedBy: string;
  threadCommentId: string;
  budgetTokens: number | null;
}): Record<string, unknown> & FindingThreadContext {
  const { finding, review } = input;
  const context = {
    repository: input.repository,
    pr: { number: review.prNumber },
    review: { id: review.id, reviewRunId: review.reviewRunId },
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
    question: input.question.slice(0, MAX_REPLY_QUESTION_LENGTH).trim(),
    askedBy: input.askedBy.slice(0, 255),
    threadCommentId: input.threadCommentId,
    budgetTokens: input.budgetTokens,
  };
  return context;
}

export async function enqueueReply(
  db: Database,
  dispatcher: JobDispatcher,
  input: {
    finding: FindingRow;
    review: Review;
    question: string;
    askedBy: string;
    /** The asking comment's ID, so a redelivered webhook doesn't ask twice. */
    commentId: string;
  },
): Promise<EnqueueReplyResult> {
  const { finding, review } = input;
  if (!finding.scmCommentId) return { status: "no_thread" };
  const found = await getRepositoryWithConnection(db, review.repositoryId);
  if (!found || found.repository.disconnectedAt || !found.repository.reviewsEnabled) {
    return { status: "repository_unavailable" };
  }
  if (!found.repository.askEnabled) return { status: "query_disabled" };
  const definitions = organizationPlaybooks(db, found.repository.organizationId);
  const task = await getPlaybookTask(definitions, REPLY_TASK_ID);
  if (!task) throw new Error(`Built-in task ${REPLY_TASK_ID} is missing`);
  const context = replyContext({
    finding,
    review,
    repository: found.repository.fullPath,
    question: input.question,
    askedBy: input.askedBy,
    threadCommentId: finding.scmCommentId,
    budgetTokens: runTokenBudget(task),
  });
  const { job, created } = await dispatcher.createAndPublish({
    organizationId: found.repository.organizationId,
    type: REVIEW_REPLY_JOB_TYPE,
    ...(await taskJobInput(definitions, task, {
      trigger: { kind: "finding.mention", context },
      repositoryId: review.repositoryId,
      // The review's head; when it can't be fetched the session runs without the checkout.
      ref: review.headSha,
    })),
    dedupeKey: `${REVIEW_REPLY_JOB_TYPE}:${review.repositoryId}:${input.commentId}`,
  });
  return { status: created ? "enqueued" : "duplicate", jobId: job.id };
}
