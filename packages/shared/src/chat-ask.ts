/**
 * The `chat.ask` job: a question about a repository's code from a chat
 * thread, handed off by the control-panel agent. The agent answers it from a
 * checkout of the default branch with the review sandbox's read-only tools;
 * the control panel posts the answer in the thread (it never reads code).
 */
import { z } from "zod";
import { JobRepository } from "./protocol.js";
import { GitBranch } from "./ralph-job.js";
import { REVIEW_CAPABILITY } from "./review-job.js";

export const CHAT_ASK_JOB_TYPE = "chat.ask";
/** Runs on agents with the `review` capability, in the review sandbox. */
export const CHAT_ASK_CAPABILITY = REVIEW_CAPABILITY;
/** Longest question passed to the agent. */
export const MAX_CHAT_ASK_QUESTION_LENGTH = 4000;
/** Longest excerpt of the conversation passed along with the question. */
export const MAX_CHAT_ASK_CONTEXT_LENGTH = 8000;
/** Longest answer an agent may report. */
export const MAX_CHAT_ASK_ANSWER_LENGTH = 4000;
/** Most file references an answer may carry. */
export const MAX_CHAT_ASK_REFERENCES = 20;

export const ChatAskJobPayload = z.object({
  repositoryId: z.uuid(),
  repository: JobRepository,
  /** The branch the question is answered from (the repository's default branch). */
  defaultBranch: GitBranch,
  /** The question (untrusted; quoted into the prompt). */
  question: z.string().min(1).max(MAX_CHAT_ASK_QUESTION_LENGTH),
  /** An excerpt of the conversation that led to it (untrusted; quoted), or null. */
  context: z.string().max(MAX_CHAT_ASK_CONTEXT_LENGTH).nullable(),
  /** The chat thread (`chat_threads.id`) the answer is posted in. */
  chatThreadId: z.uuid(),
  /** The repository's profile model; null uses the Claude Code default. */
  model: z.string().min(1).max(200).nullable(),
  /** Token cap of the answer (input + output). */
  maxTokens: z.int().min(1),
});
export type ChatAskJobPayload = z.infer<typeof ChatAskJobPayload>;

/** A file (and optionally its lines) an answer points at, relative to the repository root. */
export const ChatAskFileReference = z
  .object({
    path: z.string().min(1).max(4096),
    startLine: z.int().min(1).optional(),
    endLine: z.int().min(1).optional(),
  })
  .refine(
    (r) => r.endLine === undefined || (r.startLine !== undefined && r.endLine >= r.startLine),
    {
      message: "endLine needs a startLine at or before it",
      path: ["endLine"],
    },
  );
export type ChatAskFileReference = z.infer<typeof ChatAskFileReference>;

export const CHAT_ASK_OUTCOMES = [
  /** `answer` holds the answer. */
  "answered",
  /** The answer hit the token cap before it was finished. */
  "budget_exhausted",
  /** The default branch doesn't exist (e.g. an empty repository). */
  "no_checkout",
] as const;

/** Result of a `chat.ask` job (`/api/agent/jobs/{id}/result`). */
export const ChatAskJobResult = z
  .object({
    answer: z.string().trim().min(1).max(MAX_CHAT_ASK_ANSWER_LENGTH).nullable(),
    outcome: z.enum(CHAT_ASK_OUTCOMES),
    /** Files of the checkout the answer cites. */
    references: z.array(ChatAskFileReference).max(MAX_CHAT_ASK_REFERENCES).optional(),
    usage: z.object({ inputTokens: z.int().min(0), outputTokens: z.int().min(0) }),
    durationMs: z.int().min(0),
  })
  .refine((r) => (r.outcome === "answered") === (r.answer !== null), {
    message: "answer is set exactly when outcome is 'answered'",
    path: ["answer"],
  });
export type ChatAskJobResult = z.infer<typeof ChatAskJobResult>;
