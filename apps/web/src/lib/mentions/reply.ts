import "server-only";
import {
  getRepositoryReviewSettings,
  getRepositoryWithConnection,
  postJobCommentOnce,
  type Database,
  type FindingRow,
  type Job,
  type Review,
} from "@omniralph/db";
import {
  MAX_REPLY_QUESTION_LENGTH,
  REVIEW_REPLY_CAPABILITY,
  REVIEW_REPLY_JOB_TYPE,
  replyTokenCap,
  ReviewReplyJobPayload,
  ReviewReplyJobResult,
} from "@omniralph/shared";
import type { JobDispatcher } from "@/lib/dispatch";
import { reviewUrl } from "@/lib/review/post";
import { sanitizeCapped, MAX_BODY_CHARS, type SanitizeContext } from "@/lib/review/sanitize";
import { repositoryWebUrl } from "@/lib/repositories/web-url";
import { jobRepository, scmAdapterFor } from "@/lib/scm/adapters";

/**
 * Thread replies: a question asked by mentioning the bot in a finding's
 * thread becomes a `review.reply` job (read-only, capped at 10% of the
 * profile budget); the control panel posts the agent's answer in the thread.
 */

export type EnqueueReplyResult =
  | { status: "enqueued" | "duplicate"; jobId: string }
  | { status: "repository_unavailable" }
  /** The finding has no inline thread to answer in. */
  | { status: "no_thread" };

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
  const settings = found && (await getRepositoryReviewSettings(db, review.repositoryId));
  if (!found || !settings || !found.repository.enabled || found.repository.disconnectedAt) {
    return { status: "repository_unavailable" };
  }
  const { profile } = settings;
  const payload = ReviewReplyJobPayload.parse({
    findingId: finding.id,
    reviewId: review.id,
    repositoryId: review.repositoryId,
    repository: jobRepository(found.repository, found.connection),
    prNumber: review.prNumber,
    baseSha: review.baseSha,
    headSha: review.headSha,
    model: profile.model,
    maxTokens: replyTokenCap(profile.maxTokensPerReview),
    finding: {
      path: finding.path,
      startLine: finding.startLine,
      endLine: finding.endLine,
      severity: finding.severity,
      category: finding.category,
      title: finding.title.slice(0, 200),
      body: finding.body.slice(0, 10_000),
    },
    question: input.question.slice(0, MAX_REPLY_QUESTION_LENGTH),
    askedBy: input.askedBy.slice(0, 255),
    threadCommentId: finding.scmCommentId,
  } satisfies ReviewReplyJobPayload);
  const { job, created } = await dispatcher.createAndPublish({
    capability: REVIEW_REPLY_CAPABILITY,
    type: REVIEW_REPLY_JOB_TYPE,
    payload,
    repositoryId: review.repositoryId,
    dedupeKey: `${REVIEW_REPLY_JOB_TYPE}:${review.repositoryId}:${input.commentId}`,
  });
  return { status: created ? "enqueued" : "duplicate", jobId: job.id };
}

/** Whether a job is a thread reply created by `enqueueReply`. */
export function isReplyJob(job: Pick<Job, "capability" | "type" | "payload">): boolean {
  return (
    job.capability === REVIEW_REPLY_CAPABILITY &&
    job.type === REVIEW_REPLY_JOB_TYPE &&
    ReviewReplyJobPayload.safeParse(job.payload).success
  );
}

/** Validates a thread reply's result before the job is completed. */
export function parseReplyResult(result: unknown): ReviewReplyJobResult | null {
  const parsed = ReviewReplyJobResult.safeParse(result);
  return parsed.success ? parsed.data : null;
}

/** Posts `body` (sanitized) in the finding's thread, at most once per job. */
async function postInThread(
  db: Database,
  job: Job,
  render: (payload: ReviewReplyJobPayload, ctx: SanitizeContext) => string,
): Promise<boolean> {
  const payload = ReviewReplyJobPayload.parse(job.payload);
  const { posted } = await postJobCommentOnce(db, job.id, async () => {
    const found = await getRepositoryWithConnection(db, payload.repositoryId);
    if (!found) return null;
    const { repository, connection } = found;
    const webUrl = repositoryWebUrl(repository.provider, connection.baseUrl, repository.fullPath);
    const ctx: SanitizeContext = {
      allowedHosts: [new URL(webUrl).hostname],
      author: payload.askedBy,
    };
    const { id } = await scmAdapterFor(db, connection).replyToComment(
      { fullPath: repository.fullPath, externalId: repository.externalId },
      payload.prNumber,
      payload.threadCommentId,
      render(payload, ctx),
    );
    return id;
  });
  return posted;
}

/** Our own text (not model output): the asker and a link to the finding in the control panel. */
function footer(payload: ReviewReplyJobPayload): string {
  const link = `${reviewUrl(payload.reviewId)}#finding-${payload.findingId}`;
  return `_Omniralph · answering @${payload.askedBy} · [View the finding](${link})_`;
}

/**
 * For a `completed` thread reply: posts the answer (through the output
 * sanitizer) in the finding's thread, or a note that the token cap was hit.
 * Safe to call again for a replayed result: it posts at most once.
 */
export async function onReplyJobCompleted(db: Database, job: Job): Promise<boolean> {
  const result = ReviewReplyJobResult.parse(job.result);
  return postInThread(db, job, (payload, ctx) => {
    const text =
      result.answer !== null
        ? result.answer
        : `Sorry, I couldn't finish an answer within this repository's reply budget (${payload.maxTokens.toLocaleString("en-US")} tokens).`;
    return `${sanitizeCapped(text, ctx, MAX_BODY_CHARS)}\n\n${footer(payload)}`;
  });
}

/** A thread reply that failed for good: a short apology in the thread (once). */
export async function onReplyJobFailed(db: Database, job: Job): Promise<boolean> {
  return postInThread(db, job, (payload, ctx) =>
    sanitizeCapped(
      `Sorry, I couldn't answer this question; the job failed. Ask again later, @${payload.askedBy}.`,
      ctx,
      MAX_BODY_CHARS,
    ),
  );
}
