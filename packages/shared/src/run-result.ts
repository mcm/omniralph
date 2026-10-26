/**
 * What an agent reports when a run finishes (`/api/agent/jobs/{id}/result`),
 * per task type. The control panel hands it to the task's sink.
 */
import { z } from "zod";
import { ChatAskFileReference } from "./chat-ask.js";

/** Longest answer a query run may report (sinks cap it further). */
export const MAX_QUERY_ANSWER_LENGTH = 64_000;
/** Most file references a query run may report. */
export const MAX_QUERY_REFERENCES = 20;

export const QUERY_RUN_OUTCOMES = [
  /** The session finished: `answer` (no output schema) or `structured` holds its output. */
  "answered",
  /** The session hit the run's token budget before it finished. */
  "budget_exhausted",
  /** The run needed a checkout (`requireCheckout`) and its ref couldn't be checked out. */
  "no_checkout",
] as const;
export type QueryRunOutcome = (typeof QUERY_RUN_OUTCOMES)[number];

/** Result of a `query` run. */
export const QueryRunResult = z
  .object({
    outcome: z.enum(QUERY_RUN_OUTCOMES),
    /** The final Markdown text, for a task without an output schema. */
    answer: z.string().trim().min(1).max(MAX_QUERY_ANSWER_LENGTH).nullable(),
    /** The output, validated against the task's output schema; null without one. */
    structured: z.unknown().nullable(),
    /** Files of the checkout the answer cites. */
    references: z.array(ChatAskFileReference).max(MAX_QUERY_REFERENCES),
    usage: z.object({ inputTokens: z.int().min(0), outputTokens: z.int().min(0) }),
    durationMs: z.int().min(0),
  })
  .refine(
    (r) =>
      r.outcome === "answered"
        ? (r.answer === null) !== (r.structured === null || r.structured === undefined)
        : r.answer === null && (r.structured === null || r.structured === undefined),
    {
      message: "an answered run has an answer or a structured result (not both); others neither",
      path: ["outcome"],
    },
  );
export type QueryRunResult = z.infer<typeof QueryRunResult>;
