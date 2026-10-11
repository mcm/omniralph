/**
 * The `review.reply` job: a question asked by mentioning the bot in a
 * finding's thread. The agent answers it from the finding, its diff hunk and
 * the head checkout (read-only tools, like a review); the control panel posts
 * the answer in the thread.
 */
import { z } from "zod";
import { JobRepository } from "./protocol.js";
import { CommitSha } from "./review-job.js";

export const REVIEW_REPLY_JOB_TYPE = "review.reply";
/** Share of the profile's `maxTokensPerReview` one answer may use. */
export const REPLY_BUDGET_FRACTION = 0.1;
/** Longest question passed to the agent; longer ones are truncated. */
export const MAX_REPLY_QUESTION_LENGTH = 4000;
/** Longest answer an agent may report. */
export const MAX_REPLY_ANSWER_LENGTH = 4000;

/** Token cap of an answer: 10% of the profile budget (at least 1). */
export function replyTokenCap(maxTokensPerReview: number): number {
  return Math.max(1, Math.floor(maxTokensPerReview * REPLY_BUDGET_FRACTION));
}

export const ReviewReplyJobPayload = z.object({
  findingId: z.uuid(),
  /** The review that raised the finding. */
  reviewId: z.uuid(),
  repositoryId: z.uuid(),
  repository: JobRepository,
  /** PR number (GitHub) or MR IID (GitLab). */
  prNumber: z.int().min(1),
  /** Base and head of the review that raised the finding. */
  baseSha: CommitSha,
  headSha: CommitSha,
  /** The repository's profile model; null uses the Claude Code default. */
  model: z.string().min(1).max(200).nullable(),
  /** Token cap of the answer (input + output). */
  maxTokens: z.int().min(1),
  finding: z.object({
    path: z.string().min(1).max(4096),
    startLine: z.int().min(1),
    endLine: z.int().min(1),
    severity: z.string().max(32),
    category: z.string().max(64),
    title: z.string().max(200),
    body: z.string().max(10_000),
  }),
  /** The question (untrusted; quoted into the prompt). */
  question: z.string().min(1).max(MAX_REPLY_QUESTION_LENGTH),
  /** Code-host login of whoever asked. */
  askedBy: z.string().min(1).max(255),
  /** The finding's SCM comment (thread) the answer is posted in. */
  threadCommentId: z.string().min(1).max(255),
});
export type ReviewReplyJobPayload = z.infer<typeof ReviewReplyJobPayload>;

export const REVIEW_REPLY_OUTCOMES = [
  /** `answer` holds the reply. */
  "answered",
  /** The answer hit the token cap before it was finished. */
  "budget_exhausted",
] as const;

/** Result of a `review.reply` job (`/api/harness/jobs/{id}/result`). */
export const ReviewReplyJobResult = z
  .object({
    answer: z.string().trim().min(1).max(MAX_REPLY_ANSWER_LENGTH).nullable(),
    outcome: z.enum(REVIEW_REPLY_OUTCOMES),
    usage: z.object({ inputTokens: z.int().min(0), outputTokens: z.int().min(0) }),
    durationMs: z.int().min(0),
  })
  .refine((r) => (r.outcome === "answered") === (r.answer !== null), {
    message: "answer is set exactly when outcome is 'answered'",
    path: ["answer"],
  });
export type ReviewReplyJobResult = z.infer<typeof ReviewReplyJobResult>;
