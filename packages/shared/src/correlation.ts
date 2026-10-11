/**
 * Review run correlation: the trigger context a review run invokes its
 * correlation query task (`builtin:correlate-findings`, trigger
 * `run.invoked`) with, and the output the review run applies to its findings.
 */
import { z } from "zod";
import { FindingCategory, FindingSeverity } from "./finding.js";

/** Job type of a review run's correlation run. */
export const CORRELATION_JOB_TYPE = "review.correlate";

/** Longest combined summary a correlation may write. */
export const MAX_CORRELATION_SUMMARY_LENGTH = 20_000;

/** The run that invoked a `run.invoked` run, which its `run-result` sink hands the result to. */
export const RunInvoker = z.object({ kind: z.literal("review-run"), id: z.uuid() });
export type RunInvoker = z.infer<typeof RunInvoker>;

/** A stored finding of a review run's task, as the correlation sees it. */
export const CorrelationInputFinding = z.object({
  id: z.uuid(),
  path: z.string(),
  startLine: z.int(),
  endLine: z.int(),
  severity: FindingSeverity,
  category: z.string(),
  confidence: z.number(),
  title: z.string(),
  body: z.string(),
  suggestion: z.string().nullable(),
});
export type CorrelationInputFinding = z.infer<typeof CorrelationInputFinding>;

/**
 * The trigger context of a correlation run: the invoking review run, its PR,
 * and per review task that finished its name, summary and findings (null
 * without any), in the repository's task order.
 */
export const CorrelationTriggerContext = z.object({
  invoker: RunInvoker,
  repository: z.string(),
  pr: z.object({ number: z.int() }),
  reviewRun: z.object({
    tasks: z.object({
      items: z.array(
        z.object({
          taskId: z.string(),
          name: z.string(),
          summary: z.string().nullable(),
          findings: z.array(CorrelationInputFinding).nullable(),
        }),
      ),
    }),
  }),
});
export type CorrelationTriggerContext = z.infer<typeof CorrelationTriggerContext>;

/** One issue that several of the review run's findings describe. */
export const CorrelatedFinding = z.object({
  /** The stored findings it merges. */
  sourceFindingIds: z.array(z.string().min(1)).min(1),
  /** The review tasks that reported it. */
  sourceTaskIds: z.array(z.string().min(1)).min(1),
  path: z.string().min(1),
  startLine: z.int().min(1),
  endLine: z.int().min(1),
  severity: FindingSeverity,
  category: FindingCategory,
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(10_000),
  suggestion: z.string().max(10_000).nullable().optional(),
  confidence: z.number().min(0).max(1),
});
export type CorrelatedFinding = z.infer<typeof CorrelatedFinding>;

/** The structured output of a correlation run (`builtin:correlate-findings`'s fixed output schema). */
export const CorrelationOutput = z.object({
  findings: z.array(CorrelatedFinding),
  summary: z.string().max(MAX_CORRELATION_SUMMARY_LENGTH),
});
export type CorrelationOutput = z.infer<typeof CorrelationOutput>;
