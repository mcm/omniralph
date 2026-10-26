/**
 * Code questions from chat: a question about a repository's code, handed off
 * by the control-panel agent as a run of the built-in query task
 * `builtin:ask-about-code` (job type `chat.ask`). An agent answers it from a
 * checkout of the default branch with read-only tools; the control panel
 * posts the answer in the thread (it never reads code).
 */
import { z } from "zod";

export const CHAT_ASK_JOB_TYPE = "chat.ask";
/** Longest question passed to the agent. */
export const MAX_CHAT_ASK_QUESTION_LENGTH = 4000;
/** Longest excerpt of the conversation passed along with the question. */
export const MAX_CHAT_ASK_CONTEXT_LENGTH = 8000;

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
