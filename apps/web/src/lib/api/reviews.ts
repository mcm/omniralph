import { FEEDBACK_REASONS, ReviewDepthSchema } from "@omniralph/shared";
import { z } from "zod";
import {
  FINDING_SEVERITIES,
  REVIEW_STATUSES,
  REVIEW_TRIGGERS,
  type ReviewDetailView,
  type ReviewRow,
} from "@/lib/reviews/display";
import { isoDate } from "./schemas";

/** Wire formats of the review endpoints under `/api/ui`. */

const repositoryRef = z.object({
  id: z.string(),
  provider: z.enum(["github", "gitlab"]),
  fullPath: z.string(),
});
const agent = z.object({ id: z.string(), name: z.string() });
const reviewStatus = z.enum(REVIEW_STATUSES);
const findingCounts = z.object(
  Object.fromEntries(FINDING_SEVERITIES.map((s) => [s, z.number()])) as Record<
    (typeof FINDING_SEVERITIES)[number],
    z.ZodNumber
  >,
);

/** `ReviewRow` on the wire: a review on the Reviews list. */
export const reviewRowSchema = z.object({
  id: z.string(),
  repository: repositoryRef,
  prNumber: z.number(),
  prTitle: z.string().nullable(),
  prUrl: z.string(),
  trigger: z.enum(REVIEW_TRIGGERS),
  status: reviewStatus,
  depth: ReviewDepthSchema.nullable(),
  agent: agent.nullable(),
  findingCounts,
  tokensUsed: z.number(),
  budget: z.number(),
  durationMs: z.number().nullable(),
  error: z.string().nullable(),
  createdAt: isoDate,
}) satisfies z.ZodType<ReviewRow>;

/**
 * `GET /api/ui/reviews?status=&trigger=&page=&repository=`: a page of reviews, newest first;
 * with `repository`, that repository's (Repository › Reviews), which comes back too.
 */
export const reviewListSchema = z.object({
  reviews: z.array(reviewRowSchema),
  /** 1-based. */
  page: z.number(),
  pageSize: z.number(),
  /** Reviews matching the filters across all pages. */
  total: z.number(),
  /** The repository the list is of; null for every repository. */
  repository: repositoryRef
    .extend({
      /** The repository on the code host. */
      webUrl: z.string(),
      /** False once disconnected: its history stays browsable, its settings don't. */
      connected: z.boolean(),
    })
    .nullable(),
});
export type ReviewList = z.infer<typeof reviewListSchema>;

const findingSchema = z.object({
  id: z.string(),
  startLine: z.number(),
  endLine: z.number(),
  severity: z.enum(FINDING_SEVERITIES),
  category: z.string(),
  title: z.string(),
  body: z.string(),
  suggestion: z.string().nullable(),
  confidence: z.number(),
  status: z.enum(["open", "dismissed", "resolved", "superseded", "merged"]),
  supersededBy: z.object({ reviewId: z.string(), findingId: z.string() }).nullable(),
  feedback: z.array(
    z.object({
      id: z.string(),
      source: z.enum(["ui", "scm"]),
      reason: z.enum(FEEDBACK_REASONS),
      note: z.string().nullable(),
      actor: z.string(),
      createdAt: isoDate,
      restoredAt: isoDate.nullable(),
      restoredBy: z.string().nullable(),
    }),
  ),
});

/** `ReviewDetailView` on the wire: everything a review's page shows. */
export const reviewDetailViewSchema = z.object({
  id: z.string(),
  repository: repositoryRef,
  prNumber: z.number(),
  prTitle: z.string().nullable(),
  prUrl: z.string(),
  headSha: z.string(),
  baseSha: z.string(),
  trigger: z.enum(REVIEW_TRIGGERS),
  status: reviewStatus,
  depth: ReviewDepthSchema.nullable(),
  model: z.string().nullable(),
  agent: agent.nullable(),
  tokensIn: z.number(),
  tokensOut: z.number(),
  budget: z.number(),
  durationMs: z.number().nullable(),
  stopReason: z.string().nullable(),
  error: z.string().nullable(),
  skippedFiles: z.array(z.object({ path: z.string(), reason: z.string() })),
  files: z.array(z.object({ path: z.string(), findings: z.array(findingSchema) })),
  findingCount: z.number(),
  newerReview: z.object({ id: z.string(), status: reviewStatus, createdAt: isoDate }).nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
}) satisfies z.ZodType<ReviewDetailView>;

/** `GET /api/ui/reviews/{id}?next=`: a review of the active organization, polled by its page. */
export const reviewDetailSchema = z.object({ review: reviewDetailViewSchema });
export type ReviewDetail = z.infer<typeof reviewDetailSchema>;

/**
 * `POST /api/ui/reviews/{id}/rerun` (`RerunReviewInput`): the review to open. `active` is set
 * when nothing was enqueued because a review of the same head is already queued or running
 * (`reviewId` is that one, `message` says so).
 */
export const rerunResultSchema = z.object({
  ok: z.literal(true),
  reviewId: z.string(),
  active: z.boolean(),
  message: z.string().optional(),
});
export type RerunResult = z.infer<typeof rerunResultSchema>;
