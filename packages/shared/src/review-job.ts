/**
 * Review task runs (`review.task` jobs): the trigger context the control
 * panel resolves when it enqueues a review run, and the result an agent
 * reports to `/result`.
 */
import { z } from "zod";
import { DocumentationCheckContext, DocumentationUpdateList } from "./documentation-check.js";
import { Finding, FindingCategory, FindingSeverity } from "./finding.js";
import { RunSpecJobPayload } from "./run-spec.js";
import { TokenUsage } from "./usage.js";

/** Job type of a review task's run (one per task of a review run). */
export const REVIEW_TASK_JOB_TYPE = "review.task";

export const CommitSha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

/**
 * The model and limits a review runs with: its depth's preset
 * (`reviewProfileConfigForDepth`), with the depth as `id` and its label as `name`.
 */
export const ReviewProfileConfig = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  /** Null uses the Claude Code default model. */
  model: z.string().min(1).max(200).nullable(),
  maxTokensPerReview: z.int().min(1),
  maxFiles: z.int().min(1),
  allowRepoExploration: z.boolean(),
});
export type ReviewProfileConfig = z.infer<typeof ReviewProfileConfig>;

export const ReviewRule = z.object({
  kind: z.enum(["custom", "learned"]),
  text: z.string().max(4000),
  enabled: z.boolean(),
});
export type ReviewRule = z.infer<typeof ReviewRule>;

/** A repository's review configuration, resolved at enqueue time. */
export const ReviewJobConfig = z.object({
  profile: ReviewProfileConfig,
  customInstructions: z.string().max(20_000).nullable(),
  rules: z.array(ReviewRule).max(500),
  pathExcludes: z.array(z.string().min(1).max(500)).max(500),
});
export type ReviewJobConfig = z.infer<typeof ReviewJobConfig>;

/** Longest open-finding body a review payload carries. */
export const MAX_OPEN_FINDING_BODY_CHARS = 1000;

/** See `ReviewTriggerContext.mode`. */
export const REVIEW_MODES = ["incremental", "full", "fresh"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

/**
 * The check types a looped review can run (`planChecks` in the engine plans
 * the ones that apply to a change), in the order they are planned.
 */
export const REVIEW_CHECK_TYPES = [
  "security",
  "stability",
  "performance",
  "compatibility",
  "maintainability",
] as const;
export const ReviewCheckType = z.enum(REVIEW_CHECK_TYPES);
export type ReviewCheckType = z.infer<typeof ReviewCheckType>;

/**
 * The check types a looped review fans out to: every one `planChecks` plans
 * by default (maintainability only runs when enabled, and nothing enables it
 * yet).
 */
export const LOOPED_REVIEW_CHECK_TYPES = [
  "security",
  "stability",
  "performance",
  "compatibility",
] as const satisfies readonly ReviewCheckType[];

/** Most confirmed findings of earlier passes a pass is given. */
export const MAX_PASS_CONFIRMED_FINDINGS = 100;
/** Most unreached areas a pass is given. */
export const MAX_PASS_UNREACHED_AREAS = 50;

/**
 * One pass of a looped review's check type: which check type and pass it is,
 * the findings earlier passes of the check type confirmed (not to be
 * reported again) and the areas their verifier said they didn't reach (what
 * this pass covers). The first pass has neither.
 */
export const ReviewPassContext = z.object({
  checkType: ReviewCheckType,
  number: z.int().min(1),
  confirmed: z
    .array(
      z.object({
        path: z.string().min(1),
        startLine: z.int().min(1),
        endLine: z.int().min(1),
        severity: FindingSeverity,
        category: FindingCategory,
        title: z.string().max(200),
      }),
    )
    .max(MAX_PASS_CONFIRMED_FINDINGS),
  unreached: z
    .array(
      z.object({
        path: z.string().min(1),
        startLine: z.int().min(1).nullable(),
        endLine: z.int().min(1).nullable(),
        reason: z.string().max(2_000),
      }),
    )
    .max(MAX_PASS_UNREACHED_AREAS),
});
export type ReviewPassContext = z.infer<typeof ReviewPassContext>;

/**
 * One pass of a looped review's check type, as the review records it once
 * the pass's verifier settled it (`reviews.passes`).
 */
export interface ReviewPassRecord {
  /** 1 for the first pass. */
  number: number;
  /** The files the pass reviewed. */
  files: string[];
  /** Findings the pass reported. */
  reported: number;
  /** Findings the verifier confirmed (all of `reported` when the pass wasn't verified). */
  confirmed: number;
  /** Confirmed findings no earlier pass had confirmed. */
  new: number;
  /** Findings the verifier rejected or didn't answer: never posted. */
  dropped: number;
  /** `verified`; `unverified` when the verifier failed and the findings were kept as reported. */
  verification: "verified" | "unverified";
  /** Areas of the change the verifier said the pass didn't reach. */
  unreached: number;
  /** The verifier's summary; null without one. */
  summary: string | null;
}

/**
 * The trigger context `enqueueReview` stores for a run of a `review` task
 * (`builtin:review-pr`): the review row, the commits, the PR text, the review
 * configuration, the mode and the earlier reviews, with `repository` as the
 * template's `owner/repo`, plus `pr`, the PR as the prompt template quotes it
 * (title and description trimmed; a blank description is null). It carries
 * everything the run needs except credentials: git gets a short-lived
 * read-only token from the broker.
 */
export const ReviewTriggerContext = z.object({
  reviewId: z.uuid(),
  repositoryId: z.uuid(),
  repository: z.string().min(1).max(500),
  /** PR number (GitHub) or MR IID (GitLab). */
  prNumber: z.int().min(1),
  baseSha: CommitSha,
  headSha: CommitSha,
  /** PR/MR title and description (untrusted; quoted into the prompt) and author. */
  changeRequest: z.object({
    title: z.string().max(1000),
    description: z.string().max(100_000).nullable(),
    /** Code-host username; the only `@mention` posted findings may keep. */
    author: z.string().max(255).nullable(),
  }),
  reviewConfig: ReviewJobConfig,
  /**
   * How the review was requested: `incremental` (webhook; commits since the
   * last review), `full` (`@bot review`; the whole diff, open findings still
   * suppressed) or `fresh` (`@bot review fresh` / Re-run › Fresh; the whole
   * diff with nothing suppressed, and matching earlier open findings are
   * superseded when it completes). Absent: `incremental`.
   */
  mode: z.enum(REVIEW_MODES).optional(),
  /**
   * Earlier reviews of the PR, for incremental reviews, dedupe and re-checking
   * the open findings (see `ReviewJobResult.fixedOpenFindings`). `headSha`
   * is the last fully (`completed`) reviewed head; null when no review got
   * through the whole diff (e.g. only `budget_exhausted` ones), so the full
   * diff is reviewed but their open findings are still suppressed.
   */
  previousReview: z
    .object({
      headSha: CommitSha.nullable(),
      openFindings: z
        .array(
          z.object({
            /** The finding's row ID; absent on jobs from before re-checks. */
            id: z.uuid().optional(),
            path: z.string().min(1),
            startLine: z.int().min(1),
            endLine: z.int().min(1),
            category: FindingCategory,
            /** Title and (truncated) body, so the review can re-check the finding. */
            title: z.string().max(200).optional(),
            body: z.string().max(MAX_OPEN_FINDING_BODY_CHARS).optional(),
          }),
        )
        .max(1000),
    })
    .nullable(),
  pr: z.object({
    number: z.int().min(1),
    title: z.string().max(1000),
    body: z.string().max(100_000).nullable(),
  }),
  /**
   * Set for one pass of a looped review's check type: the run plans the
   * change's check types (`planChecks`) and reviews only this check type's
   * files (narrowed to the unreached areas after the first pass) with its
   * rubric sections. Absent: a single-pass review of the whole change.
   */
  pass: ReviewPassContext.optional(),
  /**
   * Set for a documentation check (`builtin:check-docs`): its depth, the kinds
   * of documentation in its scope and what earlier iterations settled. The
   * run spec takes its model and token cap from the depth.
   */
  documentation: DocumentationCheckContext.optional(),
});
export type ReviewTriggerContext = z.infer<typeof ReviewTriggerContext>;

export const REVIEW_SKIP_REASONS = [
  "excluded",
  "generated",
  "binary",
  "no_changes",
  "budget",
  "max_files",
] as const;

/** Most findings a review result may carry (the agent keeps the most severe). */
export const MAX_REVIEW_FINDINGS = 500;
/** Most skipped-file entries a review result may carry. */
export const MAX_REVIEW_SKIPPED = 10_000;

/**
 * Result of a review task's run (`/api/agent/jobs/{id}/result`). Reviews that
 * stopped on a rate limit or an error are reported through `/fail` instead.
 */
export const ReviewJobResult = z.object({
  findings: z.array(Finding).max(MAX_REVIEW_FINDINGS),
  usage: TokenUsage,
  skipped: z
    .array(z.object({ path: z.string().min(1), reason: z.enum(REVIEW_SKIP_REASONS) }))
    .max(MAX_REVIEW_SKIPPED),
  stopReason: z.enum(["completed", "budget_exhausted"]),
  scope: z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("full"),
      baseSha: CommitSha,
      headSha: CommitSha,
      fallbackFrom: CommitSha.optional(),
    }),
    z.object({ mode: z.literal("incremental"), fromSha: CommitSha, headSha: CommitSha }),
  ]),
  discarded: z.object({
    invalid: z.int().min(0),
    outsideDiff: z.int().min(0),
    duplicate: z.int().min(0),
  }),
  /**
   * Indexes into the trigger context's `previousReview.openFindings` of the open
   * findings the review re-checked and found fixed at the head; they get
   * resolved. Absent from agents that predate it: then nothing is resolved.
   */
  fixedOpenFindings: z.array(z.int().min(0)).max(1000).optional(),
  durationMs: z.int().min(0),
  /**
   * A looped review pass's plan: its check type and the files it reviewed
   * (none when the change has no file for the check type, so nothing was
   * reviewed). Absent for a single-pass review.
   */
  pass: z
    .object({
      checkType: ReviewCheckType,
      files: z.array(z.string().min(1)).max(MAX_REVIEW_SKIPPED),
    })
    .optional(),
});
export type ReviewJobResult = z.infer<typeof ReviewJobResult>;

/**
 * What a run of a `review` task reads from its trigger context, besides the
 * values its prompt template renders: the commits to review, the PR text,
 * the repository's review configuration and the earlier reviews (as in
 * `ReviewTriggerContext`).
 */
export const ReviewTaskContext = ReviewTriggerContext.pick({
  baseSha: true,
  headSha: true,
  changeRequest: true,
  reviewConfig: true,
  previousReview: true,
  pass: true,
  documentation: true,
});
export type ReviewTaskContext = z.infer<typeof ReviewTaskContext>;

/** The `ReviewTriggerContext` of a review task's stored job payload (a `RunSpecJobPayload`); throws if it has none. */
export function reviewTriggerContext(payload: unknown): ReviewTriggerContext {
  return ReviewTriggerContext.parse(RunSpecJobPayload.parse(payload).trigger.context);
}

/** Longest `summary` a review task's result carries. */
export const MAX_REVIEW_SUMMARY_LENGTH = 20_000;

/**
 * Result of a `review` task run: a `ReviewJobResult` plus the session's
 * optional `summary` and, from a documentation check, its
 * `documentationUpdates` (one per file; absent from every other review run).
 */
export const ReviewTaskResult = ReviewJobResult.extend({
  summary: z.string().min(1).max(MAX_REVIEW_SUMMARY_LENGTH).optional(),
  documentationUpdates: DocumentationUpdateList.optional(),
});
export type ReviewTaskResult = z.infer<typeof ReviewTaskResult>;
