import "server-only";
import {
  getReview,
  getReviewRun,
  reviewRunSuperseded,
  writeStickyComment,
  type Database,
  type Job,
  type Review,
} from "@omniralph/db";
import {
  ChangeRequestNotFoundError,
  fencedBlock,
  type RepoRef,
  type ScmAdapter,
} from "@omniralph/scm";
import { ReviewTaskResult, type DocumentationUpdate } from "@omniralph/shared";
import {
  onReviewJobCanceled,
  onReviewJobFailed,
  onReviewJobRetry,
  onReviewJobStarted,
  loopIterationOf,
  reviewJobState,
  saveReviewResult,
  settleReviewRunOf,
} from "@/lib/review/jobs";
import { organizationPlaybooks } from "@/lib/playbooks";
import { repositoryTarget, reviewTaskNames, reviewUrl } from "@/lib/review/post";
import {
  inlineCode,
  MAX_BODY_CHARS,
  MAX_SUMMARY_CHARS,
  sanitizeCapped,
  type SanitizeContext,
} from "@/lib/review/sanitize";
import type { Sink } from "./index";

/**
 * The `sticky-comment` sink: applies a summary-only review task's run
 * (`builtin:summarize-pr`). The run's review is saved without findings (a
 * summary-only task posts none; any it returned are dropped and logged), its
 * summary goes to the PR/MR's one comment for the task, edited in place by
 * every later run (`postStickyComment`), and its review run settles as for
 * the `review` sink, which leaves it out of the correlation and the posted
 * review. Start, retry, failure and cancel are the `review` sink's.
 * A documentation check's iterations (`builtin:check-docs`) are left to its
 * loop (`lib/review/docs-loop.ts`), which saves the review once it ends and
 * then posts it here (`postStickyComment`).
 */
export const stickyCommentSink: Sink<never, ReviewTaskResult> = {
  kind: "sticky-comment",
  taskType: "review",
  outputSchema: null,
  parseResult(result) {
    const parsed = ReviewTaskResult.safeParse(result);
    return parsed.success ? parsed.data : null;
  },
  onStarted: onReviewJobStarted,
  async apply(db, job, result) {
    const state = reviewJobState(job);
    // A documentation check's iteration: its loop verifies and saves the review.
    if (loopIterationOf(state) !== null) return;
    if (result.findings.length > 0) {
      console.warn("dropping the findings of a summary-only review task", {
        jobId: job.id,
        taskId: job.taskId,
        reviewId: state.reviewId,
        findings: result.findings.length,
      });
    }
    await saveReviewResult(db, state, { ...result, findings: [], fixedOpenFindings: [] });
    await postStickyComment(db, job, state.reviewId);
    await settleReviewRunOf(db, state.reviewId);
  },
  onFailed: (db, job, error) => onReviewJobFailed(db, job, error ?? "Review failed"),
  onRetry: onReviewJobRetry,
  onCanceled: onReviewJobCanceled,
};

/**
 * Writes finished review `reviewId` to its task's sticky comment on the
 * PR/MR: the stored comment is edited in place (created when there is none
 * yet, or it was deleted), under a row lock on its `sticky_comments` row, so
 * a replay edits the same comment again. A summary-only task's comment is
 * its summary; a documentation check's (a review with
 * `documentationUpdates`) lists each file to update
 * (`documentationCommentBody`), and is posted only while the review's head
 * is still the PR/MR's current head. A review whose run was superseded by a
 * newer push is left alone. Returns whether it posted.
 */
export async function postStickyComment(
  db: Database,
  job: Pick<Job, "taskId" | "organizationId">,
  reviewId: string,
): Promise<boolean> {
  const review = await getReview(db, reviewId);
  if (!review || (review.status !== "completed" && review.status !== "budget_exhausted"))
    return false;
  const run = review.reviewRunId ? await getReviewRun(db, review.reviewRunId) : null;
  if (run && reviewRunSuperseded(run)) return false;
  const taskId = review.taskId ?? job.taskId;
  if (!taskId) return false;
  const { adapter, repo, sanitize } = await repositoryTarget(db, review, run?.prAuthor ?? null);
  const documentation = review.documentationUpdates;
  if (documentation !== null && !(await isCurrentHead(adapter, repo, review))) {
    console.info("not posting the documentation check of a head that is no longer current", {
      reviewId: review.id,
      prNumber: review.prNumber,
      headSha: review.headSha,
    });
    return false;
  }
  const taskName = await reviewTaskNames(organizationPlaybooks(db, job.organizationId), [taskId]);
  const content =
    documentation !== null
      ? documentationCommentBody(documentation, sanitize, {
          budgetExhausted: review.status === "budget_exhausted",
        })
      : review.summary
        ? sanitizeCapped(review.summary, sanitize, MAX_SUMMARY_CHARS)
        : "_No summary was written for this change._";
  const body = [
    `## ${taskName(taskId)}`,
    "",
    content,
    "",
    `_Updated for ${inlineCode(review.headSha.slice(0, 12))} · [View the run](${reviewUrl(review)})_`,
    "",
  ].join("\n");
  await writeStickyComment(
    db,
    { repositoryId: review.repositoryId, prNumber: review.prNumber, taskId },
    (commentId) => adapter.upsertComment(repo, review.prNumber, body, commentId),
  );
  return true;
}

/** Whether `review`'s head is the PR/MR's current head (false when it no longer exists). */
async function isCurrentHead(
  adapter: ScmAdapter,
  repo: RepoRef,
  review: Pick<Review, "prNumber" | "headSha">,
): Promise<boolean> {
  try {
    const state = await adapter.getChangeRequestState(repo, review.prNumber);
    return state.headSha === review.headSha;
  } catch (error) {
    if (error instanceof ChangeRequestNotFoundError) return false;
    throw error;
  }
}

/** The documentation comment's most characters before files are left out (GitHub caps a comment at 65,536). */
export const MAX_DOCUMENTATION_COMMENT_CHARS = 60_000;
/** A suggestion's most characters in the comment. */
const MAX_SUGGESTION_CHARS = 2_000;

export const NO_DOCUMENTATION_CHANGES = "No documentation changes needed for this change.";

/**
 * The documentation check's comment: one entry per file (its path, what is
 * wrong or missing, and the suggested text as a code block when there is
 * one), or that no documentation needs to change. Model-written text is
 * sanitized; files past `MAX_DOCUMENTATION_COMMENT_CHARS` are counted, not listed.
 */
export function documentationCommentBody(
  updates: readonly DocumentationUpdate[],
  sanitize: SanitizeContext,
  options: { budgetExhausted?: boolean } = {},
): string {
  const note = options.budgetExhausted
    ? "\n\n_The check reached its token cap, so it may have missed some documentation._"
    : "";
  if (updates.length === 0) return `${NO_DOCUMENTATION_CHANGES}${note}`;
  const count = updates.length;
  const lines = [
    `${count} documentation ${count === 1 ? "file needs" : "files need"} updating for this change:`,
  ];
  let length = lines[0]!.length + note.length;
  let listed = 0;
  for (const update of updates) {
    const entry = documentationEntry(update, sanitize);
    if (length + entry.length + 2 > MAX_DOCUMENTATION_COMMENT_CHARS) break;
    lines.push(entry);
    length += entry.length + 2;
    listed += 1;
  }
  if (listed < count) {
    const rest = count - listed;
    lines.push(`_…and ${rest} more ${rest === 1 ? "file" : "files"}: see the run._`);
  }
  return `${lines.join("\n\n")}${note}`;
}

/** One file's list entry: Markdown, its continuation lines indented under the item. */
function documentationEntry(update: DocumentationUpdate, sanitize: SanitizeContext): string {
  const reason = sanitizeCapped(update.reason.trim(), sanitize, MAX_BODY_CHARS);
  const parts = [`**${inlineCode(update.path)}**: ${reason}`];
  const suggestion = update.suggestion?.trim();
  if (suggestion) {
    const text =
      suggestion.length > MAX_SUGGESTION_CHARS
        ? `${suggestion.slice(0, MAX_SUGGESTION_CHARS - 1)}…`
        : suggestion;
    parts.push(`Suggested text:\n\n${fencedBlock("", text)}`);
  }
  return `- ${parts.join("\n\n").replace(/\n/g, "\n  ")}`.replace(/\n {2}\n/g, "\n\n");
}
